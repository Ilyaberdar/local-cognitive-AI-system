import { Audio } from "@remotion/media";
import type React from "react";
import { Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop } from "../components/Backdrop";
import { SpeedBadge } from "../components/SpeedBadge";
import { Subtitle } from "../components/Subtitle";

// B, docs guides/chats.md and start/first-steps.md: the owner's demo prompt typed for real and
// answered by Qwen3.8-27B on this Mac (22.2 s, 281 tokens; the model lists the three notes as
// numbered action items, the same answer it gave at every Effort in rehearsal).
// public/captures/B-chat.mov (B-chat.json): typing 4.7–12.0 s, Enter 12.72 s, first text 32.22 s,
// done 35.02 s. Pieces: 3.4–13.2 s real time; 13.2–31.8 s (the wait, 18.6 s) at 6× with the speed
// badge; 31.8–39.3 s real time. In this edit: 0–9.8 s, 9.8–12.9 s, 12.9–20.4 s.
export const BChat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(
    frame,
    [1.0 * fps, 1.8 * fps, 9.4 * fps, 10.0 * fps, 13.6 * fps, 14.5 * fps],
    [1, 1.4, 1.4, 1, 1, 1.35],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.45, 0, 0.2, 1) },
  );
  const focusX = interpolate(frame, [10.0 * fps, 13.6 * fps], [0.4, 0.3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const focusY = interpolate(frame, [10.0 * fps, 13.6 * fps], [0.88, 0.42], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Backdrop>
      <AppWindow name="B real time: typing" src="captures/B-chat.mov" kind="video" shotId="B · Chat" startAt={3.4} durationInFrames={9.8 * fps} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <AppWindow name="B sped up 6×: the wait" src="captures/B-chat.mov" kind="video" shotId="B · Chat" startAt={13.2} speed={6} from={9.8 * fps} durationInFrames={3.1 * fps} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <AppWindow name="B real time: the answer" src="captures/B-chat.mov" kind="video" shotId="B · Chat" startAt={31.8} from={12.9 * fps} durationInFrames={7.5 * fps} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <SpeedBadge name="Badge: the wait" label="Sped up 6× · 19 s → 3 s" from={9.8 * fps} durationInFrames={3.1 * fps} premountFor={fps} />
      <Audio name="Voice: ask" src={staticFile("audio/BChat/01-ask.mp3")} from={0.3 * fps} premountFor={fps} />
      <Subtitle name="Caption: ask" from={0.3 * fps} durationInFrames={2.7 * fps} premountFor={fps}>
        Pick a local model, and ask anything.
      </Subtitle>
      <Audio name="Voice: local" src={staticFile("audio/BChat/02-local.mp3")} from={9.6 * fps} premountFor={fps} />
      <Subtitle name="Caption: local" from={9.6 * fps} durationInFrames={3.6 * fps} premountFor={fps}>
        The model runs on this Mac. Your prompt never leaves it.
      </Subtitle>
      <Audio name="Voice: answer" src={staticFile("audio/BChat/03-answer.mp3")} from={13.6 * fps} premountFor={fps} />
      <Subtitle name="Caption: answer" from={13.6 * fps} durationInFrames={6.8 * fps} premountFor={fps}>
        Here is the answer: three action items.
      </Subtitle>
    </Backdrop>
  );
};
