import { Video } from "@remotion/media";
import type React from "react";
import { AbsoluteFill, staticFile, useVideoConfig } from "remotion";

// One real-time piece of a recording, full frame, for the screens in the Blender film
// (marketing/blender). No window frame, captions or badges: the film draws its own glass around it.
// Redacted areas are blurred as in the docs videos.
export type ScreenProps = {
  readonly src: string;
  readonly startAt: number;
  readonly redact?: ReadonlyArray<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }>;
};

export const Screen: React.FC<ScreenProps> = ({ src, startAt, redact = [] }) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Video src={staticFile(src)} muted trimBefore={Math.round(startAt * fps)} objectFit="cover" style={{ width: "100%", height: "100%" }} />
      {redact.map((area, index) => (
        <div
          key={index}
          style={{
            position: "absolute",
            left: `${area.x * 100}%`,
            top: `${area.y * 100}%`,
            width: `${area.width * 100}%`,
            height: `${area.height * 100}%`,
            borderRadius: 12,
            backdropFilter: "blur(14px)",
            backgroundColor: "rgba(226, 232, 239, 0.55)",
          }}
        />
      ))}
    </AbsoluteFill>
  );
};

// The pieces the film uses, each 4 s in real time (no speed-up, so no badge is needed).
export const SCREENS: Record<string, ScreenProps> = {
  chat: { src: "captures/B-chat.mov", startAt: 40.0 },
  workflow: { src: "captures/D3-workflow.mov", startAt: 9.0 },
  // The owner's avatar is blurred, as in the docs video.
  remote: { src: "captures/F-remote.mov", startAt: 6.4, redact: [{ x: 0.004, y: 0.925, width: 0.04, height: 0.07 }] },
  accepted: { src: "captures/D4-synthesis.mov", startAt: 72.5 },
};
