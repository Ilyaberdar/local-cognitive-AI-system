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
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import lua from "highlight.js/lib/languages/lua";
import glsl from "highlight.js/lib/languages/glsl";
import ini from "highlight.js/lib/languages/ini";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";
import cmake from "highlight.js/lib/languages/cmake";
import makefile from "highlight.js/lib/languages/makefile";

for (const [name, grammar] of Object.entries({ javascript, typescript, json, python, bash, css, xml, yaml, sql, markdown, diff, c, cpp, csharp, java, kotlin, swift, go,
  rust, php, ruby, lua, glsl, ini, dockerfile, powershell, cmake, makefile })) hljs.registerLanguage(name, grammar);
const aliases = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", sh: "bash", shell: "bash", html: "xml", yml: "yaml", md: "markdown",
  "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", h: "cpp", ino: "cpp", cs: "csharp", "c#": "csharp", kt: "kotlin", kts: "kotlin", golang: "go", rs: "rust",
  rb: "ruby", hlsl: "glsl", frag: "glsl", vert: "glsl", toml: "ini", conf: "ini", ps1: "powershell", ps: "powershell", docker: "dockerfile", mk: "makefile" };
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
