import { createRoot, type Root } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./workflow.css";
import { WorkflowEditor } from "./WorkflowEditor";
import type { WorkflowEditorProps } from "./types";

export interface WorkflowEditorHandle {
  unmount: () => void;
  setColorMode: (colorMode: WorkflowEditorProps["colorMode"]) => void;
  setNodeRuns: (nodeRuns: WorkflowEditorProps["nodeRuns"]) => void;
}

export function mountWorkflowEditor(container: HTMLElement, props: WorkflowEditorProps): WorkflowEditorHandle {
  const root: Root = createRoot(container);
  let currentProps = props;
  root.render(<WorkflowEditor {...currentProps} />);

  return {
    setColorMode: (colorMode) => {
      currentProps = { ...currentProps, colorMode };
      root.render(<WorkflowEditor {...currentProps} />);
    },
    setNodeRuns: (nodeRuns) => {
      currentProps = { ...currentProps, nodeRuns };
      root.render(<WorkflowEditor {...currentProps} />);
    },
    unmount: () => root.unmount()
  };
}
