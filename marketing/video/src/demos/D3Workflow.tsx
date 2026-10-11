import { Audio } from "@remotion/media";
import type React from "react";
import { Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop } from "../components/Backdrop";
import { Subtitle } from "../components/Subtitle";

// D3, docs guides/workflows.md: a task runs the Workflow Console Demo. One continuous take in real
// time (no cuts, so no speed badge): the take starts 3.2 s into public/captures/D3-workflow.mov.
// Times below are from the action log D3-workflow.json minus that trim: Workflow 1.05 s, task card
// 2.8 s, Run 5.5 s, first stdout 6.6 s, stderr 10.2 s, review waiting 12.0 s, Approve 15.1 s,
// done 15.3 s. Voice-over: voice/D3Workflow.json, spoken by the chosen voice (scripts/voice/generate.mjs);
// each caption shows its line for as long as it is spoken (3.11, 2.83, 3.02 and 3.90 s).
export const D3Workflow: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Backdrop>
      <AppWindow
        name="D3 take"
        src="captures/D3-workflow.mov"
        kind="video"
        shotId="D3 · Workflow run with approval"
        trimBefore={3.2 * fps}
        premountFor={fps}
        zoom={interpolate(
          frame,
          [1.6 * fps, 2.6 * fps, 5.0 * fps, 5.6 * fps, 5.8 * fps, 6.6 * fps, 15.6 * fps, 16.6 * fps],
          [1, 1.4, 1.4, 1, 1, 1.5, 1.5, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.45, 0, 0.2, 1) },
        )}
        focusX={interpolate(
          frame,
          [5.6 * fps, 5.8 * fps, 11.9 * fps, 12.7 * fps],
          [0.29, 0.42, 0.42, 0.46],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.45, 0, 0.2, 1) },
        )}
        focusY={interpolate(
          frame,
          [5.6 * fps, 5.8 * fps, 11.9 * fps, 12.7 * fps],
          [0.38, 0.9, 0.9, 0.4],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.45, 0, 0.2, 1) },
        )}
      />
      <Audio name="Voice: task" src={staticFile("audio/D3Workflow/01-task.mp3")} from={0.3 * fps} premountFor={fps} />
      <Subtitle name="Caption: task" from={0.3 * fps} durationInFrames={3.5 * fps} premountFor={fps}>
        A task runs a workflow. Press Run on its card.
      </Subtitle>
      <Audio name="Voice: console" src={staticFile("audio/D3Workflow/02-console.mp3")} from={6.2 * fps} premountFor={fps} />
      <Subtitle name="Caption: console" from={6.2 * fps} durationInFrames={3.2 * fps} premountFor={fps}>
        The console shows the command&apos;s output as it runs.
      </Subtitle>
      <Audio name="Voice: review" src={staticFile("audio/D3Workflow/03-review.mp3")} from={12.0 * fps} premountFor={fps} />
      <Subtitle name="Caption: review" from={12.0 * fps} durationInFrames={3.2 * fps} premountFor={fps}>
        The run stops at the review step and waits for you.
      </Subtitle>
      <Audio name="Voice: done" src={staticFile("audio/D3Workflow/04-done.mp3")} from={15.3 * fps} premountFor={fps} />
      <Subtitle name="Caption: done" from={15.3 * fps} durationInFrames={4.0 * fps} premountFor={fps}>
        Approve, and the run finishes. All six steps passed.
      </Subtitle>
    </Backdrop>
  );
};
