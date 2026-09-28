import { BillingService } from "./billing-service";
import {
  type HostedServerBindings,
  HostedServerService,
  type HostedServerServiceOptions,
} from "./hosted-server-service";
import type { WorkerBindings } from "./types";

export type HostedBillingBindings = HostedServerBindings &
  Partial<Pick<WorkerBindings, "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET">>;

/**
 * Billing and hosted servers, linked in both directions: a server starts a Checkout, and a stored
 * subscription starts or stops its server. Billing is null when the deployment has no Stripe key.
 */
export function createHostedBilling(
  bindings: HostedBillingBindings,
  options: Pick<HostedServerServiceOptions, "removeHost">,
): { billing: BillingService | null; hosting: HostedServerService } {
  const secretKey = bindings.STRIPE_SECRET_KEY?.trim();
  const billing = secretKey
    ? new BillingService({
        database: bindings.DB,
        secretKey,
        webhookSecret: bindings.STRIPE_WEBHOOK_SECRET?.trim() || null,
        fetch: (input, init) => fetch(input, init),
        onSubscriptionSynced: (sync) => hosting.onSubscriptionSynced(sync),
      })
    : null;
  const hosting = new HostedServerService(bindings, { removeHost: options.removeHost, billing });
  return { billing, hosting };
}
