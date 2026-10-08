export async function synthesisRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  // The local API guard rejects mutations without the same-origin application header.
  const response = await fetch(`/synthesis${path}`, {
    ...options, headers: { "Content-Type": "application/json", "X-Local-Cognitive": "1", ...options.headers }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || payload?.error || `Request failed (${response.status})`);
  return payload as T;
}
export const encode = encodeURIComponent;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";
