import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { codeLanguage, highlightCode } from "./highlight.js";
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const escape = md.utils.escapeHtml;

// Highlight the whole file so multiline tokens retain their grammar context,
// then balance spans per row to preserve Review's line selection and offsets.
export function renderCodeLines(content, filePath = "") {
  const language = codeLanguage(filePath);
  const source = String(content).replace(/\r?\n$/, "");
  const html = highlightCode(source, language);
  const lines = [], spans = [];
  let line = "";
  for (const token of html.split(/(<\/?span\b[^>]*>|\r?\n)/)) {
    if (/^\r?\n$/.test(token)) {
      lines.push(line + "</span>".repeat(spans.length));
      line = spans.join("");
    } else {
      line += token;
      if (token.startsWith("<span")) spans.push(token);
      else if (token === "</span>") spans.pop();
    }
  }
  lines.push(line);
  return lines;
}

export function renderCodeBlock(content, language = "", label = "") {
  const name = String(language).trim().split(/\s+/)[0].toLowerCase();
  const code = highlightCode(content, language);
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

// Release notes come from GitHub as HTML: their own sanitizer (its hook must not touch chat markdown),
// text formatting and https links only, no images (no requests from the notes).
const notesPurify = DOMPurify(window);
notesPurify.addHook("afterSanitizeAttributes", node => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});
export function renderReleaseNotes(html) {
  return notesPurify.sanitize(String(html ?? "").slice(0, 65536), {
    ALLOWED_TAGS: ["h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "strong", "em", "b", "i", "code", "pre", "blockquote", "a", "br", "hr"],
    ALLOWED_ATTR: ["href", "target", "rel"], ALLOWED_URI_REGEXP: /^https:\/\//i, ALLOW_DATA_ATTR: false
  });
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
