import { EventEmitter } from "events";
import type { ServerResponse } from "http";
import { z } from "zod";
import type { CredentialVault } from "../plugins/contracts";
import { sendAuthPage } from "../security/AuthCompletionPage";
import type { AccountConfig } from "./accountConfig";
import { openLoopback, LoopbackServer } from "./AuthCallbackServer";
import { AccountError, AccountProfile, AccountStatus, errorStatus } from "./errors";
import {
  buildAuthorizeUrl, FetchLike, IdTokenClaims, pkcePair, randomToken, revokeRefreshToken, safeEqual, SignInMethod,
  TokenEndpointError, TokenResponse, tokenRequest, validateIdToken
} from "./oidc";

const SESSION_KEY = "account/session";
const profileSchema = z.object({ name: z.string().optional(), email: z.string().optional(), emailVerified: z.boolean() }).strict();
const recordSchema = z.object({
  v: z.literal(1), issuer: z.string(), clientId: z.string(), audience: z.string(), subject: z.string().min(1),
  accountId: z.string().min(1), refreshToken: z.string().min(1), profile: profileSchema, updatedAt: z.number()
}).strict();
type SessionRecord = z.infer<typeof recordSchema>;
type Profile = z.infer<typeof profileSchema>;

interface Attempt { id: string; state: string; nonce: string; verifier: string; consumed: boolean; redirectUri?: string; server?: LoopbackServer; timer?: NodeJS.Timeout }
interface MeProfile { accountId: string; email?: string; emailVerified: boolean; displayName?: string }
class CloudUnavailable extends Error {}

export interface AccountServiceOptions {
  config: AccountConfig;
  vault: CredentialVault;
  openExternal(url: string): Promise<void>;
  /** Brings the app to the front after the browser step. */
  onCompleted?(): void;
  fetch?: FetchLike;
  now?: () => number;
  signInTimeoutMs?: number;
}

/** Local Cognitive account session in the main process. The refresh token lives only in the
 * OS-protected vault and the access token only in memory; the renderer receives AccountStatus.
 * It has no access to the runtime, so login never changes integration ownership. */
export class AccountService extends EventEmitter {
  private record?: SessionRecord;
  private accessToken?: string;
  private accessExpiresAt = 0;
  private cloudReachable = true;
  private failure?: AccountStatus;
  private attempt?: Attempt;
  // Incremented by sign-out: work started earlier must not resurrect the session.
  private generation = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private refreshing?: Promise<void>;
  private refreshTimer?: NodeJS.Timeout;
  private backoffMs = 30_000;
  private lastProfileCheck = 0;
  private readonly completed = new Map<string, number>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly options: AccountServiceOptions) {
    super();
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  status(): AccountStatus {
    if (this.attempt) return { state: "signing-in" };
    if (this.record) return { state: "signed-in", profile: this.profile(this.record), cloudReachable: this.cloudReachable };
    return this.failure ?? { state: "signed-out" };
  }

  /** Status for the UI; re-checks Cloud when the email is unverified or Cloud was unreachable. */
  async refreshStatus(): Promise<AccountStatus> {
    if (this.record && (!this.record.profile.emailVerified || !this.cloudReachable) && this.now() - this.lastProfileCheck >= 10_000) await this.refreshNow();
    return this.status();
  }

  async init(): Promise<void> {
    if (!this.options.vault.available()) return;
    let parsed: SessionRecord | undefined;
    try {
      const raw = await this.options.vault.read(SESSION_KEY);
      if (!raw) return;
      const result = recordSchema.safeParse(JSON.parse(raw));
      const { config } = this.options;
      if (result.success && result.data.issuer === config.issuer && result.data.clientId === config.clientId && result.data.audience === config.audience) parsed = result.data;
    } catch { /* An unreadable record is discarded below. */ }
    if (!parsed) { await this.persist(() => this.options.vault.remove(SESSION_KEY)).catch(() => {}); return; }
    this.record = parsed;
    this.emitChange();
    void this.refreshNow();
  }

  async signIn(method: SignInMethod): Promise<AccountStatus> {
    if (this.record) return this.status();
    if (this.attempt) this.finishAttempt(this.attempt);
    if (!this.options.vault.available()) return this.fail("storage_unavailable");
    if (!this.options.config.cloudUrl) return this.fail("not_configured");
    const { verifier, challenge } = pkcePair();
    const attempt: Attempt = { id: randomToken(16), state: randomToken(), nonce: randomToken(), verifier, consumed: false };
    this.failure = undefined;
    this.attempt = attempt;
    try {
      attempt.server = await openLoopback({ port: this.options.config.callbackPort, path: "/callback", handle: (url, response) => void this.handleCallback(attempt, url, response) });
      if (this.attempt !== attempt) { attempt.server.close(); return this.status(); }
      attempt.redirectUri = attempt.server.redirectUri;
      attempt.timer = setTimeout(() => this.finishAttempt(attempt, errorStatus("sign_in_timeout")), this.options.signInTimeoutMs ?? 10 * 60_000);
      attempt.timer.unref();
      const url = buildAuthorizeUrl(this.options.config, { redirectUri: attempt.redirectUri, state: attempt.state, nonce: attempt.nonce, challenge, method });
      if (!url.startsWith(`${this.options.config.authority}/authorize?`)) throw new AccountError("configuration");
      try { await this.options.openExternal(url); } catch { throw new AccountError("browser_open_failed"); }
      this.emitChange();
    } catch (error) {
      this.finishAttempt(attempt, errorStatus(error instanceof AccountError ? error.code : "network"));
    }
    return this.status();
  }

  cancelSignIn(): AccountStatus {
    if (this.attempt) this.finishAttempt(this.attempt);
    else if (this.failure) { this.failure = undefined; this.emitChange(); }
    return this.status();
  }

  async signOut(): Promise<AccountStatus> {
    this.generation++;
    if (this.attempt) this.finishAttempt(this.attempt);
    const record = this.record;
    this.clearSession();
    this.failure = undefined;
    this.emitChange();
    await this.persist(() => this.options.vault.remove(SESSION_KEY)).catch(() => { /* A stale record fails config checks or refresh later. */ });
    if (record) await revokeRefreshToken(this.options.config, record.refreshToken, this.fetchImpl);
    return this.status();
  }

  /** For main-process callers (Cloud requests). Never exposed to the renderer. */
  async getAccessToken(): Promise<string> {
    if (this.record && this.accessToken && this.accessExpiresAt - this.now() > 60_000) return this.accessToken;
    await this.refreshNow();
    if (!this.record) throw new AccountError("session_expired");
    if (!this.accessToken) throw new AccountError("network");
    return this.accessToken;
  }

  /** Called for localcognitive://auth/complete/<id>; it only refreshes the UI. */
  acknowledgeCompletion(id: string): void {
    for (const [key, expires] of this.completed) if (expires < this.now()) this.completed.delete(key);
    if (this.completed.delete(id)) this.emitChange();
  }

  refreshNow(): Promise<void> {
    if (!this.record) return Promise.resolve();
    return this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined; });
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    if (this.attempt) this.finishAttempt(this.attempt);
    this.removeAllListeners();
  }

  private profile(record: SessionRecord): AccountProfile {
    return { accountId: record.accountId, ...record.profile };
  }

  private fail(code: Parameters<typeof errorStatus>[0]): AccountStatus {
    this.failure = errorStatus(code);
    this.emitChange();
    return this.failure;
  }

  private emitChange(): void { this.emit("change", this.status()); }

  /** Serialises vault writes so an older write cannot overwrite a newer one. */
  private persist<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private finishAttempt(attempt: Attempt, failure?: AccountStatus, keepServerOpen = false): void {
    if (this.attempt !== attempt) return;
    this.attempt = undefined;
    clearTimeout(attempt.timer);
    if (!keepServerOpen) attempt.server?.close();
    this.failure = failure;
    this.emitChange();
  }

  private clearSession(): void {
    this.record = undefined;
    this.accessToken = undefined;
    this.accessExpiresAt = 0;
    this.cloudReachable = true;
    this.backoffMs = 30_000;
    clearTimeout(this.refreshTimer);
  }

  private async dropSession(failure: AccountStatus): Promise<void> {
    this.clearSession();
    this.failure = failure;
    this.emitChange();
    await this.persist(() => this.options.vault.remove(SESSION_KEY)).catch(() => undefined);
  }

  private setAccessToken(tokens: TokenResponse): void {
    this.accessToken = tokens.access_token;
    this.accessExpiresAt = this.now() + tokens.expires_in * 1000;
  }

  private scheduleRefresh(delayMs = Math.max(30_000, this.accessExpiresAt - this.now() - 5 * 60_000)): void {
    clearTimeout(this.refreshTimer);
    if (!this.record) return;
    this.refreshTimer = setTimeout(() => void this.refreshNow(), delayMs);
    this.refreshTimer.unref();
  }

  private markUnreachable(): void {
    this.cloudReachable = false;
    this.scheduleRefresh(this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 15 * 60_000);
    this.emitChange();
  }

  private async fetchMe(accessToken: string): Promise<MeProfile> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.config.cloudUrl}/v1/me`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch { throw new CloudUnavailable(); }
    if (!response.ok) throw new CloudUnavailable();
    const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (typeof body?.accountId !== "string" || !body.accountId) throw new CloudUnavailable();
    return { accountId: body.accountId, email: typeof body.email === "string" ? body.email : undefined,
      emailVerified: body.emailVerified === true, displayName: typeof body.displayName === "string" ? body.displayName : undefined };
  }

  // Cloud is authoritative for verification; the ID token only fills display fields it lacks.
  private profileFrom(me: MeProfile, claims?: IdTokenClaims, previous?: Profile): Profile {
    const name = me.displayName ?? claims?.name ?? previous?.name, email = me.email ?? claims?.email ?? previous?.email;
    return { ...(name ? { name } : {}), ...(email ? { email } : {}), emailVerified: me.emailVerified };
  }

  private async handleCallback(attempt: Attempt, url: URL, response: ServerResponse): Promise<void> {
    const single = (name: string) => { const values = url.searchParams.getAll(name); return values.length === 1 ? values[0] : undefined; };
    const state = single("state"), issuers = url.searchParams.getAll("iss");
    // An invalid request does not consume the attempt: the genuine redirect can still arrive.
    if (this.attempt !== attempt || attempt.consumed || !state || !safeEqual(state, attempt.state) || url.searchParams.getAll("code").length > 1 ||
        issuers.length > 1 || (issuers.length === 1 && issuers[0] !== this.options.config.issuer)) {
      sendAuthPage(response, 400, { outcome: "failure", title: "Sign-in link expired", message: "Start sign-in again from Local Cognitive." });
      return;
    }
    attempt.consumed = true;
    const generation = this.generation, { config } = this.options;
    let tokens: TokenResponse | undefined, failure: AccountStatus | undefined;
    try {
      if (url.searchParams.has("error")) throw new AccountError("authorization_denied");
      const code = single("code");
      if (!code || code.length > 4096) throw new AccountError("token_exchange_failed");
      try { tokens = await tokenRequest(config, { grant_type: "authorization_code", code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri! }, this.fetchImpl); }
      catch (error) { throw new AccountError(error instanceof TokenEndpointError && error.transient ? "network" : "token_exchange_failed"); }
      if (!tokens.id_token) throw new AccountError("id_token_invalid");
      const claims = validateIdToken(tokens.id_token, config, { nonce: attempt.nonce, now: this.now() });
      if (!tokens.refresh_token) throw new AccountError("refresh_unavailable");
      // Sign-in completes only when Cloud has mapped the identity to an account.
      const me = await this.fetchMe(tokens.access_token).catch(() => { throw new AccountError("cloud_unreachable"); });
      const record: SessionRecord = { v: 1, issuer: config.issuer, clientId: config.clientId, audience: config.audience, subject: claims.sub,
        accountId: me.accountId, refreshToken: tokens.refresh_token, profile: this.profileFrom(me, claims), updatedAt: this.now() };
      await this.persist(async () => {
        if (generation !== this.generation || this.attempt !== attempt) throw new AccountError("authorization_denied");
        await this.options.vault.write(SESSION_KEY, JSON.stringify(record));
      }).catch((error: unknown) => { throw error instanceof AccountError ? error : new AccountError("storage_failed"); });
      this.record = record;
      this.setAccessToken(tokens);
      this.cloudReachable = true;
      this.lastProfileCheck = this.now();
      this.completed.set(attempt.id, this.now() + 5 * 60_000);
      sendAuthPage(response, 200, { outcome: "success", title: "You’re signed in", message: "Local Cognitive is now connected to your account.",
        appLink: `localcognitive://auth/complete/${attempt.id}` });
    } catch (error) {
      failure = errorStatus(error instanceof AccountError ? error.code : "token_exchange_failed");
      if (tokens?.refresh_token) void revokeRefreshToken(config, tokens.refresh_token, this.fetchImpl);
      sendAuthPage(response, 400, { outcome: "failure", title: "Could not sign in", message: failure.state === "error" ? failure.error.message : "" });
    }
    // Close the listener after the page is delivered, not before.
    const close = () => attempt.server?.close();
    response.once("finish", close);
    response.once("close", close);
    this.finishAttempt(attempt, failure, true);
    if (!failure) this.scheduleRefresh();
    this.options.onCompleted?.();
  }

  private async refresh(): Promise<void> {
    const record = this.record!, generation = this.generation, { config } = this.options;
    let tokens: TokenResponse;
    try { tokens = await tokenRequest(config, { grant_type: "refresh_token", refresh_token: record.refreshToken }, this.fetchImpl); }
    catch (error) {
      if (generation !== this.generation || this.record !== record) return;
      if (error instanceof TokenEndpointError && !error.transient) {
        if (error.oauthError === "invalid_client" || error.oauthError === "unauthorized_client") await this.dropSession(errorStatus("configuration"));
        else await this.dropSession(errorStatus("session_expired"));
        return;
      }
      this.markUnreachable();
      return;
    }
    if (generation !== this.generation || this.record !== record) {
      if (tokens.refresh_token) void revokeRefreshToken(config, tokens.refresh_token, this.fetchImpl);
      return;
    }
    let claims: IdTokenClaims | undefined;
    if (tokens.id_token) {
      try { claims = validateIdToken(tokens.id_token, config, { subject: record.subject, now: this.now() }); }
      catch { await this.dropSession(errorStatus("id_token_invalid")); return; }
    }
    let next: SessionRecord = { ...record, refreshToken: tokens.refresh_token ?? record.refreshToken, updatedAt: this.now() };
    const save = (value: SessionRecord) => this.persist(async () => {
      if (generation !== this.generation) throw new AccountError("session_expired");
      await this.options.vault.write(SESSION_KEY, JSON.stringify(value));
    });
    // A rotated refresh token replaces the old one at Auth0: store it before using the access token.
    if (next.refreshToken !== record.refreshToken) await save(next).catch(() => undefined);
    if (generation !== this.generation) return;
    this.record = next;
    this.setAccessToken(tokens);
    try {
      const me = await this.fetchMe(tokens.access_token);
      if (generation !== this.generation) return;
      const profile = this.profileFrom(me, claims, next.profile);
      if (me.accountId !== next.accountId || JSON.stringify(profile) !== JSON.stringify(next.profile)) {
        next = { ...next, accountId: me.accountId, profile };
        this.record = next;
        await save(next).catch(() => undefined);
      }
      this.cloudReachable = true;
      this.backoffMs = 30_000;
      this.lastProfileCheck = this.now();
      this.scheduleRefresh();
      this.emitChange();
    } catch {
      this.lastProfileCheck = this.now();
      if (generation === this.generation) this.markUnreachable();
    }
  }
}
