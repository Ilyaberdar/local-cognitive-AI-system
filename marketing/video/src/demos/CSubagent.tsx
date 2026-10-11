import { Audio } from "@remotion/media";
import type React from "react";
import { Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop } from "../components/Backdrop";
import { SpeedBadge } from "../components/SpeedBadge";
import { Subtitle } from "../components/Subtitle";

// C, docs guides/chats.md (subagents): a "Reviewer" subagent on the chat's own Qwen3.5-9B Q8_0, called
// with @Reviewer. One model, one llama-server: the main model's draft, the reviewer's turn and the
// final answer run one after another, and the voice-over says so (no claim of parallel work).
// public/captures/C-subagent.mov (C-subagent.json): add subagent 4.51 s, mention picked 13.38 s,
// Enter 21.19 s, live trace 23.75 s, answer with the card 246.40 s, card opened 250.22 s.
// Pieces: 3.4–30.0 s real time; 30.0–245.6 s (215.6 s) at 40× with the speed badge; 245.6–255.0 s
// real time. In this edit: 0–26.6 s, 26.6–31.99 s, 31.99–41.39 s.
export const CSubagent: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(
    frame,
    [0.6 * fps, 1.5 * fps, 7.6 * fps, 8.3 * fps, 8.4 * fps, 9.2 * fps, 18.0 * fps, 18.6 * fps, 20.6 * fps, 21.5 * fps, 26.4 * fps, 27.0 * fps, 33.0 * fps, 34.0 * fps],
    [1, 1.5, 1.5, 1, 1, 1.4, 1.4, 1, 1, 1.3, 1.3, 1, 1, 1.3],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.45, 0, 0.2, 1) },
  );
  const focusX = interpolate(frame, [8.3 * fps, 8.4 * fps, 18.6 * fps, 20.6 * fps, 27.0 * fps, 33.0 * fps], [0.86, 0.4, 0.4, 0.4, 0.4, 0.42], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const focusY = interpolate(frame, [8.3 * fps, 8.4 * fps, 18.6 * fps, 20.6 * fps, 27.0 * fps, 33.0 * fps], [0.6, 0.88, 0.88, 0.38, 0.38, 0.5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Backdrop>
      <AppWindow name="C real time: set up and ask" src="captures/C-subagent.mov" kind="video" shotId="C · Subagent" startAt={3.4} durationInFrames={26.6 * fps} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <AppWindow name="C sped up 40×: the turns" src="captures/C-subagent.mov" kind="video" shotId="C · Subagent" startAt={30.0} speed={40} from={26.6 * fps} durationInFrames={5.39 * fps} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <AppWindow name="C real time: the card" src="captures/C-subagent.mov" kind="video" shotId="C · Subagent" startAt={245.6} from={31.99 * fps} durationInFrames={9.4 * fps} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <SpeedBadge name="Badge: the turns" label="Sped up 40× · 3 min 36 s → 5 s" from={26.6 * fps} durationInFrames={5.39 * fps} premountFor={fps} />
      <Audio name="Voice: add" src={staticFile("audio/CSubagent/01-add.mp3")} from={0.5 * fps} premountFor={fps} />
      <Subtitle name="Caption: add" from={0.5 * fps} durationInFrames={3.5 * fps} premountFor={fps}>
        Add a subagent in Session Setup, and give it a name.
      </Subtitle>
      <Audio name="Voice: mention" src={staticFile("audio/CSubagent/02-mention.mp3")} from={8.4 * fps} premountFor={fps} />
      <Subtitle name="Caption: mention" from={8.4 * fps} durationInFrames={2.6 * fps} premountFor={fps}>
        Call it with an @-mention in your message.
      </Subtitle>
      <Audio name="Voice: turns" src={staticFile("audio/CSubagent/03-turns.mp3")} from={21.0 * fps} premountFor={fps} />
      <Subtitle name="Caption: turns" from={21.0 * fps} durationInFrames={5.9 * fps} premountFor={fps}>
        The main model drafts, then hands the work to the reviewer. One model runs them in turn.
      </Subtitle>
      <Audio name="Voice: card" src={staticFile("audio/CSubagent/04-card.mp3")} from={33.2 * fps} premountFor={fps} />
      <Subtitle name="Caption: card" from={33.2 * fps} durationInFrames={4.8 * fps} premountFor={fps}>
        The reviewer&apos;s findings arrive in their own card, next to the final answer.
      </Subtitle>
    </Backdrop>
  );
};
