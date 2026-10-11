import { Audio } from "@remotion/media";
import type React from "react";
import { Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop } from "../components/Backdrop";
import { Subtitle } from "../components/Subtitle";

// A, docs guides/models.md: Models → Catalog → View model (size and memory estimate, nothing
// downloaded) → On device → the installed Qwen3.8-27B ("Fits this device", measured live) → Open chat.
// One take in real time from 3.4 s of public/captures/A-models.mov (A-models.json, minus the trim):
// Models 0.84 s, View model 6.33 s, close 12.32 s, On device 14.56 s, Open chat 21.36 s.
export const AModels: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Backdrop>
      <AppWindow
        name="A take"
        src="captures/A-models.mov"
        kind="video"
        shotId="A · Models"
        startAt={3.4}
        premountFor={fps}
        zoom={interpolate(
          frame,
          [6.9 * fps, 7.8 * fps, 12.0 * fps, 12.6 * fps, 15.0 * fps, 15.9 * fps, 20.8 * fps, 21.5 * fps, 22.4 * fps, 23.3 * fps],
          [1, 1.45, 1.45, 1, 1, 1.4, 1.4, 1, 1, 1.4],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.45, 0, 0.2, 1) },
        )}
        focusX={interpolate(frame, [12.6 * fps, 15.0 * fps, 21.5 * fps, 22.4 * fps], [0.5, 0.3, 0.3, 0.3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
        focusY={interpolate(frame, [12.6 * fps, 15.0 * fps, 21.5 * fps, 22.4 * fps], [0.6, 0.47, 0.47, 0.94], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
      />
      <Audio name="Voice: catalog" src={staticFile("audio/AModels/01-catalog.mp3")} from={0.4 * fps} premountFor={fps} />
      <Subtitle name="Caption: catalog" from={0.4 * fps} durationInFrames={5.3 * fps} premountFor={fps}>
        Models opens a catalog of models from Hugging Face. Open one to see what it needs.
      </Subtitle>
      <Audio name="Voice: estimate" src={staticFile("audio/AModels/02-estimate.mp3")} from={7.4 * fps} premountFor={fps} />
      <Subtitle name="Caption: estimate" from={7.4 * fps} durationInFrames={3.8 * fps} premountFor={fps}>
        Its size and memory estimate show before anything downloads.
      </Subtitle>
      <Audio name="Voice: device" src={staticFile("audio/AModels/03-device.mp3")} from={14.8 * fps} premountFor={fps} />
      <Subtitle name="Caption: device" from={14.8 * fps} durationInFrames={4.5 * fps} premountFor={fps}>
        Installed models live on device, checked against this Mac&apos;s memory.
      </Subtitle>
      <Audio name="Voice: chat" src={staticFile("audio/AModels/04-chat.mp3")} from={21.8 * fps} premountFor={fps} />
      <Subtitle name="Caption: chat" from={21.8 * fps} durationInFrames={4.8 * fps} premountFor={fps}>
        Open a chat, and the model is ready to use.
      </Subtitle>
    </Backdrop>
  );
};
