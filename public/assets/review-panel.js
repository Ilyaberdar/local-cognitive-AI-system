const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const linesOf = (content) => String(content).replace(/\r?\n$/, "").split(/\r?\n/);

// File contents are quoted attachments, never inserted into the user's instruction.
export function selectionMessage(file, selection, comment) {
  const location = `${file.path}:${selection.startLine}-${selection.endLine}`;
  const text = `Selected source (${location}):\n${selection.text}`;
  const attachment = (name, textContent) => ({ id: crypto.randomUUID(), name, kind: "text", mimeType: "text/plain",
    sizeBytes: new TextEncoder().encode(textContent).length, textContent });
  const attachments = [attachment(`${file.name} · lines ${selection.startLine}–${selection.endLine}`, text)];
  // Small files can be edited without accidentally discarding surrounding code.
  if (file.content.length <= 5800) attachments.push(attachment(file.name, file.content));
  return { input: `File: ${JSON.stringify(file.path)} (lines ${selection.startLine}–${selection.endLine})\n\n${comment.trim()}`, attachments,
    reviewSelection: { path: file.path, version: file.version, startOffset: selection.startOffset, endOffset: selection.endOffset, text: selection.text } };
}

export function createReviewPanel(host) {
  const sessions = new Map();
  let bindings;
  let openSequence = 0;
  const session = () => {
    const id = host.sessionId();
    if (!sessions.has(id)) sessions.set(id, { tabs: [], active: "setup", expanded: false, selection: null, comment: "", commentOpen: false, scrollTop: 0, scrollLeft: 0 });
    return sessions.get(id);
  };
  const activeFile = (view = session()) => view.tabs.find((file) => file.path === view.active);
  const isOpen = () => session().active !== "setup";
  const notify = (error) => host.notify(error instanceof Error ? error.message : String(error));
  const clearSelection = (view) => { view.selection = null; view.comment = ""; view.commentOpen = false; };

  function tabs() {
    const open = isOpen();
    const collapsed = host.isCollapsed?.() || false;
    const expanded = session().expanded;
    return `<div class="right-panel-header">
      <div class="right-panel-tabs review-tabs" role="tablist" aria-label="Right panel views">
      <button type="button" role="tab" aria-selected="${!open}" class="right-panel-tab ${!open ? "active" : ""}" data-review-action="setup">Session Setup</button>
      <button type="button" role="tab" aria-selected="${open}" class="right-panel-tab ${open ? "active" : ""}" data-review-action="review">${host.icon("file")} Review</button>
      </div>
      <button type="button" class="ghost-button panel-expand icon-button" data-review-action="expand" aria-label="${expanded ? "Restore split view" : "Expand panel"}" title="${expanded ? "Restore split view" : "Expand panel"}">${expanded ? "↙" : "↗"}</button>
      <button class="ghost-button setup-toggle icon-button" type="button" data-action="toggle-session-setup" aria-label="${collapsed ? "Show panel" : "Hide panel"}" aria-expanded="${!collapsed}" title="${collapsed ? "Show panel" : "Hide panel"}">${host.icon(collapsed ? "chevronLeft" : "chevronRight")}</button>
    </div>`;
  }

  function render() {
    if (!isOpen()) return null;
    const view = session();
    const file = activeFile(view);
    const lines = file ? linesOf(file.content) : [];
    const diff = file?.change?.afterHash === file?.version ? file?.change?.diff : null;
    const start = Number(diff?.changeStartLine || 1);
    return `<aside class="panel chat-settings review-panel ${host.isCollapsed?.() ? "chat-settings--collapsed" : ""}" aria-label="Review">
      <div class="session-resize-handle" data-action="resize-right-panel" title="Resize panel"></div>
      ${tabs()}
      <div class="review-toolbar">
        <span class="review-caption">${diff ? `<span class="diff-summary__add">+${Number(diff.added)}</span> <span class="diff-summary__remove">−${Number(diff.removed)}</span>` : ""}</span>
        <div class="review-toolbar__actions">
          ${file ? `<button type="button" class="ghost-button" data-review-action="refresh" title="Reload file from disk">↻</button>
          <button type="button" class="ghost-button" data-review-action="copy" aria-label="Copy file" title="Copy file">${host.icon("copy")}</button>
          <button type="button" class="ghost-button" data-review-action="editor">Open in editor ${host.icon("externalLink")}</button>` : ""}
        </div>
      </div>
      ${file ? `<div class="review-files" aria-label="Open review files">${view.tabs.map((tab) => `<span class="review-file ${tab.path === view.active ? "active" : ""}">
        <button type="button" data-review-action="file" data-path="${escape(tab.path)}" title="${escape(tab.path)}">${escape(tab.name)}</button>
        <button type="button" data-review-action="close-file" data-path="${escape(tab.path)}" aria-label="Close ${escape(tab.name)}">×</button></span>`).join("")}</div>
      <div class="review-path" title="${escape(file.path)}"><code>${escape(file.path)}</code><span>${lines.length} lines</span></div>
      ${file.error ? `<div class="review-notice" role="alert">${escape(file.error)} Showing the last loaded copy.</div>` : file.change?.afterHash && !diff ? `<div class="review-notice">Changed on disk since this action. Showing the current file.</div>` : ""}
      <div class="review-content" tabindex="0" aria-label="File contents: ${escape(file.name)}">${lines.map((line, index) => {
        const number = index + 1;
        const added = diff && number >= start && number < start + diff.added;
        const selected = view.commentOpen && view.selection?.version === file.version && number >= view.selection.startLine && number <= view.selection.endLine;
        return `<div class="review-line ${added ? "review-line--add" : ""} ${selected ? "review-line--selected" : ""}" data-review-line="${number}"><span class="review-line__number" aria-hidden="true">${number}</span><code>${escape(line)}</code></div>`;
      }).join("")}</div>
      <div class="review-footer">Select text, then press + to ask in chat.</div>` : `<div class="review-empty">Open an edited file with the <strong>Review</strong> button in chat.</div>`}
      <button type="button" class="review-selection-plus" data-review-action="comment" aria-label="Ask about selected text" title="Ask about selected text" hidden>${host.icon("plus")}</button>
      <form class="review-comment" ${view.commentOpen && view.selection ? "" : "hidden"}>
        <div class="review-comment__heading"><span>${escape(file?.name || "")} · lines ${view.selection?.startLine ?? ""}–${view.selection?.endLine ?? ""}</span><button type="button" class="ghost-button" data-review-action="cancel-comment" aria-label="Cancel comment">×</button></div>
        <textarea name="reviewComment" aria-label="Ask about selection" placeholder="What should the agent do with this selection?" rows="3" maxlength="8000">${escape(view.comment)}</textarea>
        <div class="review-comment__actions"><span>${host.busy() ? "Waiting for the current response" : "Selection will be attached to your message"}</span><button type="submit" class="primary-button" ${host.busy() || view.sending ? "disabled" : ""}>Send to chat ${host.icon("arrowUp")}</button></div>
        <div class="review-comment__error" role="alert">${escape(view.commentError || "")}</div>
      </form>
    </aside>`;
  }

  async function open(filePath) {
    const id = host.sessionId();
    const view = session();
    const sequence = ++openSequence;
    await host.beforeOpen();
    if (id !== host.sessionId() || sequence !== openSequence) return;
    const file = await host.readFile(filePath, id);
    if (id !== host.sessionId() || sequence !== openSequence) return;
    const previous = view.tabs.find((tab) => tab.path === file.path);
    const next = { ...file, change: host.findChange(filePath) || host.findChange(file.path) };
    view.tabs = [...view.tabs.filter((tab) => tab.path !== file.path), next].slice(-8);
    if (view.active !== file.path || previous?.version !== file.version) {
      clearSelection(view); view.scrollTop = 0; view.scrollLeft = 0;
    }
    view.active = file.path;
    host.showPanel?.();
    host.changed();
  }

  async function refresh() {
    const id = host.sessionId();
    const view = session();
    const file = activeFile(view);
    if (!file) return;
    try {
      const next = await host.readFile(file.path, id);
      if (id !== host.sessionId() || activeFile(view) !== file) return;
      if (next.version !== file.version) clearSelection(view);
      Object.assign(file, next, { error: null, change: host.findChange(file.path) });
    } catch (error) { file.error = error.message; }
    if (id === host.sessionId() && activeFile(view) === file) host.changed();
  }

  function capture() {
    const content = document.querySelector(".review-content");
    // Never save the previous conversation's DOM into the newly selected session.
    if (content && content.dataset.sessionId === host.sessionId()) {
      const view = session(); view.scrollTop = content.scrollTop; view.scrollLeft = content.scrollLeft;
    }
  }

  function bind() {
    bindings?.abort(); bindings = new AbortController();
    const signal = bindings.signal;
    const on = (node, event, callback) => node?.addEventListener(event, callback, { signal });
    const view = session();
    const id = host.sessionId();
    const file = activeFile(view);
    const content = document.querySelector(".review-content");
    if (content) { content.dataset.sessionId = id; content.scrollTop = view.scrollTop; content.scrollLeft = view.scrollLeft; }
    document.querySelectorAll("[data-review-action]").forEach((button) => on(button, "click", async () => {
      try {
        const action = button.dataset.reviewAction;
        if (action === "setup") { ++openSequence; view.active = "setup"; host.changed(); }
        if (action === "review") {
          const sequence = ++openSequence; await host.beforeOpen();
          if (id !== host.sessionId() || sequence !== openSequence) return;
          view.active = view.tabs.at(-1)?.path || "review"; host.changed();
          if (activeFile(view)) await refresh();
        }
        if (action === "file") await open(button.dataset.path);
        if (action === "close-file") {
          ++openSequence; view.tabs = view.tabs.filter((tab) => tab.path !== button.dataset.path);
          if (view.active === button.dataset.path) { view.active = view.tabs.at(-1)?.path || "review"; clearSelection(view); }
          host.changed();
        }
        if (action === "expand") {
          await host.beforeOpen();
          if (id !== host.sessionId()) return;
          view.expanded = !view.expanded; host.changed();
        }
        if (action === "refresh") await refresh();
        if (action === "copy" && file) { await navigator.clipboard.writeText(file.content); button.title = "Copied"; }
        if (action === "editor" && file) { button.disabled = true; await host.openEditor(file.path, id); button.disabled = false; }
        if (action === "comment" && view.selection) { view.commentOpen = true; host.changed(); document.querySelector(".review-comment textarea")?.focus(); }
        if (action === "cancel-comment") { clearSelection(view); host.changed(); }
      } catch (error) { button.disabled = false; notify(error); }
    }));
    document.querySelectorAll("[data-action='open-tool-path']").forEach((button) => on(button, "click", () => open(button.dataset.path).catch(notify)));
    on(content, "scroll", () => { capture(); document.querySelector(".review-selection-plus")?.setAttribute("hidden", ""); });
    on(document, "selectionchange", () => {
      if (!content || !file || view.commentOpen || host.isCollapsed?.() || host.sessionId() !== id) return;
      const selection = window.getSelection();
      const plus = document.querySelector(".review-selection-plus");
      if (!selection?.rangeCount || selection.isCollapsed) { plus.hidden = true; return; }
      const range = selection.getRangeAt(0);
      if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) { plus.hidden = true; return; }
      const parts = [];
      for (const code of content.querySelectorAll(".review-line code")) {
        if (!range.intersectsNode(code)) continue;
        const part = document.createRange(); part.selectNodeContents(code);
        if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
        if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
        const prefix = document.createRange(); prefix.selectNodeContents(code); prefix.setEnd(part.startContainer, part.startOffset);
        parts.push({ line: Number(code.parentElement.dataset.reviewLine), offset: prefix.toString().length, text: part.toString() });
      }
      const text = parts.map((part) => part.text).join("\n");
      if (!parts.length || !text.trim()) { plus.hidden = true; return; }
      const starts = [0];
      for (let index = 0; index < file.content.length; index++) if (file.content[index] === "\n") starts.push(index + 1);
      const startOffset = starts[parts[0].line - 1] + parts[0].offset;
      const last = parts.at(-1);
      const endOffset = starts[last.line - 1] + last.offset + last.text.length;
      view.selection = { startLine: parts[0].line, endLine: last.line, startOffset, endOffset, text: file.content.slice(startOffset, endOffset), version: file.version };
      view.commentError = "";
      const rect = range.getBoundingClientRect();
      plus.style.left = `${Math.max(8, Math.min(window.innerWidth - 42, rect.right + 6))}px`;
      plus.style.top = `${Math.max(8, Math.min(window.innerHeight - 42, rect.bottom + 5))}px`;
      plus.hidden = false;
    });
    on(document.querySelector(".review-selection-plus"), "pointerdown", (event) => event.preventDefault());
    on(document.querySelector(".review-comment textarea"), "input", (event) => { view.comment = event.target.value; });
    on(document.querySelector(".review-comment textarea"), "keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.target.form.requestSubmit(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); clearSelection(view); host.changed(); }
    });
    on(document.querySelector(".review-comment"), "submit", async (event) => {
      event.preventDefault();
      if (!file || !view.selection || !view.comment.trim() || host.busy() || view.sending) return;
      view.sending = true;
      const selection = { ...view.selection }; const comment = view.comment;
      try {
        if (selection.text.length > 5000) throw new Error("Select up to 5,000 characters so the full selection can reach the model.");
        const latest = await host.readFile(file.path, id);
        if (id !== host.sessionId() || activeFile(view) !== file) return;
        if (latest.version !== selection.version) throw new Error("The file changed on disk. Refresh Review and select the new text before sending.");
        if (host.busy()) throw new Error("Wait for the current response before sending this comment.");
        const message = selectionMessage(file, selection, comment);
        clearSelection(view);
        view.expanded = false;
        const accepted = await host.send({ ...message, sessionId: id });
        if (!accepted && !view.selection && activeFile(view) === file) {
          view.selection = selection; view.comment = comment; view.commentOpen = true;
          view.commentError = "Message was not completed. You can retry this comment.";
        }
      } catch (error) { view.commentError = error.message; }
      finally { view.sending = false; if (id === host.sessionId()) host.changed(); }
    });
  }
  return { tabs, render, bind, capture, open, refresh, isOpen, expanded: () => !host.isCollapsed?.() && session().expanded };
}
