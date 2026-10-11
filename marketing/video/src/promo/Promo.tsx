import type React from "react";
import { Series, useVideoConfig } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { TitleCard } from "../components/TitleCard";
import { StyleEnd } from "../scenes/StyleBoard";
import { PromoShot } from "./PromoShot";

// The 40-second promo, scene by scene as in handoff/shot-list.md. Subtitles are the draft voice-over;
// they become timed captions once the ElevenLabs audio exists. Every window is a placeholder until
// its capture is recorded.
export const Promo: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <Series>
      <Series.Sequence name="P1 Open" durationInFrames={105} premountFor={fps}>
        <Backdrop>
          <TitleCard name="Title" eyebrow="Local Cognitive" headline="Private AI on your own machines." showLogo />
        </Backdrop>
      </Series.Sequence>
      <Series.Sequence name="P2 Local chat" durationInFrames={225} premountFor={fps}>
        <PromoShot
          name="P2"
          shotId="P2 · Chat with a local model"
          src=""
          subtitle="Chat with models that run on your own computer. Prompts and answers stay there."
        />
      </Series.Sequence>
      <Series.Sequence name="P3 Models" durationInFrames={180} premountFor={fps}>
        <PromoShot
          name="P3"
          shotId="P3 · Pick and download a model"
          src=""
          subtitle="Pick any model from Hugging Face. Memory is checked before the download."
        />
      </Series.Sequence>
      <Series.Sequence name="P4 Workflow" durationInFrames={210} premountFor={fps}>
        <PromoShot
          name="P4"
          shotId="P4 · Workflow run with approval"
          src=""
          subtitle="Chain agents, files and commands, and watch every step run."
        />
      </Series.Sequence>
      <Series.Sequence name="P5 Synthesis" durationInFrames={210} premountFor={fps}>
        <PromoShot
          name="P5"
          shotId="P5 · Synthesis until the checks pass"
          src=""
          subtitle="Synthesis sends failed checks back to the agents until the code passes its contract."
        />
      </Series.Sequence>
      <Series.Sequence name="P6 Remote" durationInFrames={165} premountFor={fps}>
        <PromoShot
          name="P6"
          shotId="P6 · Run the chat on your GPU server"
          src=""
          subtitle="Connect your own GPU server with one key, end-to-end encrypted."
        />
      </Series.Sequence>
      <Series.Sequence name="P7 End" durationInFrames={105} premountFor={fps}>
        <StyleEnd />
      </Series.Sequence>
    </Series>
  );
};
