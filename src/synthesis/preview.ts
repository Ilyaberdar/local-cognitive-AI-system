import path from "path";
import { defaultTreeAdapter as tree, parse, serialize } from "parse5";

/** The policy of a preview: the page's own inline code and styles, data images, nothing else. */
export const PREVIEW_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'";

/** The parts of a parse5 node this module reads. */
interface Node { tagName?: string; namespaceURI?: string; attrs?: Array<{ name: string; value: string }>; childNodes?: Node[]; parentNode?: Node | null }

const attribute = (node: Node, name: string) => node.attrs?.find(item => item.name === name)?.value;
const elements = (node: Node, found: Node[] = []): Node[] => {
  for (const child of node.childNodes ?? []) {
    if (child.tagName) found.push(child);
    elements(child, found);
  }
  return found;
};

/** The candidate file a page names, relative to the page (`./app.js`, `app.js`, `js/app.js`). */
const candidateFile = (files: Record<string, string>, page: string, reference: string | undefined): string | undefined => {
  if (!reference || /^[a-z][a-z0-9+.-]*:|^\/\/|^\//i.test(reference)) return undefined;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(page), reference.split(/[?#]/)[0]!));
  return !target.startsWith("..") && Object.hasOwn(files, target) ? target : undefined;
};

/** One self-contained page for a candidate's preview (R5-5): its stylesheets and scripts inlined,
 * anything else it would load removed, and the preview policy in the page itself. It loads nothing
 * more, so it works inside a sandboxed frame (an opaque origin) here and on a paired device alike. */
export function previewDocument(files: Record<string, string>, page = "index.html"): string {
  const document = parse(files[page] ?? "");
  const root = document as unknown as Node;
  const head = elements(root).find(node => node.tagName === "head");
  for (const node of elements(root)) {
    const parent = node.parentNode;
    if (!parent) continue;
    if (node.tagName === "script" && attribute(node, "src") !== undefined) {
      const file = candidateFile(files, page, attribute(node, "src"));
      if (!file) { tree.detachNode(node as never); continue; }
      node.attrs = node.attrs!.filter(item => item.name !== "src" && item.name !== "integrity" && item.name !== "crossorigin");
      node.childNodes = [];
      // Inline text cannot end the element early or open a comment that hides the rest.
      tree.insertText(node as never, files[file]!.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--"));
    } else if (node.tagName === "link" && (attribute(node, "rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet")) {
      const file = candidateFile(files, page, attribute(node, "href"));
      if (file) {
        const style = tree.createElement("style", node.namespaceURI as never, []);
        tree.insertText(style, files[file]!.replace(/<\/style/gi, "<\\/style"));
        tree.insertBefore(parent as never, style, node as never);
      }
      tree.detachNode(node as never);
    } else if (["iframe", "object", "embed", "base", "frame", "frameset"].includes(node.tagName ?? "")) {
      tree.detachNode(node as never);
    }
  }
  if (head) {
    const meta = tree.createElement("meta", head.namespaceURI as never, [{ name: "http-equiv", value: "Content-Security-Policy" }, { name: "content", value: PREVIEW_POLICY }]);
    const first = head.childNodes?.[0];
    if (first) tree.insertBefore(head as never, meta, first as never);
    else tree.appendChild(head as never, meta);
  }
  return serialize(document);
}
