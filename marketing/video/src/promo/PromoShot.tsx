import type React from "react";
import { Interactive, useVideoConfig, type InteractivitySchema } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop } from "../components/Backdrop";
import { Subtitle } from "../components/Subtitle";

type PromoShotProps = {
  readonly shotId: string;
  // The trimmed recording in public/captures/. Empty until it is recorded: the window then shows the
  // "Capture pending" placeholder.
  readonly src: string;
  readonly subtitle: string;
  readonly style?: React.CSSProperties;
};

// One promo scene: a framed recording and the line of voice-over under it. Zooms and the speed badge
// are added per scene once the footage exists and its timing is known.
const PromoShotInner: React.FC<PromoShotProps> = ({ shotId, src, subtitle, style }) => {
  const { fps } = useVideoConfig();
  return (
    <Interactive.Div name="Promo shot" style={{ position: "absolute", inset: 0, ...style }}>
      <Backdrop>
        <AppWindow name="Window" src={src} kind="video" shotId={shotId} zoom={1} focusX={0.5} focusY={0.5} premountFor={fps} />
        <Subtitle name="Subtitle">{subtitle}</Subtitle>
      </Backdrop>
    </Interactive.Div>
  );
};

const promoShotSchema = {
  shotId: { type: "text-content", default: "", description: "Shot id" },
  src: { type: "asset", default: "", description: "Recording in public/" },
  subtitle: { type: "text-content", default: "", description: "Voice-over line" },
} as const satisfies InteractivitySchema;

export const PromoShot = Interactive.withSchema({
  Component: PromoShotInner,
  componentName: "<PromoShot>",
  schema: promoShotSchema,
  wrapInSequence: true,
});
