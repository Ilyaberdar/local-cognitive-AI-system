import { ManifestError, type ReleaseKey } from "./manifest";
import { checkForUpdate, UpdateError } from "./serverUpdate";

/** What a server tells its owner's computers about releases: the newest one when it is newer. */
export interface UpdateAvailability {
  current: string;
  checkedAt: string | null;
  available: { version: string; notes: string; notesUrl?: string; releasedAt: string } | null;
  /** Why the last check did not answer (a code), or that checks are off. */
  error?: string;
}

/** Looks for a newer signed release once a day (the first a few minutes after start, each with a
 * jitter, so servers do not ask at the same moment). Off without a release key in this build, or
 * with LOCAL_COGNITIVE_UPDATE_CHECK=off; it never installs anything. */
export class UpdateChecker {
  private state: UpdateAvailability;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly options: { manifestUrl: string; keys: readonly ReleaseKey[]; currentVersion: string; enabled: boolean;
    fetchImpl?: typeof fetch; intervalMs?: number; firstDelayMs?: number; random?: () => number }) {
    this.state = { current: options.currentVersion, checkedAt: null, available: null,
      ...(!options.enabled ? { error: "checks_off" } : !options.keys.length ? { error: "no_release_key" } : {}) };
  }

  status(): UpdateAvailability { return structuredClone(this.state); }

  start(): void {
    if (!this.active()) return;
    const random = this.options.random ?? Math.random;
    this.schedule(this.options.firstDelayMs ?? 60_000 + random() * 4 * 60_000);
  }

  stop(): void { this.stopped = true; clearTimeout(this.timer); }

  async checkNow(): Promise<UpdateAvailability> {
    if (!this.active()) return this.status();
    try {
      const manifest = await checkForUpdate({ manifestUrl: this.options.manifestUrl, keys: this.options.keys, currentVersion: this.options.currentVersion, fetchImpl: this.options.fetchImpl });
      this.state = { current: this.options.currentVersion, checkedAt: new Date().toISOString(),
        available: manifest ? { version: manifest.version, notes: manifest.notes.slice(0, 4000), releasedAt: manifest.releasedAt, ...(manifest.notesUrl ? { notesUrl: manifest.notesUrl } : {}) } : null };
    } catch (error) {
      // Nothing published yet (GitHub answers 404): no update, and nothing wrong.
      if (error instanceof UpdateError && error.code === "not_published") {
        this.state = { current: this.options.currentVersion, checkedAt: new Date().toISOString(), available: null };
        return this.status();
      }
      // The last known release stays shown; the error says the check did not answer.
      this.state = { ...this.state, checkedAt: new Date().toISOString(), error: error instanceof ManifestError || error instanceof UpdateError ? error.code : "unreachable" };
    }
    return this.status();
  }

  private active() { return this.options.enabled && this.options.keys.length > 0 && !this.stopped; }

  private schedule(delayMs: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.checkNow().finally(() => {
        const random = this.options.random ?? Math.random;
        if (!this.stopped) this.schedule((this.options.intervalMs ?? 24 * 3_600_000) + (random() - 0.5) * 2 * 3_600_000);
      });
    }, delayMs);
    this.timer.unref();
  }
}
