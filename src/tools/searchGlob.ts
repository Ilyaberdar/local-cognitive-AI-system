// Glob filters for agents' file searches. The patterns come from models, so they are matched in time
// proportional to the pattern's length times the path's, never by a regular expression that backtracks.

/** Whether a path matches a glob ("*" within a folder, "**" across folders), in time proportional to
 * the pattern's length times the path's: patterns come from the model, so no backtracking regex. */
export function globMatches(pattern: string, value: string): boolean {
  const tokens: Array<"*" | "**" | string> = [];
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== "*") { tokens.push(pattern[index]); continue; }
    let end = index; while (pattern[end + 1] === "*") end++;
    const double = end > index;
    // "**/" may also stand for no folder at all: "src/**/a.ts" matches "src/a.ts".
    if (double && pattern[end + 1] === "/" && (index === 0 || pattern[index - 1] === "/")) { tokens.push("**/"); end++; }
    else tokens.push(double ? "**" : "*");
    index = end;
  }
  // reachable[j]: the tokens so far can match value[0, j).
  let reachable = new Array<boolean>(value.length + 1).fill(false); reachable[0] = true;
  for (const token of tokens) {
    const next = new Array<boolean>(value.length + 1).fill(false);
    for (let j = 0; j <= value.length; j++) {
      if (token === "*" || token === "**") {
        // Any run of characters (without "/" for "*") after a reachable position.
        if (reachable[j] || (j > 0 && next[j - 1] && (token === "**" || value[j - 1] !== "/"))) next[j] = true;
      } else if (token === "**/") {
        if (reachable[j]) next[j] = true;
        if (j > 0 && value[j - 1] === "/") for (let k = j - 1; k >= 0; k--) { if (reachable[k]) { next[j] = true; break; } }
      } else if (j > 0 && reachable[j - 1] && value[j - 1] === token) next[j] = true;
    }
    reachable = next;
  }
  return reachable[value.length];
}
/** Like a filename filter in a search, "*.ts" matches at any depth; a pattern with "/" is anchored to the search root. */
export function searchFilter(pattern: string): (value: string) => boolean {
  const rootRelative = pattern.startsWith("./") || pattern.includes("/");
  const normalized = pattern.replace(/^\.\//, "");
  return value => globMatches(normalized, value) || (!rootRelative && value.split("/").some((_part, index, parts) => index > 0 && globMatches(normalized, parts.slice(index).join("/"))));
}
