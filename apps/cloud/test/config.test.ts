import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, loadDatabaseConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", AUTH0_ISSUER: "https://tenant.eu.auth0.com", AUTH0_AUDIENCE: "https://api.test" };

test("valid configuration is normalised", () => {
  const config = loadConfig({ ...base, PORT: "9090" });
  assert.equal(config.AUTH0_ISSUER, "https://tenant.eu.auth0.com/");
  assert.equal(config.PORT, 9090);
  assert.equal(config.HOST, "127.0.0.1");
  assert.equal(config.TRUST_PROXY, 0);
});

test("invalid configuration is rejected", () => {
  assert.throws(() => loadConfig({}), /Invalid cloud configuration/);
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: "mysql://u@localhost/db" }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ ...base, AUTH0_ISSUER: "http://tenant.eu.auth0.com/" }), /AUTH0_ISSUER/);
  assert.throws(() => loadConfig({ ...base, AUTH0_AUDIENCE: "" }), /AUTH0_AUDIENCE/);
  assert.throws(() => loadConfig({ ...base, PORT: "70000" }), /PORT/);
});

test("migrations need only the database and accept a mounted secret file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "database-url");
  fs.writeFileSync(file, "postgresql://u:p@db:5432/cloud\n");
  assert.equal(loadDatabaseConfig({ DATABASE_URL_FILE: file }).DATABASE_URL, "postgresql://u:p@db:5432/cloud");
});
