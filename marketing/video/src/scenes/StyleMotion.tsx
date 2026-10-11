import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import type React from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop } from "../components/Backdrop";
import { Subtitle } from "../components/Subtitle";
import { TitleCard } from "../components/TitleCard";

// How motion should feel: a title card, a short crossfade, then one slow zoom into the part of the
// window that matters, with the subtitle under it. Over a real still of the development build.
const ZoomShot: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Backdrop>
      <AppWindow
        name="Window"
        src="stills/chat-empty-light-115.png"
        kind="image"
        shotId=""
        zoom={interpolate(frame, [1 * fps, 3.5 * fps], [1, 1.55], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.45, 0, 0.2, 1),
        })}
        focusX={0.42}
        focusY={0.92}
        premountFor={fps}
      />
      <Subtitle
        name="Subtitle"
        style={{
          opacity: interpolate(frame, [0.4 * fps, 1 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        Ask anything. The answer comes from a model on this Mac.
      </Subtitle>
    </Backdrop>
  );
};

export const StyleMotion: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <TransitionSeries name="Style motion">
      <TransitionSeries.Sequence name="Title" durationInFrames={75} premountFor={fps}>
        <Backdrop>
          <TitleCard name="Title" eyebrow="On your computer" headline="Any model on the hardware you have." showLogo={false} />
        </Backdrop>
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 12 })} />
      <TransitionSeries.Sequence name="Zoom" durationInFrames={150} premountFor={fps}>
        <ZoomShot />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );
};
