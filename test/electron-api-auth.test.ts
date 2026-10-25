import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const { createApiToken, installApiAuth, withApiToken } = require(path.resolve("electron/api-auth.cjs"));

type Listener = (details: { url: string; requestHeaders: Record<string, string> }, callback: (response: { requestHeaders: Record<string, string> }) => void) => void;
const fakeSession = () => {
  const installed: Array<{ filter: { urls: string[] }; listener: Listener }> = [];
  return { installed, webRequest: { onBeforeSendHeaders: (filter: { urls: string[] }, listener: Listener) => { installed.push({ filter, listener }); } } };
};
const send = (listener: Listener, url: string, requestHeaders: Record<string, string> = {}) => {
  let result: { requestHeaders: Record<string, string> } | undefined;
  listener({ url, requestHeaders }, response => { result = response; });
  assert.ok(result, "the callback is called at once");
  return result!.requestHeaders;
};

test("the window's requests carry the launch's key only to the app's own origin, other headers kept", () => {
  const origin = "http://127.0.0.1:51234", token = createApiToken();
  const session = fakeSession();
  installApiAuth(session, origin, token);
  assert.equal(session.installed.length, 1);
  assert.deepEqual(session.installed[0]!.filter, { urls: ["http://127.0.0.1:51234/*"] });
  const listener = session.installed[0]!.listener;

  for (const url of [`${origin}/`, `${origin}/app/settings`, `${origin}/local/events`, `${origin}/assets/app.js?v=1#x`]) {
    assert.deepEqual(send(listener, url, { Accept: "text/event-stream", "X-Local-Cognitive": "1" }),
      { Accept: "text/event-stream", "X-Local-Cognitive": "1", Authorization: `Bearer ${token}` }, url);
  }
  // A header the page set is replaced, whatever its letter case.
  assert.deepEqual(send(listener, `${origin}/models`, { authorization: "Bearer page", Accept: "*/*" }), { Accept: "*/*", Authorization: `Bearer ${token}` });

  // Anything else gets nothing: another port, localhost or [::1] for the same port, https, a look-alike host.
  for (const url of ["http://127.0.0.1:51235/app/settings", "http://localhost:51234/app/settings", "http://[::1]:51234/app/settings",
    "https://127.0.0.1:51234/app/settings", "http://127.0.0.1:51234.evil.example/", "http://127.0.0.1.evil.example:51234/", "ws://127.0.0.1:51234/",
    "https://api.local-cognitive.com/v1/me", "not a url"]) {
    const headers = send(listener, url, { Accept: "*/*", Authorization: "Bearer theirs" });
    assert.deepEqual(headers, { Accept: "*/*", Authorization: "Bearer theirs" }, url);
  }
});

test("the key is new at every launch and only base64url", () => {
  const tokens = new Set(Array.from({ length: 20 }, () => createApiToken()));
  assert.equal(tokens.size, 20);
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  // A request's own headers object is never changed in place.
  const requestHeaders = { Accept: "*/*" };
  withApiToken({ url: "http://127.0.0.1:1/x", requestHeaders }, "http://127.0.0.1:1", "k".repeat(43));
  assert.deepEqual(requestHeaders, { Accept: "*/*" });
});
