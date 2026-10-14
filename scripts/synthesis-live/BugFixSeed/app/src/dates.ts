/** Days from one ISO date (YYYY-MM-DD) to another; negative when the second is earlier. */
export function daysBetween(from: string, to: string): number {
  const parse = (value: string) => { const [year, month, day] = value.split("-").map(Number); return Date.UTC(year, month, day); };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}
