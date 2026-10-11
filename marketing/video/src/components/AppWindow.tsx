import { Video } from "@remotion/media";
import type React from "react";
import { Img, Interactive, staticFile, useVideoConfig, type InteractivitySchema } from "remotion";
import { appLight, landing, windowShadow } from "../brand/theme";
import { PendingCapture } from "./PendingCapture";

type AppWindowProps = {
  // A file in public/ (captures/… or stills/…). Empty while the shot is not recorded yet.
  readonly src: string;
  readonly kind: "image" | "video";
  // Shown on the placeholder until the capture exists, e.g. "D3 · Workflow run".
  readonly shotId: string;
  // Zoom into the recording around a focus point (0–1 of its width and height). The frame stays put.
  readonly zoom: number;
  readonly focusX: number;
  readonly focusY: number;
  readonly style?: React.CSSProperties;
};

// A real recording of the app inside the landing's window frame (16px radius, soft shadow). The macOS
// traffic lights are not drawn: recordings start at the app's own top bar. 1440×900 at 16:10 leaves
// a band above for the speed badge and one below for subtitles.
const AppWindowInner: React.FC<AppWindowProps> = ({ src, kind, shotId, zoom, focusX, focusY, style }) => {
  const { fps } = useVideoConfig();
  return (
    <Interactive.Div
      name="App window"
      style={{
        position: "absolute",
        left: 240,
        top: 56,
        width: 1440,
        height: 900,
        borderRadius: 22,
        overflow: "hidden",
        backgroundColor: appLight.bg,
        boxShadow: windowShadow,
        outline: `1px solid ${landing.line}`,
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          scale: String(zoom),
          transformOrigin: `${focusX * 100}% ${focusY * 100}%`,
        }}
      >
        {src === "" ? (
          <PendingCapture shotId={shotId} />
        ) : kind === "video" ? (
          <Video src={staticFile(src)} premountFor={fps} muted objectFit="cover" style={{ width: "100%", height: "100%" }} />
        ) : (
          <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        )}
      </div>
    </Interactive.Div>
  );
};

const appWindowSchema = {
  src: { type: "asset", default: "", description: "Recording in public/" },
  kind: {
    type: "enum",
    default: "video",
    description: "Recording type",
    variants: { image: {}, video: {} },
  },
  shotId: { type: "text-content", default: "", description: "Shot id (placeholder)" },
  zoom: { type: "number", default: 1, min: 1, max: 3, step: 0.01, description: "Zoom", hiddenFromList: false },
  focusX: { type: "number", default: 0.5, min: 0, max: 1, step: 0.01, description: "Focus X", hiddenFromList: false },
  focusY: { type: "number", default: 0.5, min: 0, max: 1, step: 0.01, description: "Focus Y", hiddenFromList: false },
} as const satisfies InteractivitySchema;

export const AppWindow = Interactive.withSchema({
  Component: AppWindowInner,
  componentName: "<AppWindow>",
  schema: appWindowSchema,
  wrapInSequence: true,
});
