// Human-friendly durations for the wrapper config. The primitives speak
// milliseconds; config speaks "15m" — this is the one place the translation
// happens, so nothing else needs to know both.

export type Duration = number | string;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// Accepts a number (milliseconds) or a string like "15m", "24h", "90s", "1.5h".
// Bare numeric strings are milliseconds. Anything else throws with the config
// key that produced it, so a typo fails loudly at startup, not silently at
// the first wake.
export const parseDuration = (value: Duration, label = "duration"): number => {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid ${label}: ${value} (must be a non-negative number of milliseconds)`);
    }
    return value;
  }

  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(value);
  if (!match) {
    throw new Error(
      `Invalid ${label}: "${value}" (expected a number of ms or a string like "30s", "15m", "24h", "7d")`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  return Math.round(amount * UNIT_MS[unit]!);
};
