import {
  type HostedServerCheckout,
  type HostedServerSummary,
  parseHostedServerCatalog,
  parseHostedServerCheckout,
  parseHostedServerList,
  parseHostedServerSummary,
} from "@openbot/contracts/hosted-servers";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { currentText } from "@openbot/ui/text";
import type { AddServerCalls, AddServerResume } from "../servers/AddServerOverlay";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The add server dialog calls for a signed-in browser. They use the `/api/browser/v2/hosting/...`
 * operations. The page goes only to a Stripe Checkout URL, which the contract parser checks.
 */
export function createWebHostedServerCalls(
  accountFetch: typeof fetch,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): AddServerCalls {
  async function request<T>(
    path: string,
    decode: (value: unknown) => T | null,
    init: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const post = init.body !== undefined;
    const response = await accountFetch(`/api/browser/v2/hosting/${path}`, {
      method: post ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: post ? { "Content-Type": "application/json", "X-OpenBot-Browser": "1", ...init.headers } : {},
      ...(post ? { body: init.body } : {}),
    }).catch(() => {
      throw new Error(errorMessage(null));
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(value));
    const decoded = decode(value);
    if (!decoded) throw new Error(currentText().sourceText("error.auth.invalidHostedServer"));
    return decoded;
  }

  /** Goes to the payment page, when the server has one. The page leaves the app. */
  function open(checkout: HostedServerCheckout): HostedServerSummary {
    if (checkout.checkoutUrl) navigate(checkout.checkoutUrl);
    return checkout.server;
  }

  const serverPath = (serverId: string, action: string) => `servers/${encodeURIComponent(serverId)}/${action}`;

  return {
    list: () => request("servers", parseHostedServerList),
    plans: () => request("plans", parseHostedServerCatalog),
    async create({ requestId, ...input }) {
      const body = JSON.stringify(input);
      return open(
        await request("servers", parseHostedServerCheckout, { body, headers: { "Idempotency-Key": requestId } }),
      );
    },
    openCheckout: async (serverId) =>
      open(await request(serverPath(serverId, "checkout"), parseHostedServerCheckout, { body: "{}" })),
    wake: (serverId) => request(serverPath(serverId, "wake"), parseHostedServerSummary, { body: "{}" }),
  };
}

function errorMessage(value: unknown): string {
  if (isDynamicRecord(value) && isDynamicRecord(value.error) && isString(value.error.message))
    return value.error.message;
  return currentText().t("webClient.error.requestFailed");
}

/** Stripe Checkout returns to `/app?hosting=checkout&server=<id>`, with `&cancelled=1` when the user went back. */
const WEB_APP_HOSTING_PARAM = "hosting";

/** The server of a return from Stripe Checkout. The query is removed after it is read. */
export function takeHostingReturn(): AddServerResume | null {
  const url = new URL(window.location.href);
  if (url.searchParams.get(WEB_APP_HOSTING_PARAM) !== "checkout") return null;
  const serverId = url.searchParams.get("server");
  const paid = url.searchParams.get("cancelled") !== "1";
  for (const name of [WEB_APP_HOSTING_PARAM, "server", "cancelled"]) url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", url);
  return serverId ? { serverId, paid } : null;
}
