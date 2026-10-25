// The backend's HTTP API answers only requests with this launch's key (src/api/localApiAuth.ts).
// The key lives in this process's memory: never in the environment (the backend's child processes
// inherit it), on disk or in the window's scripts. The window's requests get it from the network
// layer, so every kind of request has it: fetch, EventSource, module scripts, images, fonts.
const crypto = require("crypto");

/** A new key for one launch: 32 random bytes, base64url. */
const createApiToken = () => crypto.randomBytes(32).toString("base64url");

/** The request's headers, with the key added only for the app's own origin (exactly its scheme,
 * host and port: not another port of this computer, `localhost` or https). A header of the same
 * name, in any letter case, is replaced. */
const withApiToken = (details, origin, token) => {
  let target;
  try { target = new URL(details.url).origin; } catch { target = undefined; }
  const requestHeaders = { ...details.requestHeaders };
  if (target !== origin) return { requestHeaders };
  for (const name of Object.keys(requestHeaders)) if (name.toLowerCase() === "authorization") delete requestHeaders[name];
  requestHeaders.Authorization = `Bearer ${token}`;
  return { requestHeaders };
};

/** Adds the key to the session's requests for the app's origin. Electron keeps one such listener
 * per session: nothing else in the app sets onBeforeSendHeaders (Sentry uses onHeadersReceived). */
const installApiAuth = (session, origin, token) => {
  const exact = new URL(origin).origin;
  session.webRequest.onBeforeSendHeaders({ urls: [`${exact}/*`] }, (details, callback) => callback(withApiToken(details, exact, token)));
};

module.exports = { createApiToken, withApiToken, installApiAuth };
