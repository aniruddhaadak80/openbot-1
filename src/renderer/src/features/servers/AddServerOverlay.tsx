import type { BillingInterval } from "@openbot/contracts/billing";
import type { HostedServerSummary } from "@openbot/contracts/hosted-servers";
import type { HostedServersDesktopApi, ServerSummary } from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import type {
  CreatedHostedServer,
  CreateHostedServerInput,
  HostedServerSetupStatus,
} from "@openbot/ui/features/servers/AddServerDialog";
import {
  HOSTED_BILLING_CURRENCY,
  type HostedServerPlan,
  hostedServerPlansFromCatalog,
} from "@openbot/ui/features/servers/HostedServerPricing";
import { currentText } from "@openbot/ui/text";
import { createEffect, createStore, Loading, Show, untrack } from "solid-js";
import { AddServerDialog } from "../../lazy-views";

/** How often the dialog reads the new server while it waits for the payment and the setup. */
const SETUP_POLL_INTERVAL_MS = 3_000;

export type AddServerCalls = Pick<HostedServersDesktopApi, "list" | "plans" | "create" | "openCheckout" | "wake">;

/** A server that the user created before the dialog opened, such as on a return from the payment page. */
export interface AddServerResume {
  serverId: string;
  /** True when Stripe returned after a payment. The setup then shows before the payment webhook. */
  paid: boolean;
}

interface AddServerOverlayProps {
  open: boolean;
  calls: AddServerCalls;
  /** The servers on the rail. The new server is ready when it shows here. */
  servers: readonly ServerSummary[];
  resume?: AddServerResume | null | undefined;
  onClose: () => void;
  onOpenServer: (serverId: string) => void;
  onContactUs?: (() => void) | undefined;
  onJoinWithInvite?: (() => void) | undefined;
}

interface AddServerState {
  plans: HostedServerPlan[] | null;
  /** The number of hosted servers of the account, for the name of the next one. */
  serverCount: number;
  server: HostedServerSummary | null;
  paid: boolean;
}

/**
 * The plus button on the server rail, when the account can create hosted servers. A plan opens
 * the Stripe Checkout page; the account server creates the machine after Stripe confirms the payment.
 * The desktop main process and the web client open the page, so this view never gets its URL.
 */
export function AddServerOverlay(props: AddServerOverlayProps) {
  return (
    <Show when={props.open}>
      <AddServerSession {...props} />
    </Show>
  );
}

function AddServerSession(props: AddServerOverlayProps) {
  const [state, setState] = createStore<AddServerState>({ plans: null, serverCount: 0, server: null, paid: false });
  /** One key for each choice. A retry after a lost response sends the same key. */
  const requestIds = new Map<string, string>();
  const resume = untrack(() => props.resume) ?? null;

  void load();

  async function load(): Promise<void> {
    try {
      const [catalog, list] = await Promise.all([props.calls.plans(), props.calls.list()]);
      const resumed = resume ? list.servers.find((server) => server.serverId === resume.serverId) : undefined;
      setState((draft) => {
        draft.plans = hostedServerPlansFromCatalog(catalog);
        draft.serverCount = list.servers.length;
        draft.server = resumed ?? null;
        draft.paid = resume?.paid ?? false;
      });
    } catch (error) {
      const text = currentText();
      const title = text.t("settings.hostedServers.loadFailed");
      toast.error(title, { description: text.errorMessage(error, title) });
      props.onClose();
    }
  }

  const setupStatus = (): HostedServerSetupStatus | null => {
    const server = state.server;
    if (!server) return null;
    switch (server.state) {
      case "awaiting_payment":
        return state.paid ? "creating" : "payment";
      case "creating":
        return "creating";
      case "starting":
      case "waking":
        return "starting";
      case "running":
        return props.servers.some((entry) => entry.id === server.serverId) ? "ready" : "connecting";
      default:
        return "error";
    }
  };

  createEffect(
    () => {
      const status = setupStatus();
      return status !== null && status !== "ready" && status !== "error";
    },
    (shouldPoll) => {
      if (!shouldPoll) return;
      const timer = window.setInterval(() => void refresh(), SETUP_POLL_INTERVAL_MS);
      return () => window.clearInterval(timer);
    },
  );

  async function refresh(): Promise<void> {
    const serverId = state.server?.serverId;
    if (!serverId) return;
    const list = await props.calls.list().catch(() => null);
    const server = list?.servers.find((entry) => entry.serverId === serverId);
    if (server && state.server?.serverId === serverId) {
      setState((draft) => {
        draft.server = server;
      });
    }
  }

  function nextName(): string {
    const text = currentText();
    return state.serverCount === 0
      ? text.t("server.hosted.defaultName")
      : text.t("server.hosted.defaultNameNumbered", { number: state.serverCount + 1 });
  }

  async function create(input: CreateHostedServerInput): Promise<CreatedHostedServer> {
    const interval: BillingInterval = input.billing === "yearly" ? "year" : "month";
    const currency = HOSTED_BILLING_CURRENCY[input.currency];
    const choice = `${input.plan}:${interval}:${currency}`;
    const requestId = requestIds.get(choice) ?? crypto.randomUUID();
    requestIds.set(choice, requestId);
    const server = await props.calls.create({ name: nextName(), plan: input.plan, interval, currency, requestId });
    setState((draft) => {
      draft.server = server;
      draft.paid = false;
    });
    return { serverId: server.serverId, name: server.name };
  }

  async function openPayment(): Promise<void> {
    const serverId = state.server?.serverId;
    if (!serverId) return;
    const server = await props.calls.openCheckout(serverId);
    setState((draft) => {
      draft.server = server;
    });
  }

  async function retry(): Promise<void> {
    const serverId = state.server?.serverId;
    if (!serverId) return;
    try {
      const server = await props.calls.wake(serverId);
      setState((draft) => {
        draft.server = server;
      });
    } catch (error) {
      const text = currentText();
      const title = text.t("settings.hostedServers.wakeFailed");
      toast.error(title, { description: text.errorMessage(error, title) });
    }
  }

  return (
    <Show when={state.plans}>
      {(plans) => (
        <Loading>
          <AddServerDialog
            plans={plans()}
            recommendedPlan="standard"
            setupStatus={setupStatus()}
            resume={state.server ? { serverId: state.server.serverId, name: state.server.name } : undefined}
            onClose={props.onClose}
            onContactUs={props.onContactUs}
            onJoinWithInvite={props.onJoinWithInvite}
            onCreate={create}
            onRetry={() => void retry()}
            onOpenServer={() => {
              const serverId = state.server?.serverId;
              if (serverId) props.onOpenServer(serverId);
            }}
            onOpenPayment={openPayment}
          />
        </Loading>
      )}
    </Show>
  );
}
