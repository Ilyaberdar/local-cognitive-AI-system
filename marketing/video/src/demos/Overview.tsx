import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import type React from "react";
import { staticFile, useVideoConfig } from "remotion";
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

export const Overview: React.FC = () => {
  const { fps } = useVideoConfig();
  const crossfade = <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 12 })} />;
  return (
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
  );
};
