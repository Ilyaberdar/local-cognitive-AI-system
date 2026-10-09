import { icon } from "./ui-primitives.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

/** What a place in a server's shared folder is called on screen: "fedora › Projects › site". */
export const placeLabel = (hostName, place) => [hostName, place.rootLabel, ...(place.path ?? [])].filter(Boolean).join(" › ");

/** Chooses a folder among a server's shared folders (R5-4f): its roots, then folders inside, with
 * "New folder" where the server allows it. `call(op, payload)` asks the server. Resolves with
 * `{ rootId, rootLabel, path }`, or null when closed. Nothing shown is a path of the host. */
export function chooseServerFolder({ call, hostName, title = "Choose a folder" }) {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "project-dialog folder-browser";
    dialog.setAttribute("aria-labelledby", "folder-browser-title");
    let roots = [], root = null, path = [], entries = [], truncated = false, error = "", busy = true, settled = false;
    // Answered once: by a choice, the close button or Escape.
    const finish = value => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };
    const render = () => {
      const crumbs = root ? [`<button type="button" class="ghost-button" data-folder-crumb="-1">${escape(root.label)}</button>`,
        ...path.map((name, index) => `<button type="button" class="ghost-button" data-folder-crumb="${index}">${escape(name)}</button>`)].join(`<span aria-hidden="true">›</span>`) : "";
      const rows = !root
        ? roots.map(item => `<button type="button" class="folder-browser-row" data-folder-root="${escape(item.rootId)}">${icon("folder")}<span>${escape(item.label)}</span><small>${item.kind === "managed" ? `On ${escape(hostName)}` : "Shared by the server"}</small></button>`).join("")
        : entries.filter(entry => entry.kind === "dir").map(entry => `<button type="button" class="folder-browser-row" data-folder-open="${escape(entry.name)}">${icon("folder")}<span>${escape(entry.name)}</span></button>`).join("")
          || `<p class="subtle">No folders here.</p>`;
      dialog.innerHTML = `<div class="project-dialog-header"><h2 id="folder-browser-title">${escape(title)}</h2><button class="icon-button" type="button" data-folder-close aria-label="Close">${icon("close")}</button></div>
        <p class="subtle">${escape(`Folders on ${hostName}`)}</p>
        ${root ? `<nav class="folder-browser-crumbs" aria-label="Folder">${crumbs}</nav>` : ""}
        <div class="folder-browser-list" role="list" aria-busy="${busy}">${busy ? `<p class="subtle">Loading…</p>` : rows}${truncated ? `<p class="subtle">Only the first 500 entries are shown.</p>` : ""}</div>
        ${root?.canCreate ? `<form class="folder-browser-new"><input name="folder" maxlength="255" placeholder="New folder name" aria-label="New folder name" /><button class="ghost-button" type="submit">New folder</button></form>` : ""}
        <p class="project-form-error" role="alert" ${error ? "" : "hidden"}>${escape(error)}</p>
        <div class="project-dialog-footer"><span></span><button class="primary-button" type="button" data-folder-choose ${root ? "" : "disabled"}>Choose this folder</button></div>`;
      bind();
    };
    const load = async () => {
      busy = true; error = ""; render();
      try {
        if (!root) roots = await call("fs.roots", {});
        else ({ entries, truncated } = await call("fs.browse", { rootId: root.rootId, path }));
      } catch (failure) { error = failure?.message || "The server did not answer."; entries = []; }
      busy = false; render();
    };
    const bind = () => {
      dialog.querySelector("[data-folder-close]").addEventListener("click", () => finish(null));
      dialog.querySelectorAll("[data-folder-root]").forEach(button => button.addEventListener("click", () => {
        root = roots.find(item => item.rootId === button.dataset.folderRoot) ?? null; path = []; void load();
      }));
      dialog.querySelectorAll("[data-folder-open]").forEach(button => button.addEventListener("click", () => { path = [...path, button.dataset.folderOpen]; void load(); }));
      dialog.querySelectorAll("[data-folder-crumb]").forEach(button => button.addEventListener("click", () => {
        const index = Number(button.dataset.folderCrumb);
        if (index < 0 && !path.length) { root = null; } else path = path.slice(0, index + 1);
        void load();
      }));
      dialog.querySelector(".folder-browser-new")?.addEventListener("submit", async event => {
        event.preventDefault();
        const name = event.currentTarget.elements.folder.value.trim();
        if (!name) return;
        try { path = (await call("fs.mkdir", { rootId: root.rootId, path, name })).path; await load(); }
        catch (failure) { error = failure?.message || "The folder was not made."; render(); }
      });
      dialog.querySelector("[data-folder-choose]").addEventListener("click", () => finish({ rootId: root.rootId, rootLabel: root.label, path: [...path] }));
    };
    dialog.addEventListener("close", () => finish(null));
    document.body.append(dialog);
    dialog.showModal();
    void load();
  });
}
