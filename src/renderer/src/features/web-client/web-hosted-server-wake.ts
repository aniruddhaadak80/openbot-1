/** After a wake, the client reconnects for this long before it asks for another wake. */
const WAKE_RETRY_WINDOW_MS = 5 * 60_000;
/** A host that is not a hosted server stays so. It is asked again after this long, not on each failure. */
const NOT_HOSTED_RECHECK_MS = 10 * 60_000;

/**
 * Starts a stopped hosted server when a connection to it fails. The account server answers 404 for
 * any other host, so the web client can ask for each offline host. It returns true while a wake is
 * in progress, so the caller reconnects until the server is online.
 */
export function createWebHostedServerWake(accountFetch: typeof fetch, now: () => number = Date.now) {
  const wokenAt = new Map<string, number>();
  const notHostedAt = new Map<string, number>();
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
    const woken = wokenAt.get(hostId);
    if (woken !== undefined && time - woken < WAKE_RETRY_WINDOW_MS) return true;
    const checked = notHostedAt.get(hostId);
    if (checked !== undefined && time - checked < NOT_HOSTED_RECHECK_MS) return false;
    try {
      const response = await accountFetch(
        new URL(`/api/browser/v2/hosting/servers/${encodeURIComponent(hostId)}/wake`, window.location.origin),
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", "X-OpenBot-Browser": "1" },
          body: "{}",
        },
      );
      if (response.ok) {
        wokenAt.set(hostId, time);
        return true;
      }
    } catch {
      // A network failure is also the reason the host is offline; the next failure asks again.
      return false;
    }
    notHostedAt.set(hostId, time);
    return false;
  }
}
