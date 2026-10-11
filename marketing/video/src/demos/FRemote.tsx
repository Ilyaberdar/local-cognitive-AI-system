import { Audio } from "@remotion/media";
import type React from "react";
import { Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop } from "../components/Backdrop";
import { SpeedBadge } from "../components/SpeedBadge";
import { Subtitle } from "../components/Subtitle";

// F, docs guides/remote.md: the owner's installed app (the only one paired with their server; the owner
// allowed recording it), the sidebar collapsed to its icons, This computer → fedora, the release-
// checklist request answered by Qwen2.5-14B on the server's GTX 1070 Ti (29.6 s, 430 tokens).
// public/captures/F-remote.mov (F-remote.json, minus its 0.17 s offset): switch 4.42 s, fedora 7.22 s,
// paste 13.19 s, Enter 14.98 s, server busy 16.67–46.32 s. Pieces: 3.4–16.4 s real time; 16.4–46.4 s
// (the answer streaming, 30 s) at 3× with the speed badge; 46.4–50.6 s real time.
// In this edit: 0–13.0 s, 13.0–23.0 s, 23.0–27.2 s. The owner's avatar (bottom left) is blurred.
const avatar = [{ x: 0.004, y: 0.925, width: 0.04, height: 0.07 }];

export const FRemote: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(
    frame,
    [0.4 * fps, 1.2 * fps, 5.6 * fps, 6.3 * fps, 8.6 * fps, 9.3 * fps, 12.8 * fps, 13.6 * fps, 22.6 * fps, 23.6 * fps],
    [1, 1.6, 1.6, 1, 1, 1.35, 1.35, 1.2, 1.2, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.45, 0, 0.2, 1) },
  );
  const focusX = interpolate(frame, [6.3 * fps, 8.6 * fps, 13.0 * fps], [0.92, 0.05, 0.3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const focusY = interpolate(frame, [6.3 * fps, 8.6 * fps, 13.0 * fps], [0.04, 0.9, 0.3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Backdrop>
      <AppWindow name="F real time: switch and ask" src="captures/F-remote.mov" kind="video" shotId="F · Remote" startAt={3.4} durationInFrames={Math.round(13.0 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} redact={avatar} />
      <AppWindow name="F 3×: the answer streaming" src="captures/F-remote.mov" kind="video" shotId="F · Remote" startAt={16.4} speed={3} from={Math.round(13.0 * fps)} durationInFrames={Math.round(10.0 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} redact={avatar} />
      <AppWindow name="F real time: the answer" src="captures/F-remote.mov" kind="video" shotId="F · Remote" startAt={46.4} from={Math.round(23.0 * fps)} durationInFrames={Math.round(4.2 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} redact={avatar} />
      <SpeedBadge name="Badge: streaming" label="Sped up 3× · 30 s → 10 s" from={Math.round(13.0 * fps)} durationInFrames={Math.round(10.0 * fps)} premountFor={fps} />
      <Audio name="Voice: switch" src={staticFile("audio/FRemote/01-switch.mp3")} from={0.5 * fps} premountFor={fps} />
      <Subtitle name="Caption: switch" from={0.5 * fps} durationInFrames={4.8 * fps} premountFor={fps}>
        Switch where the chat runs: from this computer to your own GPU server.
      </Subtitle>
      <Audio name="Voice: ask" src={staticFile("audio/FRemote/02-ask.mp3")} from={8.8 * fps} premountFor={fps} />
      <Subtitle name="Caption: ask" from={8.8 * fps} durationInFrames={3.0 * fps} premountFor={fps}>
        The same request now goes to the server.
      </Subtitle>
      <Audio name="Voice: stream" src={staticFile("audio/FRemote/03-stream.mp3")} from={13.6 * fps} premountFor={fps} />
      <Subtitle name="Caption: stream" from={13.6 * fps} durationInFrames={7.0 * fps} premountFor={fps}>
        A model on the server&apos;s NVIDIA GPU writes the answer, and it streams back end-to-end encrypted.
      </Subtitle>
      <Audio name="Voice: done" src={staticFile("audio/FRemote/04-done.mp3")} from={23.6 * fps} premountFor={fps} />
      <Subtitle name="Caption: done" from={23.6 * fps} durationInFrames={3.6 * fps} premountFor={fps}>
        Your prompts stay on your own machines.
      </Subtitle>
    </Backdrop>
  );
};
