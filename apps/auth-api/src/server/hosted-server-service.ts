import {
  DEFAULT_HOSTED_SERVER_SIZE,
  HOSTED_SERVER_NAME_MAX_LENGTH,
  type HostedServerClaim,
  type HostedServerError,
  type HostedServerList,
  type HostedServerSize,
  type HostedServerState,
  type HostedServerSummary,
  isHostedServerSize,
} from "@openbot/contracts/hosted-servers";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  BoatApiError,
  BoatClient,
  type BoatFetch,
  type BoatSandboxState,
  isBoatState,
  verifyBoatWebhookSignature,
} from "./boat-client";
import { randomToken, sha256 } from "./crypto";
import { PERSISTENT_SESSION_EXPIRES_AT } from "./session-policy";
import type { AuthUser, WorkerBindings } from "./types";

const CLAIM_TTL_MS = 60 * 60_000;
/** The cron asks the provider about a server that has been in a transition state this long. */
const STUCK_AFTER_MS = 2 * 60_000;
/** boat retries a delivery for hours, so a delivery ID is kept longer than the 5 minute replay window. */
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_SERVERS_PER_ACCOUNT = 3;
const TICK_BATCH_SIZE = 20;

export type HostedServerBindings = Pick<
  WorkerBindings,
  | "DB"
  | "HOSTED_SERVERS_ENABLED"
  | "HOSTED_SERVERS_ALLOWED_USER_IDS"
  | "HOSTED_SERVER_TEMPLATE"
  | "BOAT_API_KEY"
  | "BOAT_WEBHOOK_SECRET"
>;

export class HostedServerServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A server runs all the time. It never stops for being idle. */
type DesiredState = "running" | "deleted";
type WakeReason = "create" | "message" | "restart";

interface HostedServerRow {
  server_id: string;
  owner_user_id: string;
  name: string;
  provider_sandbox_id: string | null;
  size: HostedServerSize;
  desired_state: DesiredState;
  observed_state: HostedServerState;
  observed_error: HostedServerError | null;
  provider_event_at: number | null;
  auth_session_id: string | null;
  created_at: number;
  updated_at: number;
}

const ROW_COLUMNS = `server_id, owner_user_id, name, provider_sandbox_id, size, desired_state, observed_state,
  observed_error, provider_event_at, auth_session_id, created_at, updated_at`;

export interface HostedServerServiceOptions {
  fetch?: BoatFetch;
  now?: () => number;
  /** Removes the Remote host of a deleted server. It is null when Remote is not configured. */
  removeHost?: ((ownerUserId: string, hostId: string) => Promise<void>) | null;
}

export interface HostedServerTickResult {
  restarted: number;
  reconciled: number;
  deleted: number;
  failed: number;
}

export class HostedServerService {
  readonly #database: D1Database;
  readonly #boat: BoatClient | null;
  readonly #template: string | null;
  readonly #webhookSecret: string | null;
  readonly #enabled: boolean;
  readonly #allowedUserIds: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #removeHost: ((ownerUserId: string, hostId: string) => Promise<void>) | null;

  constructor(bindings: HostedServerBindings, options: HostedServerServiceOptions = {}) {
    this.#database = bindings.DB;
    const apiKey = bindings.BOAT_API_KEY?.trim() || null;
    this.#boat = apiKey ? new BoatClient({ apiKey, fetch: options.fetch }) : null;
    this.#template = bindings.HOSTED_SERVER_TEMPLATE?.trim() || null;
    this.#webhookSecret = bindings.BOAT_WEBHOOK_SECRET?.trim() || null;
    this.#enabled = bindings.HOSTED_SERVERS_ENABLED === "true" && this.#boat !== null && this.#template !== null;
    this.#allowedUserIds = new Set(
      (bindings.HOSTED_SERVERS_ALLOWED_USER_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    this.#now = options.now ?? Date.now;
    this.#removeHost = options.removeHost ?? null;
  }

  isAvailableFor(userId: string): boolean {
    return this.#enabled && this.#allowedUserIds.has(userId);
  }

  async list(user: AuthUser): Promise<HostedServerList> {
    const rows = await this.#database
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM hosted_servers
         WHERE owner_user_id = ? AND desired_state != 'deleted' ORDER BY created_at`,
      )
      .bind(user.id)
      .all<HostedServerRow>();
    return { available: this.isAvailableFor(user.id), servers: rows.results.map(summary) };
  }

  async create(
    user: AuthUser,
    input: { name: unknown; size: unknown },
    idempotencyKeyHeader: string | null,
  ): Promise<HostedServerSummary> {
    const { boat, template } = this.#requireAvailable(user.id);
    const idempotencyKey = idempotencyKeyHeader?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(idempotencyKey)) {
      throw new HostedServerServiceError(400, "invalid_idempotency_key", "A valid Idempotency-Key header is required.");
    }
    const name = serverName(input.name);
    const size = input.size === undefined ? DEFAULT_HOSTED_SERVER_SIZE : input.size;
    if (!isHostedServerSize(size)) throw invalid("size");
    const previous = await this.#database
      .prepare(`SELECT ${ROW_COLUMNS} FROM hosted_servers WHERE owner_user_id = ? AND idempotency_key = ?`)
      .bind(user.id, idempotencyKey)
      .first<HostedServerRow>();
    if (previous) return summary(previous);
    const count = await this.#database
      .prepare("SELECT COUNT(*) AS count FROM hosted_servers WHERE owner_user_id = ? AND desired_state != 'deleted'")
      .bind(user.id)
      .first<{ count: number }>();
    if ((count?.count ?? 0) >= MAX_SERVERS_PER_ACCOUNT) {
      throw new HostedServerServiceError(409, "hosted_server_limit", "This account has the maximum number of servers.");
    }
    const serverId = crypto.randomUUID();
    const claim = randomToken();
    const now = this.#now();
    const inserted = await this.#database
      .prepare(
        `INSERT INTO hosted_servers(
           server_id, owner_user_id, name, size, desired_state, observed_state, last_wake_reason,
           claim_token_hash, claim_expires_at, idempotency_key, provider_event_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'running', 'creating', 'create', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_user_id, idempotency_key) DO NOTHING`,
      )
      .bind(serverId, user.id, name, size, await sha256(claim), now + CLAIM_TTL_MS, idempotencyKey, now, now, now)
      .run();
    if (inserted.meta.changes !== 1) {
      const concurrent = await this.#database
        .prepare(`SELECT ${ROW_COLUMNS} FROM hosted_servers WHERE owner_user_id = ? AND idempotency_key = ?`)
        .bind(user.id, idempotencyKey)
        .first<HostedServerRow>();
      if (!concurrent) throw new HostedServerServiceError(409, "hosted_server_conflict", "Try the request again.");
      return summary(concurrent);
    }
    const request = {
      type: size,
      from: template,
      // The claim is the only secret that the VM gets. It is single use and expires.
      env: { OPENBOT_HOSTED_CLAIM: claim, OPENBOT_HOSTED_HOST_ID: serverId },
      idempotencyKey: serverId,
    };
    try {
      // The same idempotency key and claim make one retry safe after a network failure.
      const sandbox = await boat.createSandbox(request).catch((error: unknown) => {
        if (error instanceof BoatApiError && error.code === "network_error") return boat.createSandbox(request);
        throw error;
      });
      await this.#database
        .prepare(
          `UPDATE hosted_servers SET provider_sandbox_id = ?, observed_state = ?, updated_at = ?
           WHERE server_id = ? AND observed_state = 'creating'`,
        )
        .bind(sandbox.id, isUsable(sandbox.state) ? "running" : "starting", this.#now(), serverId)
        .run();
    } catch (error) {
      await this.#database
        .prepare(
          `UPDATE hosted_servers SET observed_state = 'error', observed_error = ?, claim_token_hash = NULL, updated_at = ?
           WHERE server_id = ?`,
        )
        .bind(providerError(error), this.#now(), serverId)
        .run();
    }
    return summary(await this.#requireRow(serverId));
  }

  async delete(user: AuthUser, serverId: string, confirmName: unknown): Promise<void> {
    const row = await this.#database
      .prepare(`SELECT ${ROW_COLUMNS} FROM hosted_servers WHERE server_id = ? AND owner_user_id = ?`)
      .bind(serverId, user.id)
      .first<HostedServerRow>();
    if (!row || row.observed_state === "deleted") throw notFound();
    if (confirmName !== row.name) {
      throw new HostedServerServiceError(400, "hosted_server_confirm_mismatch", "Type the server name to delete it.");
    }
    // From here the webhook and the wake paths ignore the row, and the cron finishes a failed deletion.
    await this.#database
      .prepare("UPDATE hosted_servers SET desired_state = 'deleted', updated_at = ? WHERE server_id = ?")
      .bind(this.#now(), serverId)
      .run();
    await this.#finishDelete({ ...row, desired_state: "deleted" });
  }

  async wake(user: AuthUser, serverId: string): Promise<HostedServerSummary> {
    const row = await this.#database
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM hosted_servers h
         WHERE h.server_id = ? AND h.desired_state != 'deleted' AND (h.owner_user_id = ? OR EXISTS(
           SELECT 1 FROM remote_memberships m WHERE m.host_id = h.server_id AND m.user_id = ? AND m.status = 'active'
         ))`,
      )
      .bind(serverId, user.id, user.id)
      .first<HostedServerRow>();
    if (!row) throw notFound();
    await this.#wake(row, "message");
    return summary(await this.#requireRow(serverId));
  }

  async redeemClaim(claim: unknown): Promise<HostedServerClaim> {
    if (!isString(claim) || claim.length < 16 || claim.length > 128) throw invalidClaim();
    const claimHash = await sha256(claim);
    const now = this.#now();
    const row = await this.#database
      .prepare(
        `SELECT server_id, name, owner_user_id FROM hosted_servers
         WHERE claim_token_hash = ? AND claim_redeemed_at IS NULL AND claim_expires_at > ? AND desired_state != 'deleted'`,
      )
      .bind(claimHash, now)
      .first<{ server_id: string; name: string; owner_user_id: string }>();
    if (!row) throw invalidClaim();
    const sessionId = crypto.randomUUID();
    const sessionToken = randomToken();
    const [redeemed] = await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE hosted_servers SET claim_token_hash = NULL, claim_redeemed_at = ?, auth_session_id = ?, updated_at = ?
           WHERE server_id = ? AND claim_token_hash = ? AND claim_redeemed_at IS NULL`,
        )
        .bind(now, sessionId, now, row.server_id, claimHash),
      this.#database
        .prepare(
          `INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at)
           SELECT ?, owner_user_id, ?, ?, ?, ? FROM hosted_servers
           WHERE server_id = ? AND auth_session_id = ? AND claim_redeemed_at = ?`,
        )
        .bind(
          sessionId,
          await sha256(sessionToken),
          PERSISTENT_SESSION_EXPIRES_AT,
          now,
          now,
          row.server_id,
          sessionId,
          now,
        ),
    ]);
    if (redeemed?.meta.changes !== 1) throw invalidClaim();
    const user = await this.#database
      .prepare("SELECT id, email, name, avatar_url FROM users WHERE id = ?")
      .bind(row.owner_user_id)
      .first<{ id: string; email: string; name: string | null; avatar_url: string | null }>();
    if (!user) throw invalidClaim();
    return {
      hostId: row.server_id,
      name: row.name,
      sessionToken,
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url },
    };
  }

  async handleWebhook(input: { deliveryId: string; timestamp: string; signature: string; body: string }) {
    if (!this.#webhookSecret) {
      throw new HostedServerServiceError(503, "hosting_not_configured", "Hosted servers are not configured.");
    }
    const now = this.#now();
    const valid =
      /^[A-Za-z0-9_-]{1,128}$/u.test(input.deliveryId) &&
      (await verifyBoatWebhookSignature({ ...input, secret: this.#webhookSecret, now }));
    if (!valid) throw new HostedServerServiceError(401, "webhook_signature_invalid", "The signature is invalid.");
    const seen = await this.#database
      .prepare("SELECT 1 AS seen FROM hosting_webhook_deliveries WHERE delivery_id = ?")
      .bind(input.deliveryId)
      .first<{ seen: number }>();
    if (seen) return;
    const event = parseWebhookEvent(input.body, now);
    if (event) {
      const row = await this.#database
        .prepare(`SELECT ${ROW_COLUMNS} FROM hosted_servers WHERE provider_sandbox_id = ?`)
        .bind(event.sandboxId)
        .first<HostedServerRow>();
      if (row) await this.#observe(row, event.state, event.createdAt);
    }
    // Recorded after the change, so a delivery that failed half way is applied again on retry.
    await this.#database
      .prepare("INSERT INTO hosting_webhook_deliveries(delivery_id, received_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .bind(input.deliveryId, now)
      .run();
  }

  async tick(now = this.#now()): Promise<HostedServerTickResult> {
    const result: HostedServerTickResult = { restarted: 0, reconciled: 0, deleted: 0, failed: 0 };
    await this.#database
      .prepare(
        `UPDATE hosted_servers SET claim_token_hash = NULL
         WHERE claim_token_hash IS NOT NULL AND claim_expires_at <= ?`,
      )
      .bind(now)
      .run();
    await this.#database
      .prepare("DELETE FROM hosting_webhook_deliveries WHERE received_at < ?")
      .bind(now - DELIVERY_RETENTION_MS)
      .run();
    const boat = this.#boat;
    if (!boat) return result;
    const run = async (rows: HostedServerRow[], action: (row: HostedServerRow) => Promise<void>) => {
      let done = 0;
      for (const row of rows) {
        try {
          await action(row);
          done += 1;
        } catch (error) {
          result.failed += 1;
          console.warn("Hosted server task failed.", { serverId: row.server_id, error: safeErrorCode(error) });
        }
      }
      return done;
    };
    // The webhook starts a stopped server at once. This catches a start that did not happen.
    const stopped = await this.#database
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM hosted_servers
         WHERE desired_state = 'running' AND observed_state = 'stopped' AND updated_at <= ? LIMIT ?`,
      )
      .bind(now - STUCK_AFTER_MS, TICK_BATCH_SIZE)
      .all<HostedServerRow>();
    result.restarted = await run(stopped.results, (row) => this.#wake(row, "restart"));
    const stuck = await this.#database
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM hosted_servers
         WHERE desired_state != 'deleted' AND provider_sandbox_id IS NOT NULL
           AND observed_state IN ('starting', 'stopping', 'waking') AND updated_at <= ? LIMIT ?`,
      )
      .bind(now - STUCK_AFTER_MS, TICK_BATCH_SIZE)
      .all<HostedServerRow>();
    result.reconciled = await run(stuck.results, async (row) => {
      const sandboxId = row.provider_sandbox_id;
      if (!sandboxId) return;
      const state = await boat.getSandbox(sandboxId).then(
        (sandbox) => sandbox.state,
        (error: unknown) => {
          if (error instanceof BoatApiError && error.status === 404) return "cancelled" as const;
          throw error;
        },
      );
      await this.#observe(row, state, now);
    });
    const deleting = await this.#database
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM hosted_servers
         WHERE desired_state = 'deleted' AND observed_state != 'deleted' LIMIT ?`,
      )
      .bind(TICK_BATCH_SIZE)
      .all<HostedServerRow>();
    result.deleted = await run(deleting.results, (row) => this.#finishDelete(row));
    return result;
  }

  async #wake(row: HostedServerRow, reason: WakeReason): Promise<void> {
    const now = this.#now();
    // A stopping server starts again when the provider reports that it stopped.
    if (row.observed_state !== "stopped" && !(row.observed_state === "error" && row.provider_sandbox_id)) return;
    const waking = await this.#database
      .prepare(
        `UPDATE hosted_servers SET observed_state = 'waking', observed_error = NULL,
           last_wake_reason = ?, provider_event_at = ?, updated_at = ?
         WHERE server_id = ? AND observed_state = ? AND desired_state = 'running'`,
      )
      .bind(reason, now, now, row.server_id, row.observed_state)
      .run();
    if (waking.meta.changes === 1) await this.#resume(row);
  }

  async #resume(row: HostedServerRow): Promise<void> {
    const boat = this.#boat;
    if (!boat || !row.provider_sandbox_id) return;
    try {
      await boat.resumeSandbox(row.provider_sandbox_id);
    } catch (error) {
      // 409: the provider already resumes or runs it; the webhook or the cron reports the result.
      if (error instanceof BoatApiError && error.status === 409) return;
      await this.#database
        .prepare(
          `UPDATE hosted_servers SET observed_state = 'error', observed_error = ?, updated_at = ?
           WHERE server_id = ? AND observed_state = 'waking'`,
        )
        .bind(providerError(error), this.#now(), row.server_id)
        .run();
      throw error;
    }
  }

  async #observe(row: HostedServerRow, state: BoatSandboxState, eventAt: number): Promise<void> {
    if (row.desired_state === "deleted") return;
    if (row.provider_event_at !== null && eventAt < row.provider_event_at) return;
    let observed = row.observed_state;
    let error = row.observed_error;
    if (isUsable(state)) {
      observed = "running";
      error = null;
    } else if (state === "archiving") {
      observed = "stopping";
    } else if (state === "archived") {
      observed = "stopped";
    } else if (state === "error" || state === "cancelled") {
      observed = "error";
      error = "provider_error";
    } else if (row.observed_state === "creating") {
      observed = "starting";
    }
    const updated = await this.#database
      .prepare(
        `UPDATE hosted_servers SET observed_state = ?, observed_error = ?, provider_event_at = ?, updated_at = ?
         WHERE server_id = ? AND desired_state != 'deleted' AND (provider_event_at IS NULL OR provider_event_at <= ?)`,
      )
      .bind(observed, error, eventAt, this.#now(), row.server_id, eventAt)
      .run();
    if (updated.meta.changes !== 1 || observed !== "stopped") return;
    // Only the provider stops a server, for example for maintenance. It must run, so it starts again.
    await this.#wake(await this.#requireRow(row.server_id), "restart");
  }

  async #finishDelete(row: HostedServerRow): Promise<void> {
    if (row.provider_sandbox_id) {
      if (!this.#boat) throw new HostedServerServiceError(503, "hosting_not_configured", "Hosting is not configured.");
      try {
        await this.#boat.deleteSandbox(row.provider_sandbox_id);
      } catch (error) {
        throw new HostedServerServiceError(
          502,
          "hosted_server_provider_failed",
          `Deletion failed: ${safeErrorCode(error)}`,
        );
      }
    }
    // Before the row is final, so the cron removes the host again when this fails.
    await this.#removeHost?.(row.owner_user_id, row.server_id);
    const now = this.#now();
    await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE hosted_servers SET observed_state = 'deleted', claim_token_hash = NULL,
             deleted_at = ?, updated_at = ?
           WHERE server_id = ?`,
        )
        .bind(now, now, row.server_id),
      this.#database
        .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(now, row.auth_session_id),
    ]);
  }

  #requireAvailable(userId: string): { boat: BoatClient; template: string } {
    if (!this.isAvailableFor(userId) || !this.#boat || !this.#template) {
      throw new HostedServerServiceError(
        403,
        "hosting_unavailable",
        "Hosted servers are not available for this account.",
      );
    }
    return { boat: this.#boat, template: this.#template };
  }

  async #requireRow(serverId: string): Promise<HostedServerRow> {
    const row = await this.#database
      .prepare(`SELECT ${ROW_COLUMNS} FROM hosted_servers WHERE server_id = ?`)
      .bind(serverId)
      .first<HostedServerRow>();
    if (!row) throw notFound();
    return row;
  }
}

function summary(row: HostedServerRow): HostedServerSummary {
  return {
    serverId: row.server_id,
    name: row.name,
    size: row.size,
    state: row.observed_state,
    error: row.observed_error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function isUsable(state: BoatSandboxState): boolean {
  return state === "ready" || state === "idle" || state === "running";
}

function parseWebhookEvent(
  body: string,
  now: number,
): { sandboxId: string; state: BoatSandboxState; createdAt: number } | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isDynamicRecord(payload) || !isDynamicRecord(payload.data) || !isDynamicRecord(payload.data.sandbox))
    return null;
  const sandboxId = payload.data.sandbox.id;
  if (!isString(sandboxId)) return null;
  const state =
    payload.type === "sandbox.archived"
      ? "archived"
      : payload.type === "sandbox.error"
        ? "error"
        : payload.type === "sandbox.ready" && isBoatState(payload.data.state)
          ? payload.data.state
          : null;
  if (!state) return null;
  const createdAt = isString(payload.createdAt) ? Date.parse(payload.createdAt) : Number.NaN;
  return { sandboxId, state, createdAt: Number.isFinite(createdAt) ? createdAt : now };
}

function providerError(error: unknown): HostedServerError {
  if (!(error instanceof BoatApiError)) return "provider_error";
  if (error.status === 402 || error.code === "billing_required") return "provider_billing";
  if (error.status === 429 || error.code === "trial_machine_class_not_allowed") return "provider_limit";
  return "provider_error";
}

function safeErrorCode(error: unknown): string {
  if (error instanceof BoatApiError) return `${error.status}:${error.code}`;
  if (error instanceof HostedServerServiceError) return error.code;
  return "unknown";
}

function serverName(value: unknown): string {
  if (!isString(value)) throw invalid("name");
  const name = value.trim();
  if (!name || name.length > HOSTED_SERVER_NAME_MAX_LENGTH || /\p{Cc}/u.test(name)) throw invalid("name");
  return name;
}

function invalid(name: string): HostedServerServiceError {
  return new HostedServerServiceError(400, "invalid_hosted_server_request", `The ${name} is invalid.`);
}

function notFound(): HostedServerServiceError {
  return new HostedServerServiceError(404, "hosted_server_not_found", "The server does not exist.");
}

function invalidClaim(): HostedServerServiceError {
  return new HostedServerServiceError(401, "hosted_claim_invalid", "The server claim is invalid or used.");
}
