import { createRoot, type Root } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./workflow.css";
import { WorkflowEditor } from "./WorkflowEditor";
import type { WorkflowEditorProps } from "./types";

export interface WorkflowEditorHandle {
  unmount: () => void;
}

export function mountWorkflowEditor(container: HTMLElement, props: WorkflowEditorProps): WorkflowEditorHandle {
  const root: Root = createRoot(container);
  root.render(<WorkflowEditor {...props} />);

  return {
    unmount: () => root.unmount()
  };
}
