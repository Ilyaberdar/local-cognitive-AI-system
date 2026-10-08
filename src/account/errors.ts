export type AccountErrorCode =
  | "storage_unavailable" | "not_configured" | "callback_port_in_use" | "callback_port_unavailable" | "browser_open_failed"
  | "sign_in_timeout" | "authorization_denied" | "token_exchange_failed" | "id_token_invalid" | "refresh_unavailable"
  | "cloud_unreachable" | "network" | "session_expired" | "storage_failed" | "configuration";

// Fixed messages: provider error text never reaches the UI.
const messages: Record<AccountErrorCode, string> = {
  storage_unavailable: "Secure storage is unavailable on this device, so the session cannot be saved.",
  not_configured: "Sign-in is not configured in this build.",
  callback_port_in_use: "Another application is using port 17850 on this computer. Close it and try again.",
  callback_port_unavailable: "This computer does not allow the sign-in callback on port 17850. Check firewall or port reservations and try again.",
  browser_open_failed: "The web browser could not be opened. Check your default browser and try again.",
  sign_in_timeout: "Sign-in took too long. Try again.",
  authorization_denied: "Sign-in was cancelled or denied in the browser.",
  token_exchange_failed: "Sign-in could not be completed. Try again.",
  id_token_invalid: "The sign-in response could not be verified. Try again.",
  refresh_unavailable: "The sign-in response did not allow a persistent session. Contact support if this continues.",
  cloud_unreachable: "Local Cognitive Cloud is unreachable. Check your connection and try again.",
  network: "The sign-in service is unreachable. Check your connection and try again.",
  session_expired: "Your session has expired. Sign in again.",
  storage_failed: "The session could not be saved securely. Try again.",
  configuration: "Sign-in is misconfigured for this app. Contact support."
};

export class AccountError extends Error {
  constructor(readonly code: AccountErrorCode) { super(messages[code]); this.name = "AccountError"; }
}

export interface AccountProfile { accountId: string; email?: string; name?: string; emailVerified: boolean }

/** The only account data the renderer receives; never tokens. */
export type AccountStatus =
  | { state: "signed-out" }
  | { state: "signing-in" }
  | { state: "signed-in"; profile: AccountProfile; cloudReachable: boolean }
  | { state: "error"; error: { code: AccountErrorCode; message: string } };

export const errorStatus = (code: AccountErrorCode): AccountStatus => ({ state: "error", error: { code, message: messages[code] } });
