import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import type React from "react";
import { interpolate, staticFile, useVideoConfig } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { TitleCard } from "../components/TitleCard";
import { StyleEnd } from "../scenes/StyleBoard";
import { AModels } from "./AModels";
import { BChat } from "./BChat";
import { CSubagent } from "./CSubagent";
import { D3Workflow } from "./D3Workflow";
import { D4Synthesis } from "./D4Synthesis";
import { FRemote } from "./FRemote";

// Every docs demo in one video: an opening, a title card per feature (the landing's headings), each
// demo as published in the docs (its own voice-over, captions and speed badges), and the end card.
const Section: React.FC<{ readonly eyebrow: string; readonly headline: string }> = ({ eyebrow, headline }) => (
  <Backdrop>
    <TitleCard name="Section" eyebrow={eyebrow} headline={headline} showLogo={false} />
  </Backdrop>
);

// The scene lengths below (keep them in step), each overlapping the next by a 12-frame dissolve. The
// music is quiet under the demos, which carry their own voice-over, and rises on the title cards.
const SCENES: ReadonlyArray<readonly [number, "voice" | "card"]> = [[264, "voice"], [132, "card"], [1596, "voice"], [132, "card"], [1857, "voice"], [132, "card"],
  [2484, "voice"], [132, "card"], [1158, "voice"], [132, "card"], [2030, "voice"], [132, "card"], [1632, "voice"], [390, "voice"]];
const CARDS = SCENES.reduce<{ start: number; cards: Array<readonly [number, number]> }>((acc, [length, kind], index) => {
  const start = acc.start - (index ? 12 : 0);
  return { start: start + length, cards: kind === "card" ? [...acc.cards, [start, start + length] as const] : acc.cards };
}, { start: 0, cards: [] }).cards;
const TOTAL = SCENES.reduce((sum, [length]) => sum + length, 0) - 12 * (SCENES.length - 1);
const musicVolume = (frame: number) => {
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const card = Math.max(...CARDS.map(([start, end]) => interpolate(frame, [start - 18, start + 6, end - 6, end + 18], [0, 1, 1, 0], clamp)));
  return (0.07 + 0.13 * card) * interpolate(frame, [0, 30, TOTAL - 120, TOTAL], [0, 1, 1, 0], clamp);
};

export const Overview: React.FC = () => {
  const { fps } = useVideoConfig();
  const crossfade = <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 12 })} />;
  return (
    <>
    <Audio name="Music" src={staticFile("audio/music/overview.mp3")} volume={musicVolume} />
    <TransitionSeries name="Overview">
      <TransitionSeries.Sequence name="Opening" durationInFrames={264} premountFor={fps}>
        <Backdrop>
          <TitleCard name="Title" eyebrow="Local Cognitive" headline="Private AI on your own machines." showLogo />
          <Audio name="Voice: intro" src={staticFile("audio/Overview/01-intro.mp3")} from={0.4 * fps} premountFor={fps} />
        </Backdrop>
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="Card: Models" durationInFrames={132} premountFor={fps}>
        <Section eyebrow="Models" headline="Any model on the hardware you have." />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="A Models" durationInFrames={1596} premountFor={fps}>
        <AModels />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="Card: Chat" durationInFrames={132} premountFor={fps}>
        <Section eyebrow="Chat" headline="Your prompts stay on your machine." />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="B Chat" durationInFrames={1857} premountFor={fps}>
        <BChat />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="Card: Subagents" durationInFrames={132} premountFor={fps}>
        <Section eyebrow="Subagents" headline="Hand part of the work to a reviewer." />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="C Subagent" durationInFrames={2484} premountFor={fps}>
        <CSubagent />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="Card: Workflows" durationInFrames={132} premountFor={fps}>
        <Section eyebrow="Workflows" headline="Agents you can watch, step by step." />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="D3 Workflow" durationInFrames={1158} premountFor={fps}>
        <D3Workflow />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="Card: Synthesis" durationInFrames={132} premountFor={fps}>
        <Section eyebrow="Synthesis" headline="Code that has to pass its contract." />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="D4 Synthesis" durationInFrames={2030} premountFor={fps}>
        <D4Synthesis />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="Card: Remote" durationInFrames={132} premountFor={fps}>
        <Section eyebrow="Your GPU server" headline="Run it on your own GPU server." />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="F Remote" durationInFrames={1632} premountFor={fps}>
        <FRemote />
      </TransitionSeries.Sequence>
      {crossfade}
      <TransitionSeries.Sequence name="End" durationInFrames={390} premountFor={fps}>
        <StyleEnd />
        <Audio name="Voice: end" src={staticFile("audio/Overview/02-end.mp3")} from={0.4 * fps} premountFor={fps} />
      </TransitionSeries.Sequence>
    </TransitionSeries>
    </>
  );
};
