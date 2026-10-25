import { randomBytes } from "node:crypto";
import type { AppConfig, ProviderHttpConfig } from "../config/config";
import { providerPreset } from "../llm/providerCatalog";
import type { CredentialVault } from "../plugins/contracts";
import type { AppSettings, AppSettingsPatch, StoredProviderSettings } from "../types";
import { SettingsValidationError } from "./settingsValidation";

/** What Settings shows of a key, never the key: saved, none, from the environment, saved but not
 * readable on this computer, kept in settings.json without encryption (the vault cannot be used
 * here), saved for another host (origin) than the provider's, or the environment's for another host. */
export type ApiKeyState = "set" | "unset" | "environment" | "unreadable" | "unprotected" | "address-changed" | "environment-address-changed";
export interface ResolvedKey { state: ApiKeyState; key?: string }
/** Each provider's key (llama.cpp has none) and the Telegram bot token, as the runtime uses them. */
export interface ResolvedKeys { providers: Record<string, ResolvedKey>; telegram: ResolvedKey }
/** Records a settings change wrote, and the ones it leaves unnamed (removed once it is committed). */
export interface KeyChanges { written: string[]; obsolete: string[] }

/** A key's vault record: the key, and the origin of the address it was saved for. */
interface KeyRecord { key: string; origin: string }

export const providerKeyRecord = (providerId: string, ref: string) => `provider-key/${providerId}/${ref}`;
export const telegramTokenRecord = (ref: string) => `telegram-bot-token/${ref}`;
/** Telegram's API has one address: the bot token is kept with it, as a provider's key is with its own. */
const TELEGRAM_ORIGIN = "https://api.telegram.org";
/** What LM Studio is sent without a key (it takes any value): never a secret. */
export const LMSTUDIO_PLACEHOLDER = "lm-studio";

const originOf = (address: string | undefined): string => {
  try { const origin = new URL(String(address)).origin; return origin === "null" ? "" : origin; } catch { return ""; }
};

/** Provider keys and the Telegram bot token in the credential vault. Each saved key is a record of its
 * own under a random ref that the settings name, with the origin it was saved for: a new key is a new
 * record, and the one it replaces is removed once the settings naming the new one are committed. A key
 * is used only at the origin it was saved for (another path on the same host keeps it), and never
 * without a valid address. Keys from the environment are never stored. */
export class ProviderKeyStore {
  // A record never changes, so one read stays valid until it is removed.
  private readonly cache = new Map<string, KeyRecord>();

  constructor(private readonly vault: CredentialVault, private readonly baseConfig: AppConfig) {}

  available(): boolean { return this.vault.available(); }

  /** Where a provider's requests go, as an origin: its address, or its kind's default without one. */
  origin(providerId: string, provider: StoredProviderSettings | undefined): string {
    const environment = this.baseConfig.compatibleProviders?.[providerId];
    if (provider?.source === "environment") return originOf(environment?.baseUrl);
    const builtIn = (this.baseConfig.providers as Record<string, ProviderHttpConfig | undefined>)[providerId];
    return originOf(provider?.baseUrl || builtIn?.baseUrl || environment?.baseUrl || providerPreset(provider?.preset ?? providerId)?.baseUrl);
  }

  /** A provider's key from the environment (a server's environment file, .env), and the origin it is for. */
  environment(providerId: string): KeyRecord | undefined {
    const entry = (this.baseConfig.providers as Record<string, ProviderHttpConfig | undefined>)[providerId] ?? this.baseConfig.compatibleProviders?.[providerId];
    const key = entry?.apiKey?.trim();
    return key && !(providerId === "lmstudio" && key === LMSTUDIO_PLACEHOLDER) ? { key, origin: originOf(entry!.baseUrl) } : undefined;
  }

  /** Each provider's key and the bot token for these settings. Never throws: a record that cannot be
   * read leaves only its own provider without a key. */
  async resolve(settings: AppSettings): Promise<ResolvedKeys> {
    const providers = await Promise.all(Object.entries(settings.providers).filter(([id]) => id !== "llamacpp")
      .map(async ([id, provider]) => [id, await this.resolveProvider(id, provider)] as const));
    return { providers: Object.fromEntries(providers), telegram: await this.resolveTelegram(settings.telegram) };
  }

  /** Applies a patch's keys to `next`, the patched settings: a key given is saved in a new record, ""
   * removes the saved one, and an address on another host (origin), or one that is not valid, removes
   * it too (a key never follows an address change); an address back on the host its key was saved
   * for keeps it. Refused (503) when a key is given and the vault cannot be used, and (400) when the
   * provider has no valid address. On failure the records it wrote are removed. */
  async patch(current: AppSettings, next: AppSettings, patch: AppSettingsPatch): Promise<KeyChanges> {
    const changes: KeyChanges = { written: [], obsolete: [] };
    try {
      for (const [id, providerPatch] of Object.entries(patch.providers ?? {})) {
        const before = current.providers[id], after = next.providers[id];
        const saved = before?.apiKeyRef ? providerKeyRecord(id, before.apiKeyRef) : undefined;
        if (!after) { if (saved) changes.obsolete.push(saved); continue; }
        const key = providerPatch?.apiKey, origin = this.origin(id, after);
        if (key === undefined && origin) {
          if (this.origin(id, before) === origin) continue;
          // Back on the host its key was saved for (an older version had moved it): the key stays.
          if (saved && (await this.read(saved).catch(() => undefined))?.origin === origin) { delete after.apiKey; continue; }
        }
        if (saved) changes.obsolete.push(saved);
        delete after.apiKey; delete after.apiKeyRef;
        if (key?.trim() && id !== "llamacpp") {
          after.apiKeyRef = await this.save(ref => providerKeyRecord(id, ref), key.trim(), origin);
          changes.written.push(providerKeyRecord(id, after.apiKeyRef));
        }
      }
      const token = patch.telegram?.botToken;
      if (token !== undefined) {
        if (current.telegram.botTokenRef) changes.obsolete.push(telegramTokenRecord(current.telegram.botTokenRef));
        delete next.telegram.botToken; delete next.telegram.botTokenRef;
        if (token.trim()) {
          next.telegram.botTokenRef = await this.save(telegramTokenRecord, token.trim(), TELEGRAM_ORIGIN);
          changes.written.push(telegramTokenRecord(next.telegram.botTokenRef));
        }
      }
    } catch (error) { await this.remove(changes.written); throw error; }
    return changes;
  }

  /** Moves the keys settings.json still holds into the vault, each read back before the settings stop
   * holding it (an earlier key's record goes once they are committed). A key equal to the
   * environment's, at the environment's host, is dropped instead: 0.1.9 and older wrote the
   * environment's key into every provider they saved, so a key saved since stays. A blank one (removed
   * by an older version) drops the saved one too; LM Studio's stand-in is no key. A key that cannot be
   * moved stays as it is (`complete` is false) and is tried again at the next start. */
  async moveToVault(settings: AppSettings): Promise<{ changes: KeyChanges; changed: boolean; complete: boolean }> {
    const changes: KeyChanges = { written: [], obsolete: [] };
    let changed = false, complete = true;
    /** The ref a plaintext key leaves behind: a new one, none, or undefined when it was not moved. */
    const move = async (plaintext: string, ref: string | undefined, record: (ref: string) => string, origin: string, environment?: KeyRecord): Promise<{ ref?: string } | undefined> => {
      const key = plaintext.trim();
      if (key && !(environment?.key === key && origin && environment.origin === origin)) {
        try {
          const moved = await this.save(record, key, origin, true);
          changes.written.push(record(moved));
          if (ref) changes.obsolete.push(record(ref));
          return { ref: moved };
        } catch { complete = false; return undefined; }
      }
      if (key) return { ref };
      if (ref) changes.obsolete.push(record(ref));
      return {};
    };
    for (const [id, provider] of Object.entries(settings.providers)) {
      if (provider.apiKey === undefined) continue;
      if (typeof provider.apiKey !== "string" || id === "llamacpp" || (id === "lmstudio" && provider.apiKey.trim() === LMSTUDIO_PLACEHOLDER)) { delete provider.apiKey; changed = true; continue; }
      const moved = await move(provider.apiKey, provider.apiKeyRef, ref => providerKeyRecord(id, ref), this.origin(id, provider), this.environment(id));
      if (!moved) continue;
      delete provider.apiKey; changed = true;
      if (moved.ref) provider.apiKeyRef = moved.ref; else delete provider.apiKeyRef;
    }
    const telegram = settings.telegram;
    if (typeof telegram.botToken !== "string") {
      if (telegram.botToken !== undefined) { delete telegram.botToken; changed = true; }
    } else {
      const environment = this.baseConfig.telegram.botToken?.trim();
      const moved = await move(telegram.botToken, telegram.botTokenRef, telegramTokenRecord, TELEGRAM_ORIGIN, environment ? { key: environment, origin: TELEGRAM_ORIGIN } : undefined);
      if (moved) {
        delete telegram.botToken; changed = true;
        if (moved.ref) telegram.botTokenRef = moved.ref; else delete telegram.botTokenRef;
      }
    }
    return { changes, changed, complete };
  }

  /** Removes records; one that cannot be read is removed too. A record left behind is never read. */
  async remove(records: string[]): Promise<void> {
    for (const record of records) {
      this.cache.delete(record);
      await this.vault.remove(record).catch(() => undefined);
    }
  }

  /** Saves a key in a new record and returns its ref; refused without a valid address (400) and when
   * the vault cannot be used (503, with the vault's reason). `verify` reads it back before it counts as saved. */
  private async save(record: (ref: string) => string, key: string, origin: string, verify = false): Promise<string> {
    if (!origin) throw new SettingsValidationError("Enter the service's address first: a key is kept for its address.");
    if (!this.vault.available()) {
      throw new SettingsValidationError(`${this.vault.unavailableReason?.() ?? "Protected storage is unavailable on this computer."} The key was not saved.`, 503);
    }
    const ref = randomBytes(16).toString("hex"), name = record(ref), value = JSON.stringify({ key, origin } satisfies KeyRecord);
    await this.vault.write(name, value);
    if (verify && await this.vault.read(name).catch(() => undefined) !== value) {
      await this.remove([name]);
      throw new Error("A key could not be read back from protected storage.");
    }
    this.cache.set(name, { key, origin });
    return ref;
  }

  /** A record, or undefined when there is none; throws when it cannot be read. */
  private async read(record: string): Promise<KeyRecord | undefined> {
    const cached = this.cache.get(record);
    if (cached) return cached;
    const raw = await this.vault.read(record);
    if (raw === undefined) return undefined;
    const parsed = JSON.parse(raw) as Partial<KeyRecord> | null;
    if (typeof parsed?.key !== "string" || typeof parsed.origin !== "string") throw new Error("Invalid key record.");
    const value = { key: parsed.key, origin: parsed.origin };
    this.cache.set(record, value);
    return value;
  }

  /** A key in settings.json comes first (it is what an older version saved last), then the saved
   * record, then the environment's. No key goes to a provider without a valid address. */
  private async resolveProvider(id: string, provider: StoredProviderSettings): Promise<ResolvedKey> {
    const environment = this.environment(id);
    // One the environment sets has its address and key from there, never a saved one (its ref waits).
    if (provider.source === "environment") return environment ? { state: "environment", key: environment.key } : { state: "unset" };
    const origin = this.origin(id, provider);
    const plaintext = typeof provider.apiKey === "string" ? provider.apiKey.trim() : "";
    if (plaintext && !(id === "lmstudio" && plaintext === LMSTUDIO_PLACEHOLDER)) return origin ? { state: "unprotected", key: plaintext } : { state: "address-changed" };
    if (provider.apiKeyRef) {
      const saved = await this.read(providerKeyRecord(id, provider.apiKeyRef)).catch(() => undefined);
      if (!saved) return { state: "unreadable" };
      return origin && saved.origin === origin ? { state: "set", key: saved.key } : { state: "address-changed" };
    }
    if (environment) return origin && environment.origin === origin ? { state: "environment", key: environment.key } : { state: "environment-address-changed" };
    return { state: "unset" };
  }

  private async resolveTelegram(telegram: AppSettings["telegram"]): Promise<ResolvedKey> {
    const plaintext = typeof telegram.botToken === "string" ? telegram.botToken.trim() : "";
    if (plaintext) return { state: "unprotected", key: plaintext };
    if (telegram.botTokenRef) {
      const saved = await this.read(telegramTokenRecord(telegram.botTokenRef)).catch(() => undefined);
      return saved ? { state: "set", key: saved.key } : { state: "unreadable" };
    }
    const environment = this.baseConfig.telegram.botToken?.trim();
    return environment ? { state: "environment", key: environment } : { state: "unset" };
  }
}
