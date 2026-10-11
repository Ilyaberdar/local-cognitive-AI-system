import { Audio } from "@remotion/media";
import type React from "react";
import { Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop } from "../components/Backdrop";
import { SpeedBadge } from "../components/SpeedBadge";
import { Subtitle } from "../components/Subtitle";

// B, docs guides/chats.md and start/first-steps.md: the owner's launch notes as a release-checklist
// request, typed for real and answered by Qwen3.8-27B on this Mac (47.6 s, 485 tokens), streaming
// in as it is written and then replaced by the formatted answer.
// public/captures/B-chat.mov (B-chat.json): typing 4.6–12.2 s, Enter 13.26 s, first text 33.26 s,
// done 61.20 s. Pieces: 3.4–13.5 s real time; 13.5–33.1 s (the wait, 19.6 s) at 8×; 33.1–61.1 s
// (the stream, 28 s) at 2×; 61.1–65.5 s real time. Both shortened pieces carry the speed badge.
// In this edit: 0–10.1 s, 10.1–12.55 s, 12.55–26.55 s, 26.55–30.95 s.
export const BChat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(
    frame,
    [1.0 * fps, 1.8 * fps, 9.6 * fps, 10.2 * fps, 12.6 * fps, 13.4 * fps, 27.0 * fps, 27.8 * fps],
    [1, 1.4, 1.4, 1, 1, 1.3, 1.3, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.45, 0, 0.2, 1) },
  );
  const focusX = interpolate(frame, [10.2 * fps, 12.6 * fps], [0.4, 0.35], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const focusY = interpolate(frame, [10.2 * fps, 12.6 * fps], [0.88, 0.45], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Backdrop>
      <AppWindow name="B real time: typing" src="captures/B-chat.mov" kind="video" shotId="B · Chat" startAt={3.4} durationInFrames={Math.round(10.1 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <AppWindow name="B 8×: the wait" src="captures/B-chat.mov" kind="video" shotId="B · Chat" startAt={13.5} speed={8} from={Math.round(10.1 * fps)} durationInFrames={Math.round(2.45 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <AppWindow name="B 2×: the stream" src="captures/B-chat.mov" kind="video" shotId="B · Chat" startAt={33.1} speed={2} from={Math.round(12.55 * fps)} durationInFrames={Math.round(14 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <AppWindow name="B real time: the answer" src="captures/B-chat.mov" kind="video" shotId="B · Chat" startAt={61.1} from={Math.round(26.55 * fps)} durationInFrames={Math.round(4.4 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <SpeedBadge name="Badge: the wait" label="Sped up 8× · 20 s → 2.5 s" from={Math.round(10.1 * fps)} durationInFrames={Math.round(2.45 * fps)} premountFor={fps} />
      <SpeedBadge name="Badge: the stream" label="Sped up 2× · 28 s → 14 s" from={Math.round(12.55 * fps)} durationInFrames={Math.round(14 * fps)} premountFor={fps} />
      <Audio name="Voice: ask" src={staticFile("audio/BChat/01-ask.mp3")} from={0.3 * fps} premountFor={fps} />
      <Subtitle name="Caption: ask" from={0.3 * fps} durationInFrames={2.7 * fps} premountFor={fps}>
        Pick a local model, and ask anything.
      </Subtitle>
      <Audio name="Voice: local" src={staticFile("audio/BChat/02-local.mp3")} from={9.9 * fps} premountFor={fps} />
      <Subtitle name="Caption: local" from={9.9 * fps} durationInFrames={3.5 * fps} premountFor={fps}>
        The model runs on this Mac. Your prompt never leaves it.
      </Subtitle>
      <Audio name="Voice: stream" src={staticFile("audio/BChat/03-stream.mp3")} from={13.6 * fps} premountFor={fps} />
      <Subtitle name="Caption: stream" from={13.6 * fps} durationInFrames={5.4 * fps} premountFor={fps}>
        The answer streams in as the model writes it: owners, dates and risks.
      </Subtitle>
      <Audio name="Voice: apply" src={staticFile("audio/BChat/04-apply.mp3")} from={26.7 * fps} premountFor={fps} />
      <Subtitle name="Caption: apply" from={26.7 * fps} durationInFrames={4.2 * fps} premountFor={fps}>
        When it finishes, the formatted answer takes its place.
      </Subtitle>
    </Backdrop>
  );
};
