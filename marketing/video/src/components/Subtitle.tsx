import type React from "react";
import { Interactive, type InteractivitySchema } from "remotion";
import "../brand/fonts";
import { fonts, landing } from "../brand/theme";

type SubtitleProps = {
  readonly children: string;
  readonly style?: React.CSSProperties;
};

// One line of the voice-over, in the band under the app window so it never covers the interface.
// Up to two lines fit the band (956–1080 px) without touching the window.
const SubtitleInner: React.FC<SubtitleProps> = ({ children, style }) => {
  return (
    <Interactive.Div
      name="Subtitle"
      style={{
        position: "absolute",
        left: 120,
        right: 120,
        bottom: 18,
        textAlign: "center",
        fontFamily: fonts.sans,
        fontSize: 37,
        fontWeight: 500,
        lineHeight: 1.18,
        letterSpacing: "-0.01em",
        color: landing.ink,
        ...style,
      }}
    >
      {children}
    </Interactive.Div>
  );
};

const subtitleSchema = {
  children: { type: "text-content", default: "", description: "Text" },
} as const satisfies InteractivitySchema;

export const Subtitle = Interactive.withSchema({
  Component: SubtitleInner,
  componentName: "<Subtitle>",
  schema: subtitleSchema,
  wrapInSequence: true,
});
