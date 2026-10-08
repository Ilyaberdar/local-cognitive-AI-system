import http, { Server } from "node:http";
import fs from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { auth, OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { withFileLock } from "../utils/fileStore";
import { sendAuthPage } from "../security/AuthCompletionPage";
import { CatalogPlugin, CredentialVault, PluginError, ServiceConnection } from "./contracts";

const clientSchema = z.object({ clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().max(2000).optional(), callbackPort: z.number().int().min(1024).max(65535).default(17849) }).strict();
export type OAuthClientSettings = z.infer<typeof clientSchema>;
type ClientSettings = OAuthClientSettings;
export type OAuthClientRegistrations = Readonly<Record<string, OAuthClientSettings>>;
interface SavedAuth { pluginId: string; redirect: string; client?: OAuthClientInformationMixed;
  settings?: ClientSettings; tokens?: OAuthTokens; expiresAt?: number; }
interface Flow { controller: AbortController; server?: Server; timer?: ReturnType<typeof setTimeout>; state: string;
  verifier: string; consumed: boolean; authorizationUrl?: string; }
interface NativeProvider { authorize: string; token: string; scopes: string; localhost?: boolean; }
const graph = (scopes: string): NativeProvider => ({ authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  token: "https://login.microsoftonline.com/common/oauth2/v2.0/token", scopes: `offline_access User.Read ${scopes}`, localhost: true });
export const nativeProviders: Record<string, NativeProvider> = {
  github: { authorize: "https://github.com/login/oauth/authorize", token: "https://github.com/login/oauth/access_token", scopes: "repo read:user offline_access" },
  slack: { authorize: "https://slack.com/oauth/v2/authorize", token: "https://slack.com/api/oauth.v2.access",
    scopes: "search:read,channels:read,channels:history,groups:read,groups:history,chat:write", localhost: true },
  "google-drive": { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token",
    scopes: "https://www.googleapis.com/auth/drive" },
  "outlook-email": graph("Mail.ReadWrite Mail.Send"),
  "outlook-calendar": graph("Calendars.ReadWrite"),
  teams: graph("Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send"),
  dropbox: { authorize: "https://www.dropbox.com/oauth2/authorize", token: "https://api.dropboxapi.com/oauth2/token",
    scopes: "account_info.read files.metadata.read files.content.read files.content.write" }
};
const safeEqual = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const random = () => randomBytes(32).toString("base64url");

/** Application-owned public/native registrations, supplied once by the distributor.
 * Never use confidential web-client secrets in this desktop configuration. */
export async function loadOAuthClientRegistrations(file: string): Promise<OAuthClientRegistrations> {
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const records = z.record(z.string(), clientSchema).parse(JSON.parse(raw));
  if (Object.keys(records).some(id => !Object.hasOwn(nativeProviders, id))) throw new Error("Unknown OAuth application registration.");
  return records;
}

/** All authorization is initiated explicitly. Refresh can never open a browser.
 * PKCE and state live only in memory, with a single-use loopback callback and TTL. */
export class OAuthConnections {
  private readonly flows = new Map<string, Flow>();
  private readonly revoked = new Set<string>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private closed = false;
  constructor(private readonly vault: CredentialVault, readonly ownerId: string, private readonly registrations: OAuthClientRegistrations = {}) {}
  available() { return this.vault.available(); }
  unavailableReason() { return this.vault.unavailableReason?.(); }
  private key(id: string) { return `owners/${this.ownerId}/connections/${id}`; }
  private configKey(plugin: CatalogPlugin) { return `owners/${this.ownerId}/oauth-clients/${plugin.id}`; }
  private async settings(plugin: CatalogPlugin): Promise<ClientSettings | undefined> {
    if (Object.hasOwn(this.registrations, plugin.id)) return clientSchema.parse(this.registrations[plugin.id]);
    const value = await this.vault.read(this.configKey(plugin));
    return value ? clientSchema.parse(JSON.parse(value)) : undefined;
  }
  async configure(plugin: CatalogPlugin, input: unknown) {
    if (!nativeProviders[plugin.id]) throw new PluginError("This service registers its OAuth client automatically.");
    if (Object.hasOwn(this.registrations, plugin.id)) throw new PluginError("This application registration is managed by the distributor.", 409);
    const settings = clientSchema.parse(input);
    const previous = await this.settings(plugin);
    if (settings.clientSecret === undefined && previous?.clientId === settings.clientId) settings.clientSecret = previous.clientSecret;
    // Client secrets are only needed by some desktop registrations (e.g. Google).
    // This legacy operator override is encrypted and never returned through HTTP.
    // Distribution config may include only public/native application credentials.
    await this.vault.write(this.configKey(plugin), JSON.stringify(settings));
    return this.configuration(plugin);
  }
  async configuration(plugin: CatalogPlugin) {
    const configured = this.available() ? await this.settings(plugin) : undefined;
    return { required: !!nativeProviders[plugin.id], configured: !!configured || !nativeProviders[plugin.id],
      clientId: configured?.clientId, hasClientSecret: !!configured?.clientSecret,
      callbackUrl: `http://${nativeProviders[plugin.id]?.localhost ? "localhost" : "127.0.0.1"}:${configured?.callbackPort ?? 17849}/oauth/callback`,
      scopes: nativeProviders[plugin.id]?.scopes,
      message: plugin.id === "github" ? "Register an OAuth app and enable Device Flow. Only the public Client ID is required."
        : plugin.id === "slack" ? "Register a Slack app, enable PKCE (public desktop client), add this redirect and the listed user scopes. No bot scopes or client secret. Workspace approval may be required."
        : plugin.id === "google-drive" ? "Register a Google Desktop OAuth client, enable Drive API and configure the consent screen/test users. Enter the downloaded client ID and desktop client secret."
        : ["outlook-email", "outlook-calendar", "teams"].includes(plugin.id) ? "Register a public desktop app in Microsoft Entra with this localhost redirect and delegated Graph permissions. Teams requires a work/school tenant and may require admin consent."
        : plugin.id === "dropbox" ? "Register a scoped Dropbox app, add this redirect and enable the listed permissions. The App key is the public Client ID."
        : "OAuth client registration is negotiated directly with the service (PKCE)." };
  }
  private assertActive(id: string) {
    if (this.closed || this.revoked.has(id)) throw new PluginError("Connection was cancelled. Start a new connection.");
  }
  private async load(id: string): Promise<SavedAuth | undefined> {
    this.assertActive(id);
    const raw = await this.vault.read(this.key(id));
    return raw ? JSON.parse(raw) as SavedAuth : undefined;
  }
  private async save(id: string, value: SavedAuth) {
    await withFileLock(this.key(id), async () => { this.assertActive(id); await this.vault.write(this.key(id), JSON.stringify(value)); });
  }
  private tokens(record: SavedAuth, tokens: OAuthTokens) {
    record.tokens = { ...tokens, refresh_token: tokens.refresh_token ?? record.tokens?.refresh_token };
    record.expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
  }
  private stop(id: string) {
    const flow = this.flows.get(id);
    if (!flow) return;
    flow.controller.abort(); if (flow.timer) clearTimeout(flow.timer);
    flow.server?.close(); flow.server?.closeAllConnections(); this.flows.delete(id);
  }
  pending(id: string) { return this.flows.has(id); }
  async connected(id: string) { return !!(await this.load(id))?.tokens?.access_token; }
  async begin(plugin: CatalogPlugin, id: string) {
    if (!this.available()) throw new PluginError(this.unavailableReason() ?? "Open the desktop app with protected storage available to connect accounts.", 503);
    this.assertActive(id);
    const settings = nativeProviders[plugin.id] ? await this.settings(plugin) : undefined;
    if (nativeProviders[plugin.id] && !settings) throw new PluginError(`${plugin.name} sign-in is not available in this build. The application developer must finish this integration; you do not need to register another account.`, 503);
    const flow: Flow = { controller: new AbortController(), state: random(), verifier: random(), consumed: false };
    this.flows.set(id, flow);
    flow.timer = setTimeout(() => this.stop(id), 10 * 60_000); flow.timer.unref();
    try {
      if (plugin.id === "github") return await this.deviceFlow(plugin, id, settings!, flow);
      const record: SavedAuth = { pluginId: plugin.id, redirect: "", settings };
      flow.server = http.createServer((request, response) => {
        const url = new URL(request.url ?? "/", record.redirect);
        const expectedHost = new URL(record.redirect).host;
        if (request.method !== "GET" || request.headers.host !== expectedHost || url.pathname !== "/oauth/callback" ||
            !safeEqual(url.searchParams.get("state") ?? "", flow.state) || flow.consumed) {
          sendAuthPage(response, 400, { outcome: "failure", title: "Invalid or expired authorization", message: "Return to Local Cognitive and connect again." }); return;
        }
        flow.consumed = true;
        void (async () => {
          try {
            const code = url.searchParams.get("code");
            if (!code || code.length > 8192 || url.searchParams.has("error")) throw new Error("Authorization denied");
            if (plugin.mcpEndpoint) await auth(this.mcpProvider(plugin, id, record, flow), {
              serverUrl: plugin.mcpEndpoint, authorizationCode: code, fetchFn: this.oauthFetch(plugin, flow.controller.signal) });
            else await this.exchange(plugin, id, record, { grant_type: "authorization_code", code,
              redirect_uri: record.redirect, code_verifier: flow.verifier }, flow.controller.signal);
            // Shown only after the credential is stored; the app still inspects the connection.
            sendAuthPage(response, 200, { outcome: "success", title: `${plugin.name} authorized`, message: "Return to Local Cognitive and check the connection before enabling it." });
          } catch { sendAuthPage(response, 400, { outcome: "failure", title: "Could not connect", message: "Authorization failed or was cancelled. Return to Local Cognitive and reconnect." }); }
          finally { this.stop(id); }
        })();
      });
      await new Promise<void>((resolve, reject) => {
        flow.server!.once("error", reject);
        flow.server!.listen(settings?.callbackPort ?? 0, "127.0.0.1", () => resolve());
      });
      const address = flow.server.address();
      if (!address || typeof address === "string") throw new Error("No callback listener");
      record.redirect = `http://${nativeProviders[plugin.id]?.localhost ? "localhost" : "127.0.0.1"}:${address.port}/oauth/callback`;
      if (plugin.mcpEndpoint) await auth(this.mcpProvider(plugin, id, record, flow), { serverUrl: plugin.mcpEndpoint, fetchFn: this.oauthFetch(plugin, flow.controller.signal) });
      else {
        const provider = nativeProviders[plugin.id], url = new URL(provider.authorize);
        for (const [name, value] of Object.entries({ response_type: "code", client_id: settings!.clientId, redirect_uri: record.redirect,
          state: flow.state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(flow.verifier).digest("base64url") })) url.searchParams.set(name, value);
        url.searchParams.set(plugin.id === "slack" ? "user_scope" : "scope", provider.scopes);
        if (plugin.id === "dropbox") url.searchParams.set("token_access_type", "offline");
        if (plugin.id === "google-drive") { url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "consent"); }
        if (["outlook-email", "outlook-calendar", "teams"].includes(plugin.id)) url.searchParams.set("prompt", "select_account");
        flow.authorizationUrl = url.href; await this.save(id, record);
      }
      if (!flow.authorizationUrl) throw new Error("Provider did not start authorization");
      return { accountRef: id, authorizationUrl: flow.authorizationUrl };
    } catch { this.stop(id); throw new PluginError("Could not start OAuth. Check the service setup and network; close any earlier login using the callback port and try again.", 502); }
  }
  private oauthFetch(plugin: CatalogPlugin, signal?: AbortSignal): typeof fetch {
    const domains = plugin.id === "notion" ? ["notion.com", "notion.so"] : plugin.id === "linear" ? ["linear.app"] : ["atlassian.com", "atlassian.net"];
    return (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== "https:" || url.username || url.password || !domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new PluginError("Provider returned an untrusted OAuth endpoint.");
      return fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]) });
    };
  }
  private mcpProvider(plugin: CatalogPlugin, id: string, record: SavedAuth, flow?: Flow): OAuthClientProvider {
    return {
      redirectUrl: record.redirect,
      clientMetadata: { client_name: "Local Cognitive", redirect_uris: [record.redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
      state: () => { if (!flow) throw new PluginError("Login expired. Reconnect the account.", 401); return flow.state; },
      clientInformation: () => record.client,
      saveClientInformation: async client => { record.client = client; await this.save(id, record); },
      tokens: () => record.tokens,
      saveTokens: async tokens => { this.tokens(record, tokens); await this.save(id, record); },
      redirectToAuthorization: url => {
        if (!flow) throw new PluginError("Login expired. Reconnect the account.", 401);
        // Validate before handing an address to the OS browser.
        const expected = plugin.id === "notion" ? /(^|\.)notion\.(com|so)$/ : plugin.id === "linear" ? /(^|\.)linear\.app$/ : /(^|\.)atlassian\.com$/;
        if (url.protocol !== "https:" || url.username || url.password || !expected.test(url.hostname)) throw new PluginError("Untrusted authorization address.");
        flow.authorizationUrl = url.href;
      },
      saveCodeVerifier: value => { if (!flow) throw new Error("Interactive authorization required"); flow.verifier = value; },
      codeVerifier: () => { if (!flow) throw new Error("Authorization expired"); return flow.verifier; },
      invalidateCredentials: async scope => {
        if (scope === "all" || scope === "client") delete record.client;
        if (scope === "all" || scope === "tokens") { delete record.tokens; delete record.expiresAt; }
        await this.save(id, record);
      }
    };
  }
  private async exchange(plugin: CatalogPlugin, id: string, record: SavedAuth, parameters: Record<string, string>, signal?: AbortSignal) {
    const settings = record.settings!;
    const body = new URLSearchParams({ client_id: settings.clientId, ...parameters });
    if (settings.clientSecret && plugin.id === "google-drive") body.set("client_secret", settings.clientSecret);
    const response = await fetch(nativeProviders[plugin.id].token, { method: "POST", body, redirect: "error",
      headers: { Accept: "application/json" }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]) });
    const json = await response.json() as Record<string, any>;
    if (!response.ok || json.error || json.ok === false) throw new PluginError("Authorization expired or was rejected. Reconnect the account.", 401);
    const tokens = plugin.id === "slack" && json.authed_user ? json.authed_user : json;
    if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new PluginError("Service did not return an access token.", 401);
    this.tokens(record, tokens as OAuthTokens); await this.save(id, record);
  }
  private async deviceFlow(plugin: CatalogPlugin, id: string, settings: ClientSettings, flow: Flow) {
    const response = await fetch("https://github.com/login/device/code", { method: "POST", redirect: "error", headers: { Accept: "application/json" },
      body: new URLSearchParams({ client_id: settings.clientId, scope: nativeProviders.github.scopes }), signal: AbortSignal.any([flow.controller.signal, AbortSignal.timeout(20_000)]) });
    const device = await response.json() as Record<string, any>;
    if (!response.ok || typeof device.device_code !== "string" || typeof device.user_code !== "string") throw new Error("Device flow not enabled");
    const record: SavedAuth = { pluginId: plugin.id, redirect: "", settings };
    await this.save(id, record);
    void (async () => {
      let interval = Math.max(5, Number(device.interval) || 5);
      try {
        while (!flow.controller.signal.aborted) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
            const timer = setTimeout(() => { flow.controller.signal.removeEventListener("abort", abort); resolve(); }, interval * 1000);
            flow.controller.signal.addEventListener("abort", abort, { once: true });
          });
          const tokenResponse = await fetch(nativeProviders.github.token, { method: "POST", redirect: "error", headers: { Accept: "application/json" },
            body: new URLSearchParams({ client_id: settings.clientId, device_code: device.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
            signal: AbortSignal.any([flow.controller.signal, AbortSignal.timeout(20_000)]) });
          const tokens = await tokenResponse.json() as OAuthTokens & { error?: string };
          if (tokens.error === "authorization_pending") continue;
          if (tokens.error === "slow_down") { interval += 5; continue; }
          if (!tokenResponse.ok || !tokens.access_token || tokens.error) break;
          this.tokens(record, tokens); await this.save(id, record); break;
        }
      } catch { /* UI displays reconnect, never raw token endpoint errors. */ }
      finally { this.stop(id); }
    })();
    return { accountRef: id, authorizationUrl: "https://github.com/login/device", userCode: device.user_code as string };
  }
  async accessToken(plugin: CatalogPlugin, connection: ServiceConnection): Promise<string> {
    if (connection.ownerId !== this.ownerId || connection.accountRef !== connection.id) throw new PluginError("Account belongs to another profile.", 403);
    const existing = this.refreshing.get(connection.id); if (existing) return existing;
    const operation = (async () => {
      const record = await this.load(connection.id);
      if (record?.pluginId !== plugin.id || !record.tokens?.access_token) throw new PluginError("Connect this account first.", 401);
      if (record.expiresAt && record.expiresAt < Date.now() + 60_000) {
        if (!record.tokens.refresh_token) throw new PluginError("Login expired. Reconnect the account.", 401);
        if (plugin.mcpEndpoint) {
          await auth(this.mcpProvider(plugin, connection.id, record), { serverUrl: plugin.mcpEndpoint, fetchFn: this.oauthFetch(plugin) });
        } else await this.exchange(plugin, connection.id, record, { grant_type: "refresh_token", refresh_token: record.tokens.refresh_token });
      }
      this.assertActive(connection.id); return record.tokens!.access_token;
    })().finally(() => this.refreshing.delete(connection.id));
    this.refreshing.set(connection.id, operation); return operation;
  }
  async remove(id: string) {
    this.revoked.add(id); this.stop(id);
    await withFileLock(this.key(id), () => this.vault.remove(this.key(id)));
  }
  dispose() { this.closed = true; for (const id of this.flows.keys()) this.stop(id); }
}
