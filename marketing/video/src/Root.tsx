import { Composition, Folder, Still } from "remotion";
import { AppWindow } from "./components/AppWindow";
import { TitleCard } from "./components/TitleCard";
import { AModels } from "./demos/AModels";
import { BChat } from "./demos/BChat";
import { CSubagent } from "./demos/CSubagent";
import { D3Workflow } from "./demos/D3Workflow";
import { D4Synthesis } from "./demos/D4Synthesis";
import { FRemote } from "./demos/FRemote";
import { Overview } from "./demos/Overview";
import { Promo } from "./promo/Promo";
import { PromoShot } from "./promo/PromoShot";
import { StyleEnd, StyleShot, StyleTitle } from "./scenes/StyleBoard";
import { StyleMotion } from "./scenes/StyleMotion";
import { SCREENS, Screen } from "./screens/Screen";

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
      <Folder name="Docs">
        <Composition id="AModels" component={AModels} durationInFrames={1596} fps={60} width={1920} height={1080} />
        <Composition id="BChat" component={BChat} durationInFrames={1857} fps={60} width={1920} height={1080} />
        <Composition id="CSubagent" component={CSubagent} durationInFrames={2484} fps={60} width={1920} height={1080} />
        <Composition id="D3Workflow" component={D3Workflow} durationInFrames={1158} fps={60} width={1920} height={1080} />
        <Composition id="FRemote" component={FRemote} durationInFrames={1632} fps={60} width={1920} height={1080} />
        <Composition id="D4Synthesis" component={D4Synthesis} durationInFrames={2030} fps={60} width={1920} height={1080} />
      </Folder>
      <Composition id="Promo" component={Promo} durationInFrames={2400} fps={60} width={1920} height={1080} />
      <Composition id="Overview" component={Overview} durationInFrames={12047} fps={60} width={1920} height={1080} />
      <Folder name="BlenderScreens">
        {Object.entries(SCREENS).map(([id, props]) => (
          <Composition key={id} id={`Screen-${id}`} component={Screen} defaultProps={props} durationInFrames={120} fps={30} width={1600} height={1000} />
        ))}
      </Folder>
    </>
  );
};
