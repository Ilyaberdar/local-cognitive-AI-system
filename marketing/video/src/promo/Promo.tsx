import { Audio } from "@remotion/media";
import type React from "react";
import { Easing, interpolate, Series, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop } from "../components/Backdrop";
import { SpeedBadge } from "../components/SpeedBadge";
import { Subtitle } from "../components/Subtitle";
import { TitleCard } from "../components/TitleCard";
import { StyleEnd } from "../scenes/StyleBoard";

// The 40-second promo, cut from the same real takes as the docs demos (public/captures/*.mov and their
// action logs). Every shortened wait carries the speed badge; the voice-over (voice/Promo.json, the
// chosen voice) says only what the footage shows. Remote waits for its recording.
const ease = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.45, 0, 0.2, 1) } as const;

const Line: React.FC<{ readonly id: string; readonly at: number; readonly seconds: number; readonly children: string }> = ({ id, at, seconds, children }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      <Audio name={`Voice: ${id}`} src={staticFile(`audio/Promo/${id}.mp3`)} from={Math.round(at * fps)} premountFor={fps} />
      <Subtitle name={`Caption: ${id}`} from={Math.round(at * fps)} durationInFrames={Math.round(seconds * fps)} premountFor={fps}>
        {children}
      </Subtitle>
    </>
  );
};

// Chat (B): the last lines typed, the wait at 10×, the answer arriving.
const ChatScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(frame, [0, 0.6 * fps, 2.3 * fps, 2.6 * fps, 4.4 * fps, 5.2 * fps], [1.25, 1.4, 1.4, 1, 1, 1.35], ease);
  const focusX = interpolate(frame, [2.5 * fps, 4.4 * fps], [0.4, 0.3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const focusY = interpolate(frame, [2.5 * fps, 4.4 * fps], [0.88, 0.42], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Backdrop>
      <AppWindow name="Typing" src="captures/B-chat.mov" kind="video" shotId="B" startAt={9.0} durationInFrames={Math.round(2.5 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <AppWindow name="Wait 10×" src="captures/B-chat.mov" kind="video" shotId="B" startAt={12.7} speed={10} from={Math.round(2.5 * fps)} durationInFrames={Math.round(1.93 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <AppWindow name="Answer" src="captures/B-chat.mov" kind="video" shotId="B" startAt={32.0} from={Math.round(4.43 * fps)} durationInFrames={Math.round(3.07 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <SpeedBadge name="Badge" label="Sped up 10× · 19 s → 2 s" from={Math.round(2.5 * fps)} durationInFrames={Math.round(1.93 * fps)} premountFor={fps} />
      <Line id="02-chat" at={0.3} seconds={4.8}>Chat with models that run on your own computer. Prompts and answers stay there.</Line>
    </Backdrop>
  );
};

// Models (A): the memory estimate before a download, then the installed model that fits this Mac.
const ModelsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(frame, [0, 0.8 * fps, 2.7 * fps, 3.0 * fps, 3.1 * fps, 3.8 * fps], [1.2, 1.45, 1.45, 1.25, 1.2, 1.4], ease);
  const focusX = frame < 3 * fps ? 0.5 : 0.3;
  const focusY = frame < 3 * fps ? 0.6 : 0.47;
  return (
    <Backdrop>
      <AppWindow name="Estimate" src="captures/A-models.mov" kind="video" shotId="A" startAt={9.9} durationInFrames={Math.round(3 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <AppWindow name="On device" src="captures/A-models.mov" kind="video" shotId="A" startAt={18.4} from={Math.round(3 * fps)} durationInFrames={Math.round(3 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <Line id="03-models" at={0.3} seconds={4.2}>Pick a model from Hugging Face. Memory is checked before the download.</Line>
    </Backdrop>
  );
};

// Workflow (D3): the console filling live, then Approve and done, in real time.
const WorkflowScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(frame, [0, 0.6 * fps, 3.3 * fps, 3.5 * fps, 4.0 * fps, 5.6 * fps, 6.3 * fps], [1.3, 1.5, 1.5, 1.45, 1.5, 1.5, 1.1], ease);
  const focusX = frame < 3.5 * fps ? 0.42 : 0.46;
  const focusY = frame < 3.5 * fps ? 0.9 : 0.4;
  return (
    <Backdrop>
      <AppWindow name="Console" src="captures/D3-workflow.mov" kind="video" shotId="D3" startAt={10.0} durationInFrames={Math.round(3.5 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <AppWindow name="Approve" src="captures/D3-workflow.mov" kind="video" shotId="D3" startAt={17.6} from={Math.round(3.5 * fps)} durationInFrames={Math.round(3.5 * fps)} premountFor={fps} zoom={zoom} focusX={focusX} focusY={focusY} />
      <Line id="04-workflow" at={0.3} seconds={4.0}>Chain agents, files and commands, and watch every step run.</Line>
    </Backdrop>
  );
};

// Synthesis (D4): Run, the model writing at 25×, the real tests passing and Accepted.
const SynthesisScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(frame, [2.4 * fps, 3.0 * fps], [1, 1.35], ease);
  return (
    <Backdrop>
      <AppWindow name="Run" src="captures/D4-synthesis.mov" kind="video" shotId="D4" startAt={8.5} durationInFrames={Math.round(2.5 * fps)} premountFor={fps} zoom={zoom} focusX={0.6} focusY={0.82} />
      <AppWindow name="Writing 25×" src="captures/D4-synthesis.mov" kind="video" shotId="D4" startAt={11.0} speed={25} from={Math.round(2.5 * fps)} durationInFrames={Math.round(2.49 * fps)} premountFor={fps} zoom={zoom} focusX={0.6} focusY={0.82} />
      <AppWindow name="Accepted" src="captures/D4-synthesis.mov" kind="video" shotId="D4" startAt={73.3} from={Math.round(4.99 * fps)} durationInFrames={Math.round(2.01 * fps)} premountFor={fps} zoom={zoom} focusX={0.6} focusY={0.82} />
      <SpeedBadge name="Badge" label="Sped up 25× · 62 s → 2.5 s" from={Math.round(2.5 * fps)} durationInFrames={Math.round(2.49 * fps)} premountFor={fps} />
      <Line id="05-synthesis" at={0.3} seconds={5.2}>Synthesis writes code against a contract, and real tests decide when it is done.</Line>
    </Backdrop>
  );
};

export const Promo: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <Series>
      <Series.Sequence name="P1 Open" durationInFrames={264} premountFor={fps}>
        <Backdrop>
          <TitleCard name="Title" eyebrow="Local Cognitive" headline="Private AI on your own machines." showLogo />
          <Line id="01-open" at={0.3} seconds={4.0}>This is Local Cognitive: private AI on your own machines.</Line>
        </Backdrop>
      </Series.Sequence>
      <Series.Sequence name="P2 Chat" durationInFrames={450} premountFor={fps}>
        <ChatScene />
      </Series.Sequence>
      <Series.Sequence name="P3 Models" durationInFrames={360} premountFor={fps}>
        <ModelsScene />
      </Series.Sequence>
      <Series.Sequence name="P4 Workflow" durationInFrames={420} premountFor={fps}>
        <WorkflowScene />
      </Series.Sequence>
      <Series.Sequence name="P5 Synthesis" durationInFrames={420} premountFor={fps}>
        <SynthesisScene />
      </Series.Sequence>
      <Series.Sequence name="P6 Remote (pending)" durationInFrames={300} premountFor={fps}>
        <Backdrop>
          <AppWindow name="F" src="" kind="video" shotId="F · This computer → your GPU server" zoom={1} focusX={0.5} focusY={0.5} />
          <Line id="06-remote" at={0.3} seconds={4.4}>Connect your own GPU server with one key, end-to-end encrypted.</Line>
        </Backdrop>
      </Series.Sequence>
      <Series.Sequence name="P7 End" durationInFrames={186} premountFor={fps}>
        <StyleEnd />
        <Line id="07-end" at={0.3} seconds={2.8}>Get it at local-cognitive.com.</Line>
      </Series.Sequence>
    </Series>
  );
};
