/** Exit codes of local-cognitive-server (sysexits-style where one exists). */
export const ExitCode = {
  ok: 0,
  failure: 1,
  notRunning: 3,
  unknownState: 4,
  usage: 64,
  unavailable: 69,
  locked: 75,
  config: 78
} as const;

export class CliError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); this.name = "CliError"; }
}
