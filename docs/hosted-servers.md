# Hosted servers

A hosted server is an OpenBot server that runs in a [boat](https://boat.dev) sandbox, so it works
when the user's computer is off. Each server is one boat sandbox for one account. The sandbox runs
the Linux build of OpenBot under Xvfb. The server runs all the time (24/7). It does not stop when
it is idle. When boat stops a sandbox, the Worker starts it again.

Hosted servers are a development feature. Only the `test` Worker environment enables them, and
only for the account IDs in `HOSTED_SERVERS_ALLOWED_USER_IDS`. There is no billing yet.

## Parts

| Part | Where | Job |
| --- | --- | --- |
| Account Worker | `apps/auth-api/src/server/hosted-server-service.ts`, `boat-client.ts` | Creates, restarts and deletes sandboxes. Stores state in D1 (`0023_hosted_servers.sql`). |
| Server template | `scripts/hosting/` | Builds the boat named snapshot that each server starts from. |
| Server bootstrap | `src/main/hosted-server-bootstrap.ts` | On the first start, redeems the claim, signs in, and publishes the host. |
| Start retry | `src/main/hosted-server-start-retry.ts` | Publishes the host again after a failed start. |
| Desktop and web clients | `SettingsHostedServersTab`, `hosted-server-service.ts`, `web-hosted-server-wake.ts` | List, create, start and delete. Start a stopped server when a connection fails. |

## Lifecycle

States: `creating → starting → running`; `running → stopping → stopped → waking → running` when boat stops a sandbox; and `error` and
`deleted`. The Worker stores what it wants (`desired_state`) and what boat reports
(`observed_state`). boat webhooks and the cron update `observed_state`.

1. **Create.** `POST /v2/hosting/servers/` with `{name, size}` and an `Idempotency-Key`. The Worker
   makes the host ID and a single-use claim (1 hour). It stores only the claim hash. It creates the
   sandbox from `HOSTED_SERVER_TEMPLATE` with `noEnv: true`, so no operator secret or repository
   goes into the sandbox. The sandbox env holds only `OPENBOT_HOSTED_HOST_ID` and
   `OPENBOT_HOSTED_CLAIM`.
2. **Env handoff.** boat puts the sandbox env in the setup script, not in systemd. The Worker sends
   `setupScript: exec /opt/OpenBot/hosted/openbot-hosted-env`. That helper writes the two values to
   `~/.config/openbot-hosted/env` (mode 0600). `openbot.service` waits for this file.
3. **First boot.** OpenBot starts with `OPENBOT_HOSTED_SERVER=1`. It redeems the claim at
   `POST /v2/hosting/claims/redeem`, signs in as the owner, keeps the host ID, and publishes the
   host. `registerHost` refuses the host ID for any other account.
4. **Always on.** The server never asks to stop. `desired_state` is `running` until the user
   deletes the server. When boat reports `archived` (for example, after maintenance), the webhook
   resumes the sandbox at once. The Worker cron (each minute on `test`) resumes a server that stays
   `stopped` for 2 minutes.
5. **Start after a failure.** A client that cannot reach the host calls
   `POST /v2/hosting/servers/:id/wake` (owner or member; 404 for a host that is not a hosted
   server). This resumes a `stopped` sandbox or one in `error`. The desktop does this when Signal
   answers `host_unavailable`, at most once a minute for each host. The web client does this when a
   connection fails, then connects again every 5 seconds.
6. **Delete.** `DELETE /v2/hosting/servers/:id` with `{confirmName}`. The Worker deletes the sandbox
   and its Remote host. The D1 row stays with `desired_state = 'deleted'`, so a sandbox is never
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
under `xvfb-run` with `--password-store=gnome-libsecret`.

## Not confirmed

These were not tested on boat. Test them before a user gets access:

- that the sandbox user has passwordless `sudo` in the builder;
- that boat runs `setupScript` for a sandbox created from a named snapshot, and that systemd
  starts enabled units after a create and after a resume;
- that `safeStorage` works with gnome-keyring under Xvfb;
- that AppArmor is enabled in the boat VM (`provision.sh` skips the profile when it is not);
- how long a resume takes after boat stops a sandbox;
- that production Signal accepts tickets from the `test` Worker;
- a lost response to the boat create call. The idempotency key is the host ID, so a retry returns
  the same sandbox, but no retry runs by itself;
- whether boat stops a sandbox that runs for weeks. The Worker restarts it, but work in progress
  at that time stops.
