// Physical window geometry; the renderer reads the matching Window Controls
// Overlay CSS environment variables, including their conversion at page zoom.
const TITLEBAR_HEIGHT = 60;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Windows draws the caption buttons itself, on `color`. `colors` are the title bar's background and
 * text as the window computed them (themes and appearance settings change both), so the buttons sit
 * on the bar's own color; until the window reports them, or for anything that is not a hex color,
 * the theme's defaults. */
function windowsTitleBarOverlay(dark, colors = {}) {
  return {
    height: TITLEBAR_HEIGHT,
    color: HEX_COLOR.test(colors.color ?? "") ? colors.color : dark ? "#111214" : "#f8f9fb",
    symbolColor: HEX_COLOR.test(colors.symbolColor ?? "") ? colors.symbolColor : dark ? "#ecedef" : "#272b34"
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
