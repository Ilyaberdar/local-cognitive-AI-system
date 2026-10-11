// Colors and type for the videos. Title cards and the frame around the app follow the landing page
// (local-cognitive-landing/public/assets/site.css :root); the app itself is recorded in its dark theme
// (public/assets/liquid-glass.css), so its tokens are here only for overlays that sit on the recording.

export const landing = {
  bg: "#f6f7f9",
  dots: "#dde2ea",
  ink: "#10131a",
  ink2: "#2b323d",
  muted: "#4a5361",
  muted2: "#6b7482",
  line: "#e3e7ee",
  card: "#ffffff",
  accent: "#2f55c8",
  accentInk: "#1f3f9e",
  ok: "#337851",
  okBg: "#e3f1e8",
  warn: "#a06b16",
  warnBg: "#fbf4e6",
} as const;

// The app's light theme (--bg), drawn behind a recording: on macOS the window is translucent, so the
// sidebar and title bar come out partly transparent in Chromium's own frames.
export const appLight = {
  bg: "#e9edf2",
} as const;

export const appDark = {
  bg: "#111214",
  surface: "#18191d",
  surface3: "#272a30",
  text: "#ecedef",
  muted: "#a0a2ab",
  accent: "#b4c9eb",
  success: "#8bcca6",
  warning: "#d9b980",
  danger: "#ed9295",
} as const;

export const fonts = {
  sans: 'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: '"Geist Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
} as const;

// The landing's window shadow (site.css .window), scaled for a 1920×1080 frame.
export const windowShadow =
  "0 60px 120px -60px rgba(39, 49, 64, 0.55), 0 3px 10px rgba(39, 49, 64, 0.08)";

// The landing's page background: 1px dots every 22px at 1200px width, about 30px at 1920.
export const dotGrid = `radial-gradient(${landing.dots} 1.5px, transparent 1.5px)`;
export const dotGridSize = "30px 30px";
