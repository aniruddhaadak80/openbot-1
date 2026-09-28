import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { D1AuthRepository } from "../src/server/d1-auth-repository";
import { HostedServerService } from "../src/server/hosted-server-service";
import { RemoteControlPlane } from "../src/server/remote-control-plane";
import { sqliteD1 } from "./sqlite-d1";

const owner = { id: "owner", email: "owner@example.test", name: null, avatarUrl: null };
const member = { id: "member", email: "member@example.test", name: null, avatarUrl: null };
const stranger = { id: "stranger", email: "stranger@example.test", name: null, avatarUrl: null };
const WEBHOOK_SECRET = "whsec_test";
const MINUTE = 60_000;

interface BoatCall {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

async function setup() {
  const database = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  for (const user of [owner, member, stranger]) {
    database
      .prepare("INSERT INTO users(id, identity_key, email, created_at, updated_at) VALUES (?, ?, ?, 1, 1)")
      .run(user.id, `email:${user.email}`, user.email);
  }
  const clock = { now: Date.UTC(2026, 8, 1, 12) };
  const calls: BoatCall[] = [];
  const claims: string[] = [];
  const boatFetch = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const call = {
      method: init.method ?? "GET",
      path: url.pathname.replace("/api/v1", ""),
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    if (isDynamicRecord(call.body) && isDynamicRecord(call.body.env) && isString(call.body.env.OPENBOT_HOSTED_CLAIM)) {
      claims.push(call.body.env.OPENBOT_HOSTED_CLAIM);
    }
    if (call.method === "POST" && call.path === "/sandboxes") {
      return Response.json({ ok: true, status: "provisioning", sandbox: { id: "bx_1", state: "provisioning" } });
    }
    return Response.json({ ok: true, id: "bx_1", status: "ok" });
  };
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", use: "sig", alg: "ES256" };
  const bindings = {
    DB: sqliteD1(database),
    REMOTE_TICKET_PRIVATE_JWK: JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid: "test-key", alg: "ES256" }),
    REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    REMOTE_TICKET_KEY_ID: "test-key",
    HOSTED_SERVERS_ENABLED: "true",
    HOSTED_SERVERS_ALLOWED_USER_IDS: "owner, member",
    HOSTED_SERVER_TEMPLATE: "openbot-server-test",
    BOAT_API_KEY: "boat-key",
    BOAT_WEBHOOK_SECRET: WEBHOOK_SECRET,
  };
  const remote = new RemoteControlPlane(bindings, { now: () => clock.now, fetch: async () => new Response(null) });
  const service = new HostedServerService(bindings, {
    fetch: boatFetch,
    now: () => clock.now,
    removeHost: (ownerUserId, hostId) => remote.deleteHost(ownerUserId, hostId),
  });
  let delivery = 0;
  const webhook = (type: string, state: string | null, options: { createdAt?: number; timestamp?: number } = {}) => {
    delivery += 1;
    const body = JSON.stringify({
      id: `evt_${delivery}`,
      type,
      createdAt: new Date(options.createdAt ?? clock.now).toISOString(),
      data: { sandbox: { id: "bx_1", name: "server" }, ...(state ? { state } : {}) },
    });
    const timestamp = String(Math.floor((options.timestamp ?? clock.now) / 1_000));
    const deliveryId = `evt_${delivery}`;
    const signature = `v1=${createHmac("sha256", WEBHOOK_SECRET).update(`${deliveryId}.${timestamp}.${body}`).digest("hex")}`;
    return { deliveryId, timestamp, signature, body };
  };
  const state = (serverId: string) =>
    database
      .prepare("SELECT desired_state, observed_state, last_wake_reason FROM hosted_servers WHERE server_id = ?")
      .get(serverId);
  return { database, clock, calls, claims, remote, service, webhook, state };
}

async function createRunningServer(context: Awaited<ReturnType<typeof setup>>) {
  const server = await context.service.create(owner, { name: "Cloud one", size: undefined }, "create-key-0000001");
  await context.service.handleWebhook(context.webhook("sandbox.ready", "ready"));
  await context.remote.registerHost(owner, {
    hostId: server.serverId,
    name: "Cloud one",
    ownerMembershipId: `${server.serverId}:owner`,
  });
  return server;
}

describe("hosted servers", () => {
  it("creates a server only for an allowed account and gives the VM a single-use claim", async () => {
    const context = await setup();
    try {
      await expect(context.service.list(stranger)).resolves.toEqual({ available: false, servers: [] });
      await expect(
        context.service.create(stranger, { name: "Mine", size: "small" }, "create-key-0000001"),
      ).rejects.toMatchObject({ status: 403, code: "hosting_unavailable" });

      const server = await context.service.create(
        owner,
        { name: " Cloud one ", size: undefined },
        "create-key-0000001",
      );
      expect(server).toMatchObject({ name: "Cloud one", size: "small", state: "starting", error: null });
      const again = await context.service.create(owner, { name: "Cloud one", size: "small" }, "create-key-0000001");
      expect(again.serverId).toBe(server.serverId);
      const creates = context.calls.filter((call) => call.path === "/sandboxes");
      expect(creates).toHaveLength(1);
      const [create] = creates;
      expect(create?.headers.get("Idempotency-Key")).toBe(server.serverId);
      expect(create?.headers.get("Authorization")).toBe("Bearer boat-key");
      expect(create?.body).toMatchObject({
        type: "small",
        from: "openbot-server-test",
        noEnv: true,
        ttlSeconds: null,
        env: { OPENBOT_HOSTED_HOST_ID: server.serverId },
      });
      const [claim = ""] = context.claims;
      expect(JSON.stringify(context.database.prepare("SELECT * FROM hosted_servers").all())).not.toContain(claim);

      const redeemed = await context.service.redeemClaim(claim);
      expect(redeemed).toMatchObject({ hostId: server.serverId, name: "Cloud one", user: { id: "owner" } });
      await expect(
        new D1AuthRepository(sqliteD1(context.database)).authenticate(redeemed.sessionToken, context.clock.now),
      ).resolves.toMatchObject({ id: "owner" });
      await expect(context.service.redeemClaim(claim)).rejects.toMatchObject({ code: "hosted_claim_invalid" });

      await context.service.create(owner, { name: "Cloud two", size: "default" }, "create-key-0000002");
      const secondClaim = context.claims.at(-1) ?? "";
      context.clock.now += 61 * MINUTE;
      await expect(context.service.redeemClaim(secondClaim)).rejects.toMatchObject({ code: "hosted_claim_invalid" });
    } finally {
      context.database.close();
    }
  });

  it("reserves the host ID for its owner and removes the host on deletion", async () => {
    const context = await setup();
    try {
      const server = await context.service.create(owner, { name: "Cloud one", size: "small" }, "create-key-0000001");
      const [claim = ""] = context.claims;
      const session = await context.service.redeemClaim(claim);
      const hostInput = { hostId: server.serverId, name: "Cloud one", ownerMembershipId: `${server.serverId}:owner` };
      await expect(context.remote.registerHost(stranger, hostInput)).rejects.toMatchObject({
        code: "host_owner_mismatch",
      });
      await context.remote.registerHost(owner, hostInput);

      await expect(context.service.delete(stranger, server.serverId, "Cloud one")).rejects.toMatchObject({
        status: 404,
      });
      await expect(context.service.delete(owner, server.serverId, "Cloud")).rejects.toMatchObject({
        code: "hosted_server_confirm_mismatch",
      });
      await context.service.delete(owner, server.serverId, "Cloud one");
      const deletion = context.calls.find((call) => call.method === "DELETE");
      expect(deletion?.path).toBe("/sandboxes/bx_1");
      expect(deletion?.headers.get("X-Ascii-Confirm-Delete")).toBe("bx_1");
      expect(context.database.prepare("SELECT host_id FROM remote_hosts").all()).toEqual([]);
      await expect(
        new D1AuthRepository(sqliteD1(context.database)).authenticate(session.sessionToken, context.clock.now),
      ).resolves.toBeNull();
      await expect(context.remote.registerHost(owner, hostInput)).rejects.toMatchObject({
        code: "host_owner_mismatch",
      });
      await expect(context.service.list(owner)).resolves.toMatchObject({ servers: [] });
    } finally {
      context.database.close();
    }
  });

  it("checks webhook signatures, applies each delivery once, and ignores older events", async () => {
    const context = await setup();
    try {
      const server = await context.service.create(owner, { name: "Cloud one", size: "small" }, "create-key-0000001");
      const forged = context.webhook("sandbox.ready", "ready");
      await expect(
        context.service.handleWebhook({ ...forged, signature: `v1=${"0".repeat(64)}` }),
      ).rejects.toMatchObject({ status: 401 });
      const stale = context.webhook("sandbox.ready", "ready", { timestamp: context.clock.now - 6 * MINUTE });
      await expect(context.service.handleWebhook(stale)).rejects.toMatchObject({ status: 401 });
      expect(context.state(server.serverId)).toMatchObject({ observed_state: "starting" });

      const ready = context.webhook("sandbox.ready", "ready");
      await context.service.handleWebhook(ready);
      expect(context.state(server.serverId)).toMatchObject({ observed_state: "running" });
      const olderError = context.webhook("sandbox.error", null, { createdAt: context.clock.now - MINUTE });
      await context.service.handleWebhook(olderError);
      expect(context.state(server.serverId)).toMatchObject({ observed_state: "running" });

      context.clock.now += MINUTE;
      const error = context.webhook("sandbox.error", null);
      await context.service.handleWebhook(error);
      expect(context.state(server.serverId)).toMatchObject({ observed_state: "error" });
      context.clock.now += MINUTE;
      await context.service.handleWebhook(context.webhook("sandbox.ready", "ready"));
      // The same delivery again changes nothing.
      await context.service.handleWebhook(error);
      expect(context.state(server.serverId)).toMatchObject({ observed_state: "running" });
    } finally {
      context.database.close();
    }
  });

  it("starts a server again when the provider stops it, and lets a member start a failed one", async () => {
    const context = await setup();
    try {
      const server = await createRunningServer(context);
      context.database
        .prepare(
          `INSERT INTO remote_memberships(membership_id, host_id, user_id, role, status, created_at, updated_at)
           VALUES ('member-1', ?, 'member', 'member', 'active', 1, 1)`,
        )
        .run(server.serverId);
      const resumes = () => context.calls.filter((call) => call.path === "/sandboxes/bx_1/resume").length;

      context.clock.now += MINUTE;
      await context.service.handleWebhook(context.webhook("sandbox.ready", "archiving"));
      await expect(context.service.wake(stranger, server.serverId)).rejects.toMatchObject({ status: 404 });
      await expect(context.service.wake(member, server.serverId)).resolves.toMatchObject({ state: "stopping" });
      expect(resumes()).toBe(0);

      context.clock.now += MINUTE;
      await context.service.handleWebhook(context.webhook("sandbox.archived", "archived"));
      expect(resumes()).toBe(1);
      expect(context.state(server.serverId)).toMatchObject({
        desired_state: "running",
        observed_state: "waking",
        last_wake_reason: "restart",
      });

      context.clock.now += MINUTE;
      await context.service.handleWebhook(context.webhook("sandbox.error", null));
      await expect(context.service.wake(member, server.serverId)).resolves.toMatchObject({ state: "waking" });
      expect(resumes()).toBe(2);
      expect(context.state(server.serverId)).toMatchObject({ last_wake_reason: "message" });
    } finally {
      context.database.close();
    }
  });
});
