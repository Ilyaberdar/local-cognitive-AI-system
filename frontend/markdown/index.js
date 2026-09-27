import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
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
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const escape = md.utils.escapeHtml;

export function renderCodeBlock(content, language = "", label = "") {
  const name = String(language).trim().split(/\s+/)[0].toLowerCase();
  const supported = aliases[name] || name;
  const code = content.length <= 80_000 && hljs.getLanguage(supported)
    ? hljs.highlight(content, { language: supported, ignoreIllegals: true }).value : escape(content);
  return `<section class="markdown-code"><div class="markdown-code__header"><span>${escape(label || name || "text")}</span><button type="button" class="markdown-code__copy" data-code-copy>Copy code</button></div><pre tabindex="0"><code class="hljs">${code}</code></pre></section>`;
}

md.renderer.rules.fence = (tokens, index) => renderCodeBlock(tokens[index].content, tokens[index].info);
md.renderer.rules.code_block = (tokens, index) => renderCodeBlock(tokens[index].content);
md.renderer.rules.table_open = () => '<div class="markdown-table" tabindex="0"><table>';
md.renderer.rules.table_close = () => "</table></div>";
const originalLink = md.renderer.rules.link_open || ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet("target", "_blank"); tokens[index].attrSet("rel", "noopener noreferrer");
  return originalLink(tokens, index, options, env, self);
};
// Model-provided images remain links; rendering an answer must not make arbitrary network requests.
md.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]; const src = token.attrGet("src") || "";
  return `<a href="${escape(src)}" target="_blank" rel="noopener noreferrer">${escape(token.content || "Image")}</a>`;
};

export function renderMarkdown(value) {
  const html = md.render(String(value ?? ""));
  return `<div class="message-markdown">${DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true }, ADD_ATTR: ["target"], FORBID_TAGS: ["style", "input", "form"],
    FORBID_ATTR: ["style"], ALLOW_DATA_ATTR: true
  })}</div>`;
}

export function bindMarkdownActions(root) {
  root.addEventListener("click", async event => {
    const button = event.target.closest?.("[data-code-copy]");
    if (!button || !root.contains(button)) return;
    const code = button.closest(".markdown-code")?.querySelector("pre code");
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent || "");
      button.textContent = "Copied";
    } catch { button.textContent = "Copy failed"; }
    setTimeout(() => { if (button.isConnected) button.textContent = "Copy code"; }, 1800);
  });
}
