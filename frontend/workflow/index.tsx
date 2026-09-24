import { createRoot, type Root } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./workflow.css";
import { WorkflowEditor } from "./WorkflowEditor";
import type { WorkflowEditorProps, WorkflowEditorViewState } from "./types";

export interface WorkflowEditorHandle {
  setValidation: (validation: WorkflowEditorProps["validation"]) => void;
  unmount: () => void;
  setColorMode: (colorMode: WorkflowEditorProps["colorMode"]) => void;
  setNodeRuns: (nodeRuns: WorkflowEditorProps["nodeRuns"]) => void;
  setExecution: (execution: WorkflowEditorProps["execution"]) => void;
  setStarting: (starting: boolean) => void;
  captureState: () => WorkflowEditorViewState | undefined;
}

export function mountWorkflowEditor(container: HTMLElement, props: WorkflowEditorProps): WorkflowEditorHandle {
  const root: Root = createRoot(container);
  let captureState: (() => WorkflowEditorViewState) | undefined;
  let currentProps = { ...props, onCaptureState: (capture: () => WorkflowEditorViewState) => { captureState = capture; } };
  root.render(<WorkflowEditor {...currentProps} />);

  return {
    setValidation: (validation) => {
      currentProps = { ...currentProps, validation };
      root.render(<WorkflowEditor {...currentProps} />);
    },
    setStarting: starting => { currentProps = { ...currentProps, starting }; root.render(<WorkflowEditor {...currentProps} />); },
    captureState: () => captureState?.(),
    setExecution: (execution) => {
      currentProps = { ...currentProps, execution };
      root.render(<WorkflowEditor {...currentProps} />);
    },
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
