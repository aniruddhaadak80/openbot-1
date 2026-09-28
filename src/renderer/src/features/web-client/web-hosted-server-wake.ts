import { type HostedServerState, parseHostedServerSummary } from "@openbot/contracts/hosted-servers";

/** A hosted server in one of these states comes online without a user action, so the client reconnects. */
const WAKE_TRANSITION_STATES: ReadonlySet<HostedServerState> = new Set(["creating", "starting", "waking"]);
/** The reconnects for one start. With the 5 second delay of the caller, this is about 5 minutes. */
const MAX_WAKE_ATTEMPTS = 60;
/** A host that is not a hosted server stays so. It is asked again after this long, not on each failure. */
const NOT_HOSTED_RECHECK_MS = 10 * 60_000;

/**
 * Starts a stopped hosted server when a connection to it fails. The account server answers 404 for
 * any other host, so the web client can ask for each offline host. It returns true while the server
 * starts, so the caller reconnects until the server is online. It returns false when the server does
 * not start by itself, or after `MAX_WAKE_ATTEMPTS` replies for one start.
 */
export function createWebHostedServerWake(accountFetch: typeof fetch, now: () => number = Date.now) {
  const notHostedAt = new Map<string, number>();
  /** The transition replies in a row for each host. */
  const attempts = new Map<string, number>();
  /** When the reconnects of a host stopped at the limit. The host is asked again after the recheck time. */
  const gaveUpAt = new Map<string, number>();
  /** A failed connection reports itself twice, so both reports share one request. */
  const pending = new Map<string, Promise<boolean>>();

  return function wake(hostId: string): Promise<boolean> {
    const current = pending.get(hostId);
    if (current) return current;
    const request = requestWake(hostId).finally(() => pending.delete(hostId));
    pending.set(hostId, request);
    return request;
  };

  async function requestWake(hostId: string): Promise<boolean> {
    const time = now();
    const checked = notHostedAt.get(hostId);
    if (checked !== undefined && time - checked < NOT_HOSTED_RECHECK_MS) return false;
    const stopped = gaveUpAt.get(hostId);
    if (stopped !== undefined && time - stopped < NOT_HOSTED_RECHECK_MS) return false;
    let response: Response;
    try {
      response = await accountFetch(
        new URL(`/api/browser/v2/hosting/servers/${encodeURIComponent(hostId)}/wake`, window.location.origin),
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", "X-OpenBot-Browser": "1" },
          body: "{}",
        },
      );
    } catch {
      // A network failure is also the reason the host is offline; the next failure asks again.
      return false;
    }
    if (!response.ok) {
      attempts.delete(hostId);
      notHostedAt.set(hostId, time);
      return false;
    }
    const server = parseHostedServerSummary(await response.json().catch(() => null));
    const previous = attempts.get(hostId) ?? 0;
    if (server && WAKE_TRANSITION_STATES.has(server.state)) {
      if (previous >= MAX_WAKE_ATTEMPTS) {
        attempts.delete(hostId);
        gaveUpAt.set(hostId, time);
        return false;
      }
      attempts.set(hostId, previous + 1);
      return true;
    }
    attempts.delete(hostId);
    // A server that just started gets one more reconnect, because its host connects a moment after the start.
    return server?.state === "running" && previous > 0;
  }
}
