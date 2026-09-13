import { ProviderTarget } from "../types";

/** An explicit provider change must never inherit another provider's model ID. */
export const resolveProviderTarget = (
  override: Partial<ProviderTarget> | undefined,
  fallback: ProviderTarget,
  defaults: Record<string, string | undefined> = {}
): ProviderTarget => {
  const providerId = override?.providerId || fallback.providerId;
  if (providerId === "local") return { providerId };
  const model = typeof override?.model === "string" ? override.model.trim() :
    (providerId === fallback.providerId ? fallback.model : undefined) || defaults[providerId];
  return { providerId, model: model || undefined };
};
