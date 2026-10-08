#!/usr/bin/env node
// Fails when an unpacked desktop app contains credential files or credential-like
// strings. Findings name the file and pattern only; matched values are never printed.
import fs from "node:fs";
import path from "node:path";

const forbiddenNames = [/^plugin-oauth-clients\.json$/, /^\.env(?:\..+)?$/, /^settings(?:\..+)?\.json$/, /\.(?:pem|p12|p8|key)$/];
const allowedNames = new Set([".env.example"]);
const patterns = [
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ["Notion token", /\b(?:ntn|secret)_[A-Za-z0-9]{40,}/],
  ["Telegram bot token", /\b\d{8,11}:[A-Za-z0-9_-]{35}\b/],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/]
];
// Third-party packages are scanned for file names only: their sources legitimately
// contain key-shaped examples and test fixtures.
const contentRoots = ["electron", "dist", "public", "package.json"];

const findAppDir = () => {
  const release = path.resolve("release");
  const candidates = [];
  const walk = (directory, depth) => {
    if (depth > 4 || !fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(directory, entry.name);
      if (entry.name === "app" && fs.existsSync(path.join(full, "package.json"))) candidates.push(full);
      else walk(full, depth + 1);
    }
  };
  walk(release, 0);
  return candidates;
};

const scan = (appDir) => {
  const findings = [];
  const visit = (current, scanContent) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(appDir, full);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { visit(full, scanContent); continue; }
      if (!allowedNames.has(entry.name) && forbiddenNames.some(pattern => pattern.test(entry.name))) findings.push(`${relative}: forbidden file`);
      if (!scanContent) continue;
      const stat = fs.statSync(full);
      if (stat.size > 20 * 1024 * 1024) continue;
      const buffer = fs.readFileSync(full);
      if (buffer.subarray(0, 8192).includes(0)) continue;
      const text = buffer.toString("utf8");
      for (const [name, pattern] of patterns) if (pattern.test(text)) findings.push(`${relative}: ${name}`);
    }
  };
  for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
    const full = path.join(appDir, entry.name);
    if (entry.isDirectory()) visit(full, contentRoots.includes(entry.name));
    else if (entry.isFile()) {
      if (forbiddenNames.some(pattern => pattern.test(entry.name)) && !allowedNames.has(entry.name)) findings.push(`${entry.name}: forbidden file`);
      if (contentRoots.includes(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const [name, pattern] of patterns) if (pattern.test(text)) findings.push(`${entry.name}: ${name}`);
      }
    }
  }
  return findings;
};

const targets = process.argv.slice(2).length ? process.argv.slice(2).map(target => path.resolve(target)) : findAppDir();
if (!targets.length) {
  console.error("No unpacked app found. Pass the app directory (…/Resources/app or …/resources/app).");
  process.exit(2);
}
let failed = false;
for (const target of targets) {
  const findings = scan(target);
  if (findings.length) {
    failed = true;
    console.error(`${target}\n${findings.map(finding => `  ${finding}`).join("\n")}`);
  } else console.log(`${target}: no credential files or credential-like strings`);
}
process.exit(failed ? 1 : 0);
