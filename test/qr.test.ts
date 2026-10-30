import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeConnectionKey } from "../src/remote/connectionKey";
import { connectionKeyQr, qrSvg, qrTerminal } from "../src/remote/qr/connectionKeyQr";

const key = encodeConnectionKey({ environment: 1, hostId: "11111111-2222-4333-8444-555555555555", invitationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  hostSpkiSha256: createHash("sha256").update("host").digest(), secret: createHash("sha256").update("secret").digest(), expiresAt: 4_102_444_800 });
const modules = (code: ReturnType<typeof connectionKeyQr>) => Array.from({ length: code.size }, (_, y) => Array.from({ length: code.size }, (_, x) => code.getModule(x, y) ? "1" : "0").join("")).join("\n");

test("a connection key is a small QR code: alphanumeric, error correction M or better, version 7", () => {
  const code = connectionKeyQr(key);
  assert.equal(key.length, 177);
  assert.equal(code.version, 7);
  assert.equal(code.size, 45);
  assert.ok(code.errorCorrectionLevel.ordinal >= 1, "M or better");
  // This exact code was read back to the key by macOS's Vision barcode reader (the iPhone camera's) on 2026-10-31.
  assert.equal(createHash("sha256").update(modules(code)).digest("hex").slice(0, 16), "51cf5cca761b615f");
  assert.throws(() => connectionKeyQr("lcr1-lowercase"), /alphanumeric/, "a key is upper case: anything else is not a key");
});

test("the window's SVG and the terminal's code carry the modules with a quiet zone, and nothing else", () => {
  const code = connectionKeyQr(key);
  const svg = qrSvg(code, `Key "for" <b>`);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 53 53"/);
  assert.equal((svg.match(/h1v1h-1z/g) ?? []).length, modules(code).split("").filter(bit => bit === "1").length);
  assert.match(svg, /aria-label="Key &#34;for&#34; &#60;b&#62;"/);
  assert.doesNotMatch(svg, /<b>|<script/);
  const lines = qrTerminal(code).split("\n");
  assert.equal(lines.length, 27, "two module rows per line");
  assert.ok(lines.every(line => line.endsWith("\x1b[0m")));
  assert.equal((lines[0]!.match(/▀/g) ?? []).length, 53);
});
