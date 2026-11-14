export type InteractionZone = { id: string; kind: string; x: number; y: number; radius: number };
export function findInteractionCandidate(
  x: number,
  y: number,
  zones: InteractionZone[],
): InteractionZone | null {
  return (
    [...zones]
      .filter((zone) => Math.max(Math.abs(x - zone.x), Math.abs(y - zone.y)) <= zone.radius)
      .sort(
        (a, b) =>
          Math.hypot(x - a.x, y - a.y) - Math.hypot(x - b.x, y - b.y) ||
          Number(b.kind === "door") - Number(a.kind === "door") ||
          a.id.localeCompare(b.id),
      )[0] ?? null
  );
}
