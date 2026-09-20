import assert from "node:assert/strict";
import test from "node:test";
import { compileToolArguments, snapshotArguments } from "../src/mcp/client/schema";

test("MCP argument validation honors Draft 2020-12 tuples and unevaluated properties", () => {
  const validate = compileToolArguments({
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
    properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false, minItems: 2 } },
    required: ["pair"], unevaluatedProperties: false
  });
  assert.equal(validate({ pair: ["x", 1] }), true);
  assert.equal(validate({ pair: [1, "x"] }), false);
  assert.equal(validate({ pair: ["x", 1, 2] }), false);
  assert.equal(validate({ pair: ["x", 1], extra: true }), false);
});

test("MCP supports explicit Draft 7 and 2019-09 schemas without coercing or mutating arguments", () => {
  const old = compileToolArguments({
    $schema: "http://json-schema.org/draft-07/schema#", type: "object",
    properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }], additionalItems: false } }, required: ["pair"]
  });
  assert.equal(old({ pair: ["x", 1] }), true);
  assert.equal(old({ pair: ["x", "1"] }), false);
  const modern = compileToolArguments({
    $schema: "https://json-schema.org/draft/2019-09/schema", type: "object",
    properties: { mail: { type: "string", format: "email" }, value: { type: "integer", default: 42 } },
    dependentRequired: { mail: ["value"] }
  });
  const args = { mail: "fixture@example.com" };
  assert.equal(modern(args), false);
  assert.deepEqual(args, { mail: "fixture@example.com" });
  assert.equal(modern({ mail: "fixture@example.com", value: 42 }), true);
  assert.equal(modern({ mail: "not-email", value: 42 }), false);
});

test("MCP fails closed for invalid schemas, unsupported dialects, async schemas and remote refs", () => {
  for (const schema of [
    { type: "object", properties: { x: { type: "not-a-type" } } },
    { type: "object", $schema: "https://fixture/unsupported-dialect" },
    { type: "object", $async: true },
    { type: "object", $ref: "https://fixture/remote-schema" }
  ]) {
    assert.throws(() => compileToolArguments(schema as Parameters<typeof compileToolArguments>[0]), { code: "invalid_schema" });
  }
});

test("MCP dialect selection accepts equivalent empty-fragment schema identifiers", () => {
  for (const dialect of ["http://json-schema.org/draft-07/schema", "https://json-schema.org/draft/2019-09/schema", "https://json-schema.org/draft/2020-12/schema"]) {
    for (const suffix of ["", "#"]) {
      const validate = compileToolArguments({ $schema: `${dialect}${suffix}`, type: "object", required: ["value"] });
      assert.equal(validate({ value: 1 }), true);
      assert.equal(validate({}), false);
    }
  }
});

test("MCP JSON argument snapshots reject non-JSON values and isolate mutations", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const value of [null, [], { x: undefined }, { x: NaN }, { x: Infinity }, { x: 1n }, { x: () => 1 },
    { x: new Date() }, { x: [, 1] }, circular]) {
    assert.throws(() => snapshotArguments(value), { code: "invalid_arguments" });
  }
  const value = { nested: { list: ["x", null, true, 2] } };
  const snapshot = snapshotArguments(value);
  value.nested.list[0] = "changed";
  assert.deepEqual(snapshot, { nested: { list: ["x", null, true, 2] } });
});
