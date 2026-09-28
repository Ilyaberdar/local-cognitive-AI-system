// Physical window geometry; the renderer reads the matching Window Controls
// Overlay CSS environment variables, including their conversion at page zoom.
const TITLEBAR_HEIGHT = 60;

function windowsTitleBarOverlay(dark) {
  return {
    height: TITLEBAR_HEIGHT,
    color: dark ? "#111214" : "#f8f9fb",
    symbolColor: dark ? "#ecedef" : "#272b34"
  };
}

function windowChromeOptions(platform, dark) {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      // Let AppKit lay out the whole system group. Moving only the traffic
      // lights leaves macOS's screen-sharing indicator at its original inset.
      titleBarOverlay: true
    };
  }
  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: windowsTitleBarOverlay(dark),
      autoHideMenuBar: true
    };
  }
  return {};
}

module.exports = { windowChromeOptions, windowsTitleBarOverlay };
