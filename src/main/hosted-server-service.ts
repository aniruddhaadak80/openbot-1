import {
  type CreateHostedServerInput,
  type DeleteHostedServerInput,
  type HostedServerList,
  type HostedServerSummary,
  parseHostedServerList,
  parseHostedServerSummary,
} from "@openbot/contracts/hosted-servers";
import { sourceText } from "@openbot/i18n/source";

/** A client asks for a wake at most this often for one host, while the host stays unavailable. */
const WAKE_INTERVAL_MS = 60_000;

export interface HostedServerAuthClient {
  requestAuthorized<T>(path: string, init: RequestInit, decoder: (value: unknown) => T, timeoutMs?: number): Promise<T>;
}

/** The account server's hosted servers, for the signed-in account. */
export class HostedServerDesktopService {
  readonly #lastWakeAt = new Map<string, number>();

  constructor(
    private readonly auth: HostedServerAuthClient,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Promise<HostedServerList> {
    return this.auth.requestAuthorized("/v2/hosting/servers/", { method: "GET" }, decodeList);
  }

  create(input: CreateHostedServerInput): Promise<HostedServerSummary> {
    return this.auth.requestAuthorized(
      "/v2/hosting/servers/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": input.requestId },
        body: JSON.stringify({ name: input.name, size: input.size }),
      },
      decodeSummary,
      30_000,
    );
  }

  async delete(input: DeleteHostedServerInput): Promise<void> {
    await this.auth.requestAuthorized(
      `/v2/hosting/servers/${encodeURIComponent(input.serverId)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: input.confirmName }),
      },
      () => undefined,
      30_000,
    );
  }

  wake(serverId: string): Promise<HostedServerSummary> {
    this.#lastWakeAt.set(serverId, this.now());
    return this.auth.requestAuthorized(
      `/v2/hosting/servers/${encodeURIComponent(serverId)}/wake`,
      { method: "POST" },
      decodeSummary,
    );
  }

  /**
   * Signal answered that the host is not connected. When the host is a hosted server that the
   * provider stopped, this starts it, and the reconnect that already runs finds it online. For any other host the
   * account server answers 404, so the result is ignored.
   */
  wakeUnavailableHost(serverId: string): Promise<void> {
    const last = this.#lastWakeAt.get(serverId);
    if (last !== undefined && this.now() - last < WAKE_INTERVAL_MS) return Promise.resolve();
    return this.wake(serverId).then(
      () => undefined,
      () => undefined,
    );
  }
}

function decodeList(value: unknown): HostedServerList {
  const list = parseHostedServerList(value);
  if (!list) throw new Error(sourceText("error.auth.invalidHostedServer"));
  return list;
}

function decodeSummary(value: unknown): HostedServerSummary {
  const summary = parseHostedServerSummary(value);
  if (!summary) throw new Error(sourceText("error.auth.invalidHostedServer"));
  return summary;
}
