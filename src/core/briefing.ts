import type { BriefingBoundary, BriefingSource } from "./types.js";

export type BriefingAssembler = {
  assemble: (boundary: BriefingBoundary) => Promise<Record<string, unknown>>;
};

export const createBriefing = (sources: BriefingSource[]): BriefingAssembler => ({
  assemble: async (boundary) => {
    const results = await Promise.all(
      sources.map(async (source) => {
        const data = await source.load(boundary);
        return [source.name, data] as const;
      }),
    );
    return Object.fromEntries(results);
  },
});
