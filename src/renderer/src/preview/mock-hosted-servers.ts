import type { HostedServerSummary } from "@openbot/contracts/hosted-servers";
import type { HostedServersDesktopApi } from "@openbot/contracts/ipc";

const CREATED_AT = "2026-09-20T09:30:00.000Z";
/** How long a mock server takes to start, so the list shows the transition state. */
const MOCK_BOOT_MS = 4_000;

/** One stopped hosted server, so the preview shows the list, the start action and the create form. */
export function createMockHostedServers(): HostedServersDesktopApi {
  let servers: HostedServerSummary[] = [
    {
      serverId: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
      name: "Research server",
      size: "small",
      state: "stopped",
      error: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  ];
  const update = (serverId: string, change: Partial<HostedServerSummary>): HostedServerSummary => {
    const server = servers.find((entry) => entry.serverId === serverId);
    if (!server) throw new Error("The hosted server does not exist.");
    const next = { ...server, ...change, updatedAt: new Date().toISOString() };
    servers = servers.map((entry) => (entry.serverId === serverId ? next : entry));
    return structuredClone(next);
  };

  return {
    list: async () => {
      const bootedBefore = Date.now() - MOCK_BOOT_MS;
      servers = servers.map((server) =>
        (server.state === "starting" || server.state === "waking") && Date.parse(server.updatedAt) <= bootedBefore
          ? { ...server, state: "running" }
          : server,
      );
      return structuredClone({ available: true, servers });
    },
    create: async (input) => {
      const now = new Date().toISOString();
      const server: HostedServerSummary = {
        serverId: crypto.randomUUID(),
        name: input.name,
        size: input.size,
        state: "starting",
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      servers = [...servers, server];
      return structuredClone(server);
    },
    delete: async ({ serverId, confirmName }) => {
      const server = servers.find((entry) => entry.serverId === serverId);
      if (!server) throw new Error("The hosted server does not exist.");
      if (server.name !== confirmName) throw new Error("Type the server name to delete it.");
      servers = servers.filter((entry) => entry.serverId !== serverId);
    },
    wake: async (serverId) => update(serverId, { state: "waking" }),
  };
}
