import { Audio } from "@remotion/media";
import type React from "react";
import { Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop } from "../components/Backdrop";
import { SpeedBadge } from "../components/SpeedBadge";
import { Subtitle } from "../components/Subtitle";

// D4, docs guides/synthesis.md: a real Synthesis run of the Rate limiter module on Qwen3.8-27B,
// Accepted on its first iteration (run afd17066, evidence in public/captures/D4-synthesis-evidence).
// Recording times (public/captures/D4-synthesis.json): Synthesis 4.0 s, Run 10.1 s, model load
// 11.8–19.3 s, writing src/rateLimiter.ts 19.3–73.5 s, checks pass 73.5 s, Diagnostics 77.3 s,
// behaviour gate 80.2 s, Changes 84.7 s, Apply 88.6 s.
// Three pieces of the one take: 3.0–12.0 s in real time; 12.0–73.3 s (loading and writing, 61.3 s)
// at 10× with the speed badge; 73.3–92.0 s in real time. In this edit: 0–9.0 s, 9.0–15.13 s,
// 15.13–33.83 s.
export const D4Synthesis: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(
    frame,
    [1.5 * fps, 2.5 * fps, 6.4 * fps, 7.0 * fps, 9.0 * fps, 9.8 * fps, 18.6 * fps, 19.4 * fps, 20.0 * fps, 21.0 * fps, 25.8 * fps, 26.6 * fps, 28.0 * fps, 29.0 * fps],
    [1, 1.45, 1.45, 1, 1, 1.35, 1.35, 1, 1, 1.45, 1.45, 1, 1, 1.3],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.45, 0, 0.2, 1) },
  );
  const focusX = interpolate(
    frame,
    [7.0 * fps, 9.0 * fps, 19.4 * fps, 20.0 * fps, 26.6 * fps, 28.0 * fps],
    [0.5, 0.6, 0.6, 0.98, 0.98, 0.55],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const focusY = interpolate(
    frame,
    [7.0 * fps, 9.0 * fps, 19.4 * fps, 20.0 * fps, 26.6 * fps, 28.0 * fps],
    [0.52, 0.82, 0.82, 0.55, 0.55, 0.42],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (
    <Backdrop>
      <AppWindow
        name="D4 real time: contract and Run"
        src="captures/D4-synthesis.mov"
        kind="video"
        shotId="D4 · Synthesis"
        startAt={3.0}
        durationInFrames={9.0 * fps}
        premountFor={fps}
        zoom={zoom}
        focusX={focusX}
        focusY={focusY}
      />
      <AppWindow
        name="D4 sped up 10×: loading and writing"
        src="captures/D4-synthesis.mov"
        kind="video"
        shotId="D4 · Synthesis"
        startAt={12.0}
        speed={10}
        from={9.0 * fps}
        durationInFrames={6.13 * fps}
        premountFor={fps}
        zoom={zoom}
        focusX={focusX}
        focusY={focusY}
      />
      <AppWindow
        name="D4 real time: checks and Apply"
        src="captures/D4-synthesis.mov"
        kind="video"
        shotId="D4 · Synthesis"
        startAt={73.3}
        from={15.13 * fps}
        durationInFrames={18.7 * fps}
        premountFor={fps}
        zoom={zoom}
        focusX={focusX}
        focusY={focusY}
      />
      <SpeedBadge name="Badge: loading and writing" label="Sped up 10× · 61 s → 6 s" from={9.0 * fps} durationInFrames={6.13 * fps} premountFor={fps} />
      <Audio name="Voice: contract" src={staticFile("audio/D4Synthesis/01-contract.mp3")} from={0.6 * fps} premountFor={fps} />
      <Subtitle name="Caption: contract" from={0.6 * fps} durationInFrames={5.3 * fps} premountFor={fps}>
        A module is a contract: the file to write, and the checks it has to pass.
      </Subtitle>
      <Audio name="Voice: run" src={staticFile("audio/D4Synthesis/02-run.mp3")} from={6.8 * fps} premountFor={fps} />
      <Subtitle name="Caption: run" from={6.8 * fps} durationInFrames={3.7 * fps} premountFor={fps}>
        Run synthesis. A model on this Mac writes the code.
      </Subtitle>
      <Audio name="Voice: checks" src={staticFile("audio/D4Synthesis/03-checks.mp3")} from={15.4 * fps} premountFor={fps} />
      <Subtitle name="Caption: checks" from={15.4 * fps} durationInFrames={5.9 * fps} premountFor={fps}>
        The checks run for real, in a sandbox. All six tests pass, and the run is accepted.
      </Subtitle>
      <Audio name="Voice: apply" src={staticFile("audio/D4Synthesis/04-apply.mp3")} from={27.4 * fps} premountFor={fps} />
      <Subtitle name="Caption: apply" from={27.4 * fps} durationInFrames={6.4 * fps} premountFor={fps}>
        Apply the verified patch, and the code lands in your project.
      </Subtitle>
    </Backdrop>
  );
};
