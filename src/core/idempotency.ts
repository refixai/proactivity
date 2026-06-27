export const deriveIdempotencyKey = (parts: {
  actionType: string;
  target: Record<string, unknown>;
  tickId: string;
}): string => {
  const sortedTarget = JSON.stringify(parts.target, Object.keys(parts.target).sort());
  return `${parts.actionType}:${sortedTarget}:${parts.tickId}`;
};
