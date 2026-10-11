import type React from "react";
import { AbsoluteFill } from "remotion";
import "../brand/fonts";
import { dotGrid, dotGridSize, fonts, landing } from "../brand/theme";

// The landing page's dotted light background, behind every title card and framed recording.
export const Backdrop: React.FC<{ readonly children?: React.ReactNode }> = ({ children }) => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: landing.bg,
        backgroundImage: dotGrid,
        backgroundSize: dotGridSize,
        fontFamily: fonts.sans,
        color: landing.ink,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
