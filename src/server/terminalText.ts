// Text from outside the server (a computer's name, a model's metadata, an error from the network)
// reaches an admin's terminal, often as root. Control characters there are commands: ESC starts
// sequences that move the cursor, rewrite what is shown, set the clipboard (OSC 52) or the title;
// bidirectional overrides reorder what is read. Everything printed from outside goes through here.

// C0 and C1 controls (ESC, CSI, OSC, BEL…), DEL, and the bidirectional overrides and isolates.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** The text with every control character replaced by a visible placeholder. */
export const printable = (value: string): string => value.replace(UNSAFE, "�");

/** A message of several lines: line breaks and tabs stay, every other control character goes. */
export const printableMessage = (value: string): string => value.replace(UNSAFE, character => character === "\n" || character === "\t" ? character : "�");

/** A copy of a JSON-like value with every string made printable. */
export const printableDeep = <T>(value: T): T => {
  if (typeof value === "string") return printable(value) as T;
  if (Array.isArray(value)) return value.map(item => printableDeep(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, printableDeep(item)])) as T;
  return value;
};
