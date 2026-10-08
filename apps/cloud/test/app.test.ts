import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet } from "jose";
import type pg from "pg";
import { createApp } from "../src/app.js";
import { MIGRATIONS_DIR } from "../src/paths.js";
import { listen } from "./helpers/testServer.js";

const auth = { issuer: "https://tenant.example.auth0.com/", audience: "https://api.test", keys: createLocalJWKSet({ keys: [] }) };

const get = async (pool: Pick<pg.Pool, "query">, path: string) => {
  const server = await listen(createApp({ pool, auth }));
  try { const response = await fetch(`${server.url}${path}`); return { status: response.status, body: await response.json() }; }
  finally { await server.close(); }
};

test("health reports database availability", async () => {
  assert.deepEqual(await get({ query: async () => ({ rows: [] }) } as never, "/health"), { status: 200, body: { status: "ok", db: "up" } });
  assert.deepEqual(await get({ query: async () => { throw new Error("down"); } } as never, "/health"), { status: 503, body: { status: "degraded", db: "down" } });
});

test("unknown routes return JSON 404", async () => {
  assert.deepEqual(await get({ query: async () => ({ rows: [] }) } as never, "/nope"), { status: 404, body: { error: "not_found" } });
});

test("migrations are found next to the package", () => {
  assert.match(MIGRATIONS_DIR, /apps[\\/]cloud[\\/]migrations$/);
});
