import type React from "react";
import { Interactive, type InteractivitySchema } from "remotion";
import "../brand/fonts";
import { fonts, landing } from "../brand/theme";

type CalloutProps = {
  readonly children: string;
  readonly style?: React.CSSProperties;
};

// A short label next to the part of the interface being shown. Place it with style.left/top at the
// call site; it names what the viewer sees and never states a result the recording does not show.
const CalloutInner: React.FC<CalloutProps> = ({ children, style }) => {
  return (
    <Interactive.Div
      name="Callout"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        padding: "12px 20px",
        borderRadius: 14,
        backgroundColor: landing.card,
        border: `1px solid ${landing.line}`,
        borderLeft: `4px solid ${landing.accent}`,
        boxShadow: "0 12px 32px rgba(16, 19, 26, 0.22)",
        fontFamily: fonts.sans,
        fontSize: 30,
        fontWeight: 500,
        color: landing.ink,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </Interactive.Div>
  );
};

const calloutSchema = {
  children: { type: "text-content", default: "", description: "Text" },
} as const satisfies InteractivitySchema;

export const Callout = Interactive.withSchema({
  Component: CalloutInner,
  componentName: "<Callout>",
  schema: calloutSchema,
  wrapInSequence: true,
});
