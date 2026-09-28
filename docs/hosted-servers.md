# Hosted servers

A hosted server is an OpenBot server that runs in a [boat](https://boat.dev) sandbox, so it works
when the user's computer is off. Each server is one boat sandbox for one account. The sandbox runs
the Linux build of OpenBot under Xvfb. The server runs all the time (24/7). It does not stop when
it is idle. When boat stops a sandbox, the Worker starts it again.

Hosted servers are a development feature. Only the `test` Worker environment enables them, and
only for the account IDs in `HOSTED_SERVERS_ALLOWED_USER_IDS`, and only when the Worker has
`STRIPE_SECRET_KEY`. Each server has its own Stripe plan. Its machine comes from the plan
(`HOSTED_PLAN_SIZE`): Starter is boat `small`, Standard is `default`, and Pro is `large`.

## Parts

| Part | Where | Job |
| --- | --- | --- |
| Account Worker | `apps/auth-api/src/server/hosted-server-service.ts`, `boat-client.ts` | Creates, restarts and deletes sandboxes. Stores state in D1 (`0023_hosted_servers.sql`). |
| Server template | `scripts/hosting/` | Builds the boat named snapshot that each server starts from. |
| Server bootstrap | `src/main/hosted-server-bootstrap.ts` | On the first start, redeems the claim, signs in, and publishes the host. |
| Start retry | `src/main/hosted-server-start-retry.ts` | Publishes the host again after a failed start. |
| Billing link | `apps/auth-api/src/server/hosted-billing.ts`, `billing-service.ts` | Opens Stripe Checkout for a new server. Tells the hosting service when a subscription changes. |
| Desktop and web clients | `AddServerOverlay`, `SettingsHostedServersTab`, `hosted-server-service.ts`, `web-hosted-servers.ts`, `web-hosted-server-wake.ts` | Pick a plan, pay, list, start, renew and delete. Start a stopped server when a connection fails. |

## Lifecycle

States: `awaiting_payment → creating → starting → running`; `running → stopping → stopped → waking → running` when boat stops a sandbox; and `error` and
`deleted`. The Worker stores what it wants (`desired_state`) and what boat reports
(`observed_state`). boat webhooks and the cron update `observed_state`.

1. **Create.** The rail plus button opens the add server dialog when the account can create hosted
   servers; otherwise it opens the join dialog. A plan sends `POST /v2/hosting/servers/` with
   `{name, plan, interval, currency}` and an `Idempotency-Key`. The Worker stores a row in
   `awaiting_payment` with no claim and no sandbox, makes the Stripe customer, and returns a Stripe
   Checkout URL (30 minutes). A repeated request expires the old Checkout and returns a new one.
   The desktop main process opens the URL only when it is an `https://checkout.stripe.com` URL; the
   renderer never gets it. The web client goes to the page in the same tab, and Stripe returns to
   `/app?hosting=checkout&hosted_server=<id>` (`&cancelled=1` when the user went back).
   `POST /v2/hosting/servers/:id/checkout` makes a new page for "Open the payment page again".
2. **Provision.** The signed Stripe webhook syncs the subscription to D1 and calls
   `onSubscriptionSynced`. When the plan is open and the row waits for payment, the Worker makes
   the host ID claim (single use, 1 hour; it stores only the hash) and creates the sandbox from
   `HOSTED_SERVER_TEMPLATE` with `noEnv: true`, so no operator secret or repository goes into the
   sandbox. The sandbox env holds only `OPENBOT_HOSTED_HOST_ID` and `OPENBOT_HOSTED_CLAIM`. The cron
   provisions a paid row when the webhook call failed, and deletes an unpaid row after 24 hours
   (it has no sandbox, so no data is lost).
3. **Env handoff.** boat puts the sandbox env in the setup script, not in systemd. The Worker sends
   `setupScript: exec /opt/OpenBot/hosted/openbot-hosted-env`. That helper writes the two values to
   `~/.config/openbot-hosted/env` (mode 0600). `openbot.service` waits for this file.
4. **First boot.** OpenBot starts with `OPENBOT_HOSTED_SERVER=1`. It redeems the claim at
   `POST /v2/hosting/claims/redeem`, signs in as the owner, keeps the host ID, and publishes the
   host. `registerHost` refuses the host ID for any other account.
5. **Always on.** The server never asks to stop. `desired_state` is `running` while the plan is
   open. When boat reports `archived` (for example, after maintenance), the webhook
   resumes the sandbox at once. The Worker cron (each minute on `test`) resumes a server that stays
   `stopped` for 2 minutes.
6. **Start after a failure.** A client that cannot reach the host calls
   `POST /v2/hosting/servers/:id/wake` (owner or member; 404 for a host that is not a hosted
   server). This resumes a `stopped` sandbox or one in `error`. The desktop does this when Signal
   answers `host_unavailable`, at most once a minute for each host. The web client does this when a
   connection fails, then connects again every 5 seconds. A server whose plan ended answers
   `402 plan_required`.

   A paid server whose setup failed has no sandbox. A wake (Retry in the add server dialog) sets
   it up again at once, and the cron does this 10 minutes after each failure. Each attempt has a
   new claim and the same idempotency key, the host ID.
7. **Plan ends.** When the subscription is cancelled or unpaid, or `past_due` after its period
   end, the Worker sets `desired_state = 'stopped'` with the error `plan_ended` and stops the
   sandbox. boat saves the disk; the Worker never deletes it. "Renew plan" in Settings calls the
   checkout route: the Worker makes a new plan only when no open plan exists for the server. With
   an open, unpaid plan it answers `409 hosted_server_payment_due`, and the user pays in the Billing
   Customer Portal. When the plan is open again, the Worker resumes the sandbox. A server whose setup
   failed has no sandbox: a renewed plan sets it up again.

   After a failed renewal, Stripe moves the period end forward and retries the payment, so the
   server keeps running while the plan is `past_due`. When Stripe stops the retries, it cancels the
   plan and the server stops. A cancel at the period end (`cancel_at_period_end` or `cancel_at`)
   shows the end date and keeps the server running until then.
8. **Plan change.** In the Customer Portal an upgrade is charged at once, and a downgrade or a
   shorter interval starts at the next period. The Worker copies the new plan, interval and currency
   to the server. boat changes the machine of a sandbox only on a resume (`type`), so the Worker
   stops a running server (boat saves the disk) and resumes it on the machine of the new plan. The
   server is offline for this time. The cron does this for a server that was not running at the
   plan change. When the data does not fit a smaller machine, boat refuses it
   (`409 type_too_small`); the server then starts on its old machine, and the Worker does not try
   again until the next plan change.
9. **Delete.** `DELETE /v2/hosting/servers/:id` with `{confirmName}`. The Worker first cancels the
   open plan now, with no refund. A Stripe failure stops the delete (502), so the user does not pay
   for a deleted server. Then it deletes the sandbox and its Remote host. The D1 row stays with `desired_state = 'deleted'`, so a sandbox is never
   left without a record.

## Configure the test Worker

`HOSTED_SERVERS_ENABLED` is `true` in `env.test` of `apps/auth-api/wrangler.jsonc`. Set the rest
with `wrangler secret put <name> --env test` from `apps/auth-api`:

| Name | Value |
| --- | --- |
| `BOAT_API_KEY` | A boat key limited to sandbox create, get, list, stop, resume and delete. Do not give it file, command, prompt or desktop access: this key must not read user data. |
| `BOAT_WEBHOOK_SECRET` | The signing secret of the boat webhook below. |
| `HOSTED_SERVER_TEMPLATE` | The named snapshot from the template build, such as `openbot-server-0-9-0`. |
| `HOSTED_SERVERS_ALLOWED_USER_IDS` | Comma-separated account IDs that can create servers. |

Register a boat webhook to `https://<test Worker origin>/v2/hosting/boat/webhook` for
`sandbox.ready`, `sandbox.error`, `sandbox.archived` and `sandbox.hydrated`. The Worker checks the
HMAC signature, refuses a delivery older than 5 minutes, and ignores a delivery ID it has seen.

Point your desktop development build at the test Worker with `OPENBOT_AUTH_API_URL`.

## Build the server template

The template is a boat named snapshot. Build one for each OpenBot release that servers use:

```sh
BOAT_TEMPLATE_API_KEY=... bun run hosting:template --version=0.9.0 \
  --appimage-url=https://.../OpenBot-0.9.0-x86_64.AppImage --appimage-sha256=<hex> \
  --auth-api-url=https://<test Worker origin>
```

`BOAT_TEMPLATE_API_KEY` is a different key from the Worker key: it needs sandbox, file, command and
named snapshot access. The script:

1. creates a builder sandbox with `noEnv`;
2. uploads `scripts/hosting/` and runs `provision.sh` with `sudo`. It installs Xvfb, D-Bus,
   gnome-keyring and the Electron libraries, checks the AppImage SHA-256, unpacks the AppImage to
   `/opt/OpenBot/app`, adds an AppArmor profile that lets Chromium make user namespaces, and
   enables `openbot.service`;
3. checks that OpenBot did not start and that no profile or claim exists;
4. saves the builder as `openbot-server-<version>` and deletes the builder.

The builder never starts OpenBot, so the template has no host identity and no session. A new
template applies only to new servers. boat keeps at most 10 named snapshots for each account.

On a server, `openbot-hosted-server` starts a D-Bus session, unlocks a gnome-keyring with a
random password for each server (so `safeStorage` can keep the account session), and runs OpenBot
under `xvfb-run` with `--password-store=gnome-libsecret`. The keyring files are in
`/srv/openbot-hosted/keyrings`:

- not in `~/.local/share/keyrings`: the boat image has a locked `default` keyring there, and a
  snapshot restore resets that folder after the service starts;
- not in `/home`: after a resume, boat serves `/home` from a FUSE mount until the disk is restored.
  On that mount, gnome-keyring does not see the new link count after its backup link. Each keyring
  write then added 16,000 to 31,000 `login.keyring.temp-*` hard links, and the next resume read
  them through the slow mount for 25 s. boat keeps changes in `/srv` (not in `/var/lib`), and `/srv`
  is on the disk before the service starts.

OpenBot redeems the claim only when `safeStorage` works. The claim works one time, so a session
that is only in memory would leave the server signed out after its next start.

## Tested on boat

The `boat` scenario of `scripts/stripe-flows-e2e.ts` (see `apps/auth-api/README.md`) passed on
2026-09-28 with a local Worker, the Stripe sandbox and a boat trial account. It confirmed:

- the builder user has passwordless `sudo`, and AppArmor is enabled in the boat VM;
- boat runs `setupScript` for a sandbox created from a named snapshot, and systemd starts
  `openbot.service` after a create;
- OpenBot redeems its claim, publishes the host with the server name, and signs in again from the
  stored session after a restart (`safeStorage` with gnome-keyring under Xvfb);
- a delete through the Worker removes the sandbox.

A resume test on 2026-09-28 (one sandbox with the 0.24.0 AppImage, 6 resumes, each on another
machine) confirmed that systemd starts `openbot.service` again after a resume, and that a keyring
secret in `/srv` stays. From the resume call to the OpenBot start took 7 to 34 s; the keyring start
took 40 ms. Most of the time is boat: it restores the disk and then starts the enabled units, 5 to
20 s after the sandbox is `idle`.

A boat trial account refuses a sandbox with no auto-stop (`trial_auto_stop_required`), and the
Worker shows it as `provider_billing`. The test ran with a local two-hour TTL; the Worker needs a
paid boat plan.

## Not confirmed

These were not tested on boat. Test them before a user gets access:

- that production Signal accepts tickets from the `test` Worker;
- a lost response to the boat create call. The Worker sends the same request again one time, and
  boat returns the same sandbox. When that also fails, the sandbox has a claim that the Worker
  no longer accepts. For 24 hours, boat refuses each retry with `idempotency_key_reused`, which the
  Worker logs. After that, a retry makes a new sandbox. An operator must delete the first one;
- the vCPU, memory and disk of boat `large`;
- a resize on boat: stop, then resume with a `type`. The docs say that it keeps the disk and costs
  nothing more than the resume. The test uses a fake boat;
- that boat frees the key of a refused create, so a retry of a setup that failed works;
- whether boat stops a sandbox that runs for weeks. The Worker restarts it, but work in progress
  at that time stops.
