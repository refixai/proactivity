import type { CadenceConfig } from "./types.js";

export const clampCadence = (
  requestedMs: number | null,
  config: CadenceConfig,
): number => {
  if (requestedMs === null) return config.default;
  return Math.min(Math.max(requestedMs, config.min), config.max);
};
