import { icon } from "./ui-primitives.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const folderColors = [["", "Default"], ["red", "Red"], ["yellow", "Yellow"], ["green", "Green"], ["blue", "Blue"], ["purple", "Purple"]];
const folderColor = project => folderColors.some(([value]) => value === project?.color) ? project.color : "";

// Keep ordinary conversations separate even when a project is archived or missing.
export function groupProjectSessions(sessions = []) {
  const recent = [];
  const byProject = new Map();
  for (const session of sessions) {
    if (!session.projectId) recent.push(session);
    else {
      if (!byProject.has(session.projectId)) byProject.set(session.projectId, []);
      byProject.get(session.projectId).push(session);
    }
  }
  return { recent, byProject };
}

export function projectOptions(projects = [], selected = "") {
  const available = projects.filter(project => !project.archivedAt || project.id === selected);
  return `<option value="" ${!selected ? "selected" : ""}>No project · separate task folder</option>${available.map(project => `<option value="${escape(project.id)}" ${project.id === selected ? "selected" : ""}>${escape(project.name)}${project.archivedAt ? " · archived" : ""}</option>`).join("")}${selected && !available.some(project => project.id === selected) ? `<option value="${escape(selected)}" selected>Project unavailable</option>` : ""}`;
}

export function createProjectsUi(options) {
  const collapsed = new Set();
  const collapsedSections = new Set();
  const sectionStorageKey = "lcai.sidebar.collapsedSections.v1";
  try {
    const stored = JSON.parse(localStorage.getItem(sectionStorageKey) || "[]");
    if (Array.isArray(stored)) stored.filter(section => ["projects", "chats"].includes(section)).forEach(section => collapsedSections.add(section));
  } catch { /* Storage may be unavailable; section toggles still work for this window. */ }
  const setSectionExpanded = (section, expanded) => {
    if (!["projects", "chats"].includes(section)) return;
    if (expanded) collapsedSections.delete(section);
    else collapsedSections.add(section);
    try { localStorage.setItem(sectionStorageKey, JSON.stringify([...collapsedSections])); } catch { /* Keep the in-memory preference. */ }
  };
  const expandedLists = new Set();
  const sectionToggle = (section, label) => `<button id="sidebar-toggle-${section}" class="sidebar-section-label" type="button" data-action="toggle-sidebar-section" data-sidebar-section="${section}" aria-expanded="${!collapsedSections.has(section)}" aria-controls="sidebar-${section}-content">${icon(collapsedSections.has(section) ? "chevronRight" : "chevronDown")}<span>${label}</span></button>`;
  const sessionRow = (session, activeId) => `<div class="session-row ${session.id === activeId ? "active" : ""}">
    <button class="session-item ${session.id === activeId ? "active" : ""}" data-action="open-session" data-session-id="${escape(session.id)}" title="${escape(session.title)}${session.updatedAt ? ` · ${escape(new Date(session.updatedAt).toLocaleString())}` : ""}" ${session.id === activeId ? 'aria-current="page"' : ""}><span class="session-title">${escape(session.title)}</span></button>
    <button class="session-delete" type="button" data-action="delete-session-quick" data-session-id="${escape(session.id)}" aria-label="Delete ${escape(session.title)}" title="Delete chat">${icon("close")}</button>
  </div>`;

  function sidebar() {
    const state = options.getState();
    const { recent, byProject } = groupProjectSessions(state.bootstrap?.sessions);
    const projects = state.bootstrap?.projects ?? [];
    return `<div class="sidebar-conversations" data-sidebar-scroll="conversations">
      <section class="sidebar-section sidebar-projects" aria-label="Projects">
        <div class="sidebar-header">${sectionToggle("projects", "Projects")}<button class="icon-button" type="button" data-action="new-project" aria-label="Add project" title="Add project">${icon("plus")}</button></div>
        <div id="sidebar-projects-content" class="project-list" ${collapsedSections.has("projects") ? "hidden" : ""}>${projects.filter(project => !project.archivedAt).map(project => {
          const sessions = byProject.get(project.id) ?? [];
          const isOpen = !collapsed.has(project.id);
          const limit = expandedLists.has(project.id) ? sessions.length : 5;
          // Keep the selected chat visible even when it is older than the latest five.
          const visible = sessions.slice(0, limit);
          const active = sessions.find(session => session.id === state.activeSessionId);
          if (active && !visible.includes(active)) visible.push(active);
          return `<div class="project-group">
            <div class="project-row">
              <button id="sidebar-project-folder-${escape(project.id)}" class="project-folder" type="button" data-action="toggle-project" data-project-id="${escape(project.id)}" data-project-color="${folderColor(project)}" aria-label="${isOpen ? "Collapse" : "Expand"} ${escape(project.name)}" aria-expanded="${isOpen}" title="${isOpen ? "Collapse" : "Expand"}">${icon("folder")}</button>
              <button class="project-title" type="button" data-action="open-project" data-project-id="${escape(project.id)}" title="${escape(project.rootPath)}">${escape(project.name)}</button>
              <div class="project-actions"><button class="icon-button" type="button" data-action="new-session" data-project-id="${escape(project.id)}" aria-label="New chat in ${escape(project.name)}" title="New chat">${icon("plus")}</button><button id="sidebar-project-menu-${escape(project.id)}" class="icon-button" type="button" data-action="project-menu" data-project-id="${escape(project.id)}" aria-label="Actions for ${escape(project.name)}" aria-haspopup="menu" aria-expanded="false" aria-controls="project-menu-${escape(project.id)}" title="Project actions">${icon("moreHorizontal")}</button></div>
              <div id="project-menu-${escape(project.id)}" class="project-menu" popover="auto" role="menu" aria-label="Project actions for ${escape(project.name)}">
                <button type="button" role="menuitem" data-project-command="settings">${icon("settings")}<span>Project settings</span></button>
                <button type="button" role="menuitem" data-project-command="archive">${icon("archive")}<span>Archive</span></button>
              </div>
            </div>
            ${isOpen ? `<div class="project-chats">${visible.map(session => sessionRow(session, state.activeSessionId)).join("")}${!sessions.length ? `<button class="project-empty" type="button" data-action="new-session" data-project-id="${escape(project.id)}">Start a chat</button>` : ""}${sessions.length > 5 ? `<button id="sidebar-project-more-${escape(project.id)}" class="project-show-more" type="button" data-action="more-project-chats" data-project-id="${escape(project.id)}" aria-expanded="${expandedLists.has(project.id)}">${expandedLists.has(project.id) ? "Show less" : "Show more"}</button>` : ""}</div>` : ""}
          </div>`;
        }).join("") || '<button class="project-empty" type="button" data-action="new-project">Add a project folder</button>'}${projects.some(project => project.archivedAt) ? '<button class="project-show-more" type="button" data-action="archived-projects">Archived projects</button>' : ""}</div>
      </section>
      <section class="sidebar-section sidebar-chats" aria-label="Chats">
        <div class="sidebar-header">${sectionToggle("chats", "Chats")}<button class="icon-button" type="button" data-action="new-session" data-project-id="" aria-label="New ordinary chat" title="New ordinary chat">${icon("plus")}</button></div>
        <div id="sidebar-chats-content" class="session-list" ${collapsedSections.has("chats") ? "hidden" : ""}>${recent.length ? recent.map(session => sessionRow(session, state.activeSessionId)).join("") : '<p class="sidebar-empty">No chats yet</p>'}</div>
      </section>
    </div>`;
  }

  function dialogShell(title, body) {
    const dialog = document.createElement("dialog");
    dialog.className = "project-dialog";
    dialog.setAttribute("aria-labelledby", "project-dialog-title");
    dialog.innerHTML = `<div class="project-dialog-header"><h2 id="project-dialog-title">${escape(title)}</h2><button class="icon-button" type="button" data-project-close aria-label="Close">${icon("close")}</button></div>${body}`;
    const previousFocus = document.activeElement;
    const close = () => dialog.close();
    dialog.addEventListener("close", () => {
      dialog.remove();
      const target = previousFocus?.isConnected ? previousFocus : previousFocus?.id ? document.getElementById(previousFocus.id) : null;
      target?.focus();
    });
    dialog.querySelector("[data-project-close]").addEventListener("click", close);
    dialog.addEventListener("click", event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close(); } });
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  }

  function projectDialog(project, onCreated) {
    const dialog = dialogShell(project ? "Project settings" : "New project", `<form class="project-form">
      <label class="field">Name<input name="name" id="project-name" value="${escape(project?.name)}" placeholder="My project" maxlength="120" required autofocus /></label>
      <label class="field">Directory<div class="project-directory-input"><input name="rootPath" id="project-path" value="${escape(project?.rootPath)}" placeholder="/path/to/project" required autocomplete="off" spellcheck="false" />${window.desktopProjects ? `<button class="ghost-button" type="button" data-project-browse>${icon("folder")}Choose</button>` : ""}</div></label>
      <p class="subtle">${window.desktopProjects ? "Chats and tasks in this project work in this folder." : "Use an absolute directory on the computer running Local Cognitive. Chats and tasks will work there."}</p>
      <fieldset class="project-color-picker"><legend>Folder color</legend><div class="project-color-options">${folderColors.map(([value, label]) => `<label class="project-color-option" title="${label}"><input type="radio" name="color" value="${value}" aria-label="${label}" ${folderColor(project) === value ? "checked" : ""} /><span class="project-color-preview" data-project-color="${value}">${icon("folder")}</span></label>`).join("")}</div></fieldset>
      <p class="project-form-error" role="alert" hidden></p>
      <div class="project-dialog-footer">${project ? '<button class="ghost-button" type="button" data-project-archive>Archive project</button>' : '<span></span>'}<button class="primary-button" type="submit">${project ? "Save changes" : "Create project"}</button></div>
    </form>`);
    const form = dialog.querySelector("form");
    const showError = error => { const target = dialog.querySelector("[role=alert]"); target.hidden = false; target.textContent = error.message || String(error); };
    const submit = async action => {
      if (form.dataset.busy) return;
      form.dataset.busy = "true";
      form.querySelectorAll("button").forEach(button => { button.disabled = true; });
      try { await action(); dialog.close(); } catch (error) { showError(error); }
      finally { delete form.dataset.busy; form.querySelectorAll("button").forEach(button => { button.disabled = false; }); }
    };
    dialog.querySelector("[data-project-browse]")?.addEventListener("click", async () => {
      try {
        const path = await window.desktopProjects.selectDirectory();
        if (!path) return;
        form.elements.rootPath.value = path;
        if (!form.elements.name.value.trim()) form.elements.name.value = path.split(/[\\/]/).filter(Boolean).at(-1) || "My project";
      } catch (error) { showError(error); }
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const payload = { name: form.elements.name.value.trim(), rootPath: form.elements.rootPath.value.trim(), color: form.elements.color?.value || null };
      if (!payload.name || !payload.rootPath) return;
      void submit(async () => {
        const saved = project ? await options.updateProject(project.id, payload) : await options.createProject(payload);
        await options.refresh();
        if (!project) { setSectionExpanded("projects", true); collapsed.delete(saved.id); }
        if (!project && onCreated) { await onCreated(saved); options.render(); }
        else if (!project) await options.selectProject(saved.id);
        else options.render();
      });
    });
    dialog.querySelector("[data-project-archive]")?.addEventListener("click", () => void submit(() => archiveProject(project.id)));
  }

  async function archiveProject(projectId) {
    await options.updateProject(projectId, { archived: true });
    await options.refresh();
    if (options.getState().activeProjectId === projectId) await options.selectProject(null);
    else options.render();
  }

  function bindProjectMenu(trigger) {
    const menu = document.getElementById(trigger.getAttribute("aria-controls"));
    const items = [...menu.querySelectorAll("[role=menuitem]")];
    const close = (restoreFocus = false) => {
      menu.hidePopover();
      if (restoreFocus) trigger.focus({ preventScroll: true });
    };
    const open = (last = false) => {
      menu.showPopover();
      const rect = trigger.getBoundingClientRect();
      const below = rect.bottom + 6;
      menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(below + menu.offsetHeight <= window.innerHeight - 8 ? below : rect.top - menu.offsetHeight - 6, window.innerHeight - menu.offsetHeight - 8))}px`;
      items[last ? items.length - 1 : 0].focus({ preventScroll: true });
    };
    menu.addEventListener("toggle", () => trigger.setAttribute("aria-expanded", String(menu.matches(":popover-open"))));
    trigger.addEventListener("click", () => { if (menu.matches(":popover-open")) close(); else open(); });
    trigger.addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      open(event.key === "ArrowUp");
    });
    menu.addEventListener("keydown", event => {
      const index = items.indexOf(document.activeElement);
      let next;
      if (event.key === "ArrowDown") next = (index + 1) % items.length;
      if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = items.length - 1;
      if (next !== undefined) { event.preventDefault(); items[next].focus(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      if (event.key === "Tab") close(true);
    });
    let archiving = false;
    menu.addEventListener("click", async event => {
      const command = event.target.closest("[data-project-command]")?.dataset.projectCommand;
      if (!command || archiving) return;
      const project = (options.getState().bootstrap?.projects ?? []).find(project => project.id === trigger.dataset.projectId);
      close(true);
      if (!project) return;
      if (command === "settings") { projectDialog(project); return; }
      if (command === "archive") {
        archiving = true;
        try { await archiveProject(project.id); }
        catch (error) { options.notify(error.message || "Could not archive project."); }
        finally { archiving = false; }
      }
    });
  }

  function archivedDialog() {
    const projects = (options.getState().bootstrap?.projects ?? []).filter(project => project.archivedAt);
    const dialog = dialogShell("Archived projects", `<div class="archived-project-list">${projects.map(project => `<div><span title="${escape(project.rootPath)}">${escape(project.name)}</span><button class="ghost-button" data-restore-project="${escape(project.id)}" type="button">Restore</button></div>`).join("") || '<p class="subtle">No archived projects.</p>'}</div><p class="project-form-error" role="alert" hidden></p>`);
    dialog.querySelectorAll("[data-restore-project]").forEach(button => button.addEventListener("click", async () => {
      button.disabled = true;
      try { await options.updateProject(button.dataset.restoreProject, { archived: false }); await options.refresh(); setSectionExpanded("projects", true); options.render(); dialog.close(); }
      catch (error) { const target = dialog.querySelector("[role=alert]"); target.hidden = false; target.textContent = error.message; button.disabled = false; }
    }));
  }

  function bind() {
    document.querySelectorAll("[data-action='toggle-sidebar-section']").forEach(button => button.addEventListener("click", () => {
      const section = button.dataset.sidebarSection;
      setSectionExpanded(section, collapsedSections.has(section));
      options.render();
    }));
    document.querySelectorAll("[data-action='new-project']").forEach(button => button.addEventListener("click", () => projectDialog()));
    document.querySelectorAll("[data-action='project-menu']").forEach(bindProjectMenu);
    document.querySelector(".sidebar-conversations")?.addEventListener("scroll", () => {
      document.querySelectorAll(".project-menu:popover-open").forEach(menu => menu.hidePopover());
    }, { passive: true });
    document.querySelector("[data-action='archived-projects']")?.addEventListener("click", archivedDialog);
    document.querySelectorAll("[data-action='open-project']").forEach(button => button.addEventListener("click", () => { collapsed.delete(button.dataset.projectId); void options.selectProject(button.dataset.projectId); }));
    document.querySelectorAll("[data-action='toggle-project']").forEach(button => button.addEventListener("click", () => { const id = button.dataset.projectId; if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); options.render(); }));
    document.querySelectorAll("[data-action='more-project-chats']").forEach(button => button.addEventListener("click", () => { const id = button.dataset.projectId; if (expandedLists.has(id)) expandedLists.delete(id); else expandedLists.add(id); options.render(); }));
  }
  return {
    sidebar, bind,
    openCreateProject: onCreated => projectDialog(undefined, onCreated),
    revealSession: projectId => {
      setSectionExpanded(projectId ? "projects" : "chats", true);
      if (projectId) collapsed.delete(projectId);
    }
  };
}
