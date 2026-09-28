import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";

const logger = createOpenBotLogger("deploy-auth-api");

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptsRoot, "..");
const apiRoot = join(projectRoot, "apps", "auth-api");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const bunExecutable = process.execPath;
// Bun installs the workspace binaries at the repository root.
const wranglerExecutable = join(projectRoot, "node_modules", ".bin", `wrangler${executableSuffix}`);
const cloudflareEnvironment = readCloudflareEnvironment(process.argv.slice(2));
const environmentArgs = cloudflareEnvironment ? ["--env", cloudflareEnvironment] : [];

async function main(): Promise<void> {
  await putRequiredSecret("EMAIL_SMTP_PASSWORD");
  await putRequiredSecret("SKILLS_ADMIN_TOKEN");
  await putRequiredSecret("SITE_REPORT_HASH_SECRET");
  await putRequiredSecret("REMOTE_TICKET_PRIVATE_JWK");
  await putRequiredSecret("REMOTE_TICKET_PUBLIC_JWKS");
  await putRequiredSecret("REMOTE_AUTH_WEBHOOK_SECRET");
  await putOptionalSecretPair("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET");
  await run(wranglerExecutable, ["d1", "migrations", "apply", "DB", "--remote", ...environmentArgs], {
    label: "Remote D1 migrations",
  });
  await run(bunExecutable, ["run", "build"], {
    label: "Auth API build",
    env: cloudflareEnvironment ? { CLOUDFLARE_ENV: cloudflareEnvironment } : undefined,
  });
  await run(wranglerExecutable, ["deploy", "--keep-vars", ...environmentArgs], {
    label: "Auth API deployment",
  });
}

async function putRequiredSecret(name: string): Promise<void> {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is missing from the decrypted production environment.`);
  // dotenvx keeps the ciphertext when .env.keys has no matching private key.
  if (value.startsWith("encrypted:")) throw new Error(`${name} is not decrypted. Check the private key in .env.keys.`);
  await run(wranglerExecutable, ["secret", "put", name, ...environmentArgs], {
    input: `${value}\n`,
    label: `${name} secret`,
  });
}

/**
 * Billing is optional: the Worker turns it off without these secrets. Set both or neither, because a
 * key without its webhook secret takes payments that never reach the database.
 */
async function putOptionalSecretPair(first: string, second: string): Promise<void> {
  const present = [first, second].filter((name) => process.env[name]?.trim());
  if (present.length === 0) {
    logger.info(`${first} and ${second} are not set. Billing stays off.`);
    return;
  }
  if (present.length === 1) {
    throw new Error(`Set both ${first} and ${second} in the decrypted production environment, or neither.`);
  }
  await putRequiredSecret(first);
  await putRequiredSecret(second);
}

async function run(
  executable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; label: string },
): Promise<void> {
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const environment = { ...process.env, ...options.env };
    if (executable === wranglerExecutable) delete environment.CLOUDFLARE_API_TOKEN;
    const child = spawn(executable, args, {
      cwd: apiRoot,
      env: environment,
      shell: false,
      stdio: [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    child.once("error", rejectProcess);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveProcess();
      else {
        rejectProcess(new Error(`${options.label} failed with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}.`));
      }
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function readCloudflareEnvironment(args: string[]): string | null {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === "--env" && /^[a-z0-9-]+$/u.test(args[1] ?? "")) {
    return args[1] ?? null;
  }
  throw new Error("Use --env followed by a lowercase Cloudflare environment name.");
}

void main().catch((error) => {
  logger.error("Auth API deployment failed.", toLogValue(error));
  process.exitCode = 1;
});
