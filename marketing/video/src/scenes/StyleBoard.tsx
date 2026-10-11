import type React from "react";
import { Img, staticFile } from "remotion";
import "../brand/fonts";
import { fonts, landing } from "../brand/theme";
import { AppWindow } from "../components/AppWindow";
import { Backdrop } from "../components/Backdrop";
import { Callout } from "../components/Callout";
import { SpeedBadge } from "../components/SpeedBadge";
import { Subtitle } from "../components/Subtitle";
import { TitleCard } from "../components/TitleCard";

// Style frames for review. The window holds a real screenshot of the development build with an empty
// profile (public/stills); the badge and callout only demonstrate the overlay style.

export const StyleTitle: React.FC = () => {
  return (
    <Backdrop>
      <TitleCard name="Title" eyebrow="Local Cognitive" headline="Private AI on your own machines." showLogo />
    </Backdrop>
  );
};

export const StyleShot: React.FC = () => {
  return (
    <Backdrop>
      <AppWindow
        name="Window"
        src="stills/chat-empty-light-115.png"
        kind="image"
        shotId=""
        zoom={1}
        focusX={0.5}
        focusY={0.5}
      />
      <SpeedBadge name="Badge" label="Sped up 4×" />
      <Callout name="Callout" style={{ left: 1190, top: 500 }}>
        Pick the model for this chat
      </Callout>
      <Subtitle name="Subtitle">Models run on your computer, through a built-in llama.cpp.</Subtitle>
    </Backdrop>
  );
};

export const StyleEnd: React.FC = () => {
  return (
    <Backdrop>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 30,
          fontFamily: fonts.sans,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
          <Img src={staticFile("brand/logo-1024.png")} style={{ width: 112, height: 112 }} />
          <div style={{ fontSize: 84, fontWeight: 600, letterSpacing: "-0.035em", color: landing.ink }}>
            Local Cognitive
          </div>
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 34, color: landing.muted }}>
          macOS · Windows · Linux GPU server
        </div>
        <div style={{ fontSize: 44, fontWeight: 500, color: landing.accent, marginTop: 18 }}>local-cognitive.com</div>
      </div>
    </Backdrop>
  );
};
