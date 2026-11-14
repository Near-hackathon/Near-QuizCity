export function advanceVisualPosition(
  from: { x: number; y: number },
  target: { x: number; y: number },
  elapsedMs: number,
  stepMs: number,
) {
  const distance = Math.max(Math.abs(from.x - target.x), Math.abs(from.y - target.y));
  if (distance > 2) return { ...target };
  const fraction = Math.min(1, Math.max(0, elapsedMs) / (stepMs * Math.max(0.001, distance)));
  return { x: from.x + (target.x - from.x) * fraction, y: from.y + (target.y - from.y) * fraction };
}
