const fs = require("fs");
const path = require("path");

// Hosting's own switches, in userData/remote-host.json. Kept apart from the app's settings, which a
// paired device may change. backgroundNoticeShown is the app's note that it said once where it keeps
// running. Nothing here loads the backend: main reads it before the backend's configuration exists.
// allowDeviceCommands was the 0.1.12 switch for every device at once; it is read once to trust the
// devices paired then (host.cjs), written false, and set no more: trust is per device now.
const DEFAULTS = Object.freeze({ enabled: false, keepAwake: true, openAtLogin: false, allowDeviceCommands: false, backgroundNoticeShown: false });
const SWITCHES = ["enabled", "keepAwake", "openAtLogin"];

const readSettings = file => {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* None yet, or unreadable: the defaults. */ }
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, typeof saved?.[key] === "boolean" ? saved[key] : value]));
};
const writeSettings = (file, settings) => {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
};

/** Whether this launch is the one the system made at login, with hosting on: then no window opens. */
const startsInBackground = ({ app, argv = process.argv, platform = process.platform, dataRoot }) => {
  if (!readSettings(path.join(dataRoot, "remote-host.json")).enabled) return false;
  if (argv.includes("--background")) return true;
  try { return platform === "darwin" && app.isPackaged && Boolean(app.getLoginItemSettings({ type: "mainAppService" }).wasOpenedAtLogin); } catch { return false; }
};

module.exports = { DEFAULTS, SWITCHES, readSettings, writeSettings, startsInBackground };
