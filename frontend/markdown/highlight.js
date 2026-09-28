import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";

for (const [name, grammar] of Object.entries({ javascript, typescript, json, python, bash, css, xml, yaml, sql, markdown, diff })) hljs.registerLanguage(name, grammar);
const aliases = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", sh: "bash", shell: "bash", html: "xml", yml: "yaml", md: "markdown" };
const escape = value => String(value).replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

export function codeLanguage(filePath = "") {
  const name = String(filePath).split(/[\\/]/).at(-1).toLowerCase();
  const extension = name.includes(".") ? name.split(".").at(-1) : name;
  return ({ mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript", svg: "xml", vue: "xml", bashrc: "bash", zsh: "bash", zshrc: "bash" })[extension] || aliases[extension] || extension;
}

export function highlightCode(content, language = "") {
  const name = String(language).trim().split(/\s+/)[0].toLowerCase();
  const supported = aliases[name] || name;
  return content.length <= 80_000 && hljs.getLanguage(supported)
    ? hljs.highlight(content, { language: supported, ignoreIllegals: true }).value : escape(content);
}
