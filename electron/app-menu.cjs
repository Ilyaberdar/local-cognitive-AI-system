// The application menu: the standard menus, with Help → Report a Bug… instead of Electron's own
// links. An installed app has no Reload (Cmd/Ctrl+R) and no Developer Tools: a reload drops what
// the window is doing, such as a reply being written or an unsent draft, and the tools are for
// development only.

/** The menu template for Menu.buildFromTemplate. */
function menuTemplate({ isPackaged, platform, openReport }) {
  return [
    ...(platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" }, { role: "editMenu" },
    { label: "View", submenu: [
      ...(isPackaged ? [] : [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }]),
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }
    ] },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Report a Bug…", click: openReport }] }
  ];
}

module.exports = { menuTemplate };
