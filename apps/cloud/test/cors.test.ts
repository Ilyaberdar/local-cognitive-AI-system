import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createLocalJWKSet } from "jose";
import type pg from "pg";
import { createApp } from "../src/app.js";
import { listen } from "./helpers/testServer.js";

const auth = { issuer: "https://tenant.example.auth0.com/", audience: "https://api.test", keys: createLocalJWKSet({ keys: [] }) };
const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
const site = "https://local-cognitive.com", other = "https://evil.example";

/** The status with only the CORS headers and Vary, so an unexpected header fails the comparison. */
const send = async (path: string, init: RequestInit = {}) => {
  const server = await listen(createApp({ pool, auth, corsOrigins: [site] }));
  try {
    const response = await fetch(`${server.url}${path}`, init);
    await response.arrayBuffer();
    return { status: response.status, headers: Object.fromEntries([...response.headers].filter(([name]) => name === "vary" || name.startsWith("access-control-"))) };
  } finally { await server.close(); }
};
const preflight = (origin?: string) => send(`/v1/hosts/${randomUUID()}/devices/${randomUUID()}`, { method: "OPTIONS",
  headers: { ...(origin ? { origin } : {}), "access-control-request-method": "DELETE", "access-control-request-headers": "authorization" } });

test("an allowed origin gets the headers on error responses too", async () => {
  const headers = { "access-control-allow-origin": site, "access-control-expose-headers": "Retry-After", vary: "Origin" };
  assert.deepEqual(await send("/v1/me", { headers: { origin: site } }), { status: 401, headers });
  assert.deepEqual(await send("/v1/usage/events:batch", { method: "POST", headers: { origin: site, "content-type": "application/json" }, body: "{" }),
    { status: 400, headers });
});

test("a preflight from an allowed origin is answered before auth", async () => {
  assert.deepEqual(await preflight(site), { status: 204, headers: { "access-control-allow-origin": site, "access-control-allow-methods": "GET, DELETE",
    "access-control-allow-headers": "Authorization", "access-control-max-age": "600", vary: "Origin" } });
});

test("other origins, or none, get no CORS headers but still Vary", async () => {
  for (const origin of [other, undefined]) assert.deepEqual(await preflight(origin), { status: 204, headers: { vary: "Origin" } }, origin);
  assert.deepEqual(await send("/v1/me", { headers: { origin: other } }), { status: 401, headers: { vary: "Origin" } });
});

test("health is outside /v1 and untouched", async () => {
  assert.deepEqual(await send("/health", { headers: { origin: site } }), { status: 200, headers: {} });
});
