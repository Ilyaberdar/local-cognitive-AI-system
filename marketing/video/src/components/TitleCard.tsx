import type React from "react";
import { Img, Interactive, staticFile, type InteractivitySchema } from "remotion";
import "../brand/fonts";
import { fonts, landing } from "../brand/theme";

type TitleCardProps = {
  readonly eyebrow: string;
  readonly headline: string;
  readonly showLogo: boolean;
  readonly style?: React.CSSProperties;
};

// A mono eyebrow over a Geist headline, as the landing's section heads (.eyebrow + .h2).
const TitleCardInner: React.FC<TitleCardProps> = ({ eyebrow, headline, showLogo, style }) => {
  return (
    <Interactive.Div
      name="Title card"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        padding: "0 160px",
        textAlign: "center",
        fontFamily: fonts.sans,
        color: landing.ink,
        ...style,
      }}
    >
      {showLogo ? <Img src={staticFile("brand/logo-1024.png")} style={{ width: 132, height: 132 }} /> : null}
      {eyebrow ? (
        <div style={{ fontFamily: fonts.mono, fontSize: 30, color: landing.accent, letterSpacing: "0.01em" }}>
          {eyebrow}
        </div>
      ) : null}
      <div style={{ fontSize: 96, fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1.04, maxWidth: 1400 }}>
        {headline}
      </div>
    </Interactive.Div>
  );
};

const titleCardSchema = {
  eyebrow: { type: "text-content", default: "", description: "Eyebrow (mono)" },
  headline: { type: "text-content", default: "", description: "Headline" },
  showLogo: { type: "boolean", default: false, description: "Show logo" },
} as const satisfies InteractivitySchema;

export const TitleCard = Interactive.withSchema({
  Component: TitleCardInner,
  componentName: "<TitleCard>",
  schema: titleCardSchema,
  wrapInSequence: true,
});
