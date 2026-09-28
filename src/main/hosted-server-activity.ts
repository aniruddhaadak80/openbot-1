/**
 * A hosted server tells the Worker that it is in use: a client is connected or an agent works. With
 * no report for 15 minutes, the Worker stops the server and keeps its data. The next client starts it.
 */

const REPORT_INTERVAL_MS = 60_000;

export interface HostedServerActivityOptions {
  hostId: string;
  inUse: () => boolean;
  report: (path: string) => Promise<unknown>;
  onError: (message: string, error: unknown) => void;
}

export class HostedServerActivity {
  readonly #options: HostedServerActivityOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  #pending: Promise<void> | null = null;

  constructor(options: HostedServerActivityOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => this.#options.onError("The hosted server activity report failed.", error));
    }, REPORT_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  tick(): Promise<void> {
    this.#pending ??= this.#tick().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #tick(): Promise<void> {
    if (!this.#options.inUse()) return;
    await this.#options.report(`/v2/hosting/servers/${encodeURIComponent(this.#options.hostId)}/activity`);
  }
}
