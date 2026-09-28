import { createRoot } from "react-dom/client";
import { SynthesisWorkspace } from "./SynthesisWorkspace";
import type { SynthesisWorkspaceProps } from "./types";
import "./synthesis.css";

export function mountSynthesisWorkspace(container: HTMLElement, props: SynthesisWorkspaceProps) {
  const root = createRoot(container);
  let currentProps = props;
  const render = () => root.render(<SynthesisWorkspace {...currentProps} />);
  render();
  return {
    unmount: () => root.unmount(),
    setColorMode: (colorMode: SynthesisWorkspaceProps["colorMode"]) => { currentProps = { ...currentProps, colorMode }; render(); },
    setProjects: (projects: SynthesisWorkspaceProps["projects"]) => { currentProps = { ...currentProps, projects }; render(); },
    selectProject: (selectedProjectId: string) => { currentProps = { ...currentProps, selectedProjectId }; render(); },
    setActive: (active: boolean) => { currentProps = { ...currentProps, active }; render(); }
  };
}
