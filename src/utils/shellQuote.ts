/** One argument quoted for a POSIX shell, so a string with spaces, `$()`, `;`, backticks or quotes is a
 * single literal argument when the text is pasted into a shell. Wrapped in single quotes, with any single
 * quote written as '\''. For suggesting a command a person may copy; not a substitute for passing an
 * argument vector to a process. */
export function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
