import type React from "react";
import { Interactive, type InteractivitySchema } from "remotion";
import "../brand/fonts";
import { fonts, landing } from "../brand/theme";

type SpeedBadgeProps = {
  // What was cut, in plain words: "Sped up 8×", "Download shortened: 2 min → 4 s".
  readonly label: string;
  readonly style?: React.CSSProperties;
};

// Required on every stretch where waiting time was shortened in the edit. It sits above the window's
// top-right corner for the whole shortened stretch, so it never covers the app.
const SpeedBadgeInner: React.FC<SpeedBadgeProps> = ({ label, style }) => {
  return (
    <Interactive.Div
      name="Speed badge"
      style={{
        position: "absolute",
        right: 240,
        top: 6,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "6px 16px",
        borderRadius: 999,
        backgroundColor: "rgba(255, 255, 255, 0.94)",
        border: `1px solid ${landing.line}`,
        boxShadow: "0 8px 24px rgba(16, 19, 26, 0.18)",
        fontFamily: fonts.sans,
        fontSize: 26,
        fontWeight: 500,
        color: landing.ink2,
        ...style,
      }}
    >
      <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden>
        <path d="M1 1 L11 9 L1 17 Z M13 1 L23 9 L13 17 Z" fill={landing.accent} />
      </svg>
      {label}
    </Interactive.Div>
  );
};

const speedBadgeSchema = {
  label: { type: "text-content", default: "Sped up", description: "Label" },
} as const satisfies InteractivitySchema;

export const SpeedBadge = Interactive.withSchema({
  Component: SpeedBadgeInner,
  componentName: "<SpeedBadge>",
  schema: speedBadgeSchema,
  wrapInSequence: true,
});
