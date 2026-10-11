import { Composition, Folder, Still } from "remotion";
import { AppWindow } from "./components/AppWindow";
import { TitleCard } from "./components/TitleCard";
import { Promo } from "./promo/Promo";
import { PromoShot } from "./promo/PromoShot";
import { StyleEnd, StyleShot, StyleTitle } from "./scenes/StyleBoard";
import { StyleMotion } from "./scenes/StyleMotion";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Folder name="Style">
        <Still id="StyleTitle" component={StyleTitle} width={1920} height={1080} />
        <Still id="StyleShot" component={StyleShot} width={1920} height={1080} />
        <Still id="StyleEnd" component={StyleEnd} width={1920} height={1080} />
        <Composition id="StyleMotion" component={StyleMotion} durationInFrames={213} fps={30} width={1920} height={1080} />
      </Folder>
      <Folder name="Elements">
        <Composition
          id="TitleCard"
          component={TitleCard}
          durationInFrames={90}
          fps={30}
          width={1920}
          height={1080}
          defaultProps={{ eyebrow: "Workflows", headline: "Agents you can watch, step by step.", showLogo: false }}
        />
        <Composition
          id="AppWindow"
          component={AppWindow}
          durationInFrames={90}
          fps={30}
          width={1920}
          height={1080}
          defaultProps={{ src: "", kind: "video", shotId: "D3 · Workflow run", zoom: 1, focusX: 0.5, focusY: 0.5 }}
        />
        <Composition
          id="PromoShot"
          component={PromoShot}
          durationInFrames={180}
          fps={30}
          width={1920}
          height={1080}
          defaultProps={{ shotId: "P3 · Pick and download a model", src: "", subtitle: "Pick any model from Hugging Face." }}
        />
      </Folder>
      <Composition id="Promo" component={Promo} durationInFrames={1200} fps={30} width={1920} height={1080} />
    </>
  );
};
