import { isBlocked, type WorldPoint, type WorldScene } from "./schema.js";

export type RouteResult = { path: WorldPoint[] } | { error: "BLOCKED" | "NO_PATH" };

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Deterministic 4-neighbour A* with stable tie-breaking by (f, y, x). */
export function findPath(scene: WorldScene, start: WorldPoint, target: WorldPoint): RouteResult {
  if (isBlocked(scene, start.x, start.y)) return { error: "BLOCKED" };
  if (isBlocked(scene, target.x, target.y)) return { error: "BLOCKED" };
  if (start.x === target.x && start.y === target.y) return { path: [start] };

  const key = (p: WorldPoint) => `${p.x},${p.y}`;
  const open = new Map<string, { point: WorldPoint; g: number; f: number }>();
  const came = new Map<string, WorldPoint>();
  const best = new Map<string, number>();
  const startKey = key(start);
  open.set(startKey, { point: start, g: 0, f: 0 });
  best.set(startKey, 0);

  while (open.size > 0) {
    const current = [...open.values()].sort(
      (a, b) => a.f - b.f || a.point.y - b.point.y || a.point.x - b.point.x,
    )[0];
    open.delete(key(current.point));
    if (current.point.x === target.x && current.point.y === target.y) {
      const path: WorldPoint[] = [current.point];
      let cursor = current.point;
      while (!(cursor.x === start.x && cursor.y === start.y)) {
        const previous = came.get(key(cursor));
        if (!previous) return { error: "NO_PATH" };
        path.push(previous);
        cursor = previous;
      }
      return { path: path.reverse() };
    }
    for (const [dx, dy] of NEIGHBORS) {
      const next = { x: current.point.x + dx, y: current.point.y + dy };
      if (isBlocked(scene, next.x, next.y)) continue;
      const g = current.g + 1;
      const nextKey = key(next);
      if (g >= (best.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
      best.set(nextKey, g);
      came.set(nextKey, current.point);
      const heuristic = Math.abs(next.x - target.x) + Math.abs(next.y - target.y);
      open.set(nextKey, { point: next, g, f: g + heuristic });
    }
  }
  return { error: "NO_PATH" };
}
