import type React from "react";
import { AbsoluteFill } from "remotion";
import { fonts } from "../brand/theme";

// Stands in for a recording that does not exist yet. It must never look like the app: a striped
// panel that names the shot, so a draft render cannot pass for real footage.
export const PendingCapture: React.FC<{ readonly shotId: string }> = ({ shotId }) => {
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        backgroundColor: "#1a1b1f",
        backgroundImage: "repeating-linear-gradient(135deg, #222329 0 18px, #1a1b1f 18px 36px)",
        fontFamily: fonts.mono,
        color: "#8d93a0",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 34, letterSpacing: "0.08em", textTransform: "uppercase" }}>Capture pending</div>
      <div style={{ fontSize: 30, color: "#c3c8d2" }}>{shotId}</div>
    </AbsoluteFill>
  );
};
