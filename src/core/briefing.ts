import type { BriefingBoundary, BriefingSource } from "./types.js";

export const assembleBriefing = async (
  sources: BriefingSource[],
  boundary: BriefingBoundary,
): Promise<Record<string, unknown>> => {
  const results = await Promise.all(
    sources.map(async (source) => {
      const data = await source.load(boundary);
      return [source.name, data] as const;
    }),
  );
  return Object.fromEntries(results);
};
