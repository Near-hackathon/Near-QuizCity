export function toScreen(x: number, y: number) {
  return { x: (x - y) * 16, y: (x + y) * 8 };
}
export function toGrid(x: number, y: number) {
  return { x: Math.round(x / 32 + y / 16), y: Math.round(y / 16 - x / 32) };
}
export function directionForDelta(dx: number, dy: number): string | null {
  if (Math.abs(dx) + Math.abs(dy) < 0.0001) return null;
  const sign = (value: number) => (Math.abs(value) < 0.000001 ? 0 : Math.sign(value));
  const x = sign(dx - dy),
    y = sign(dx + dy);
  return y === 0
    ? x > 0
      ? "e"
      : "w"
    : x === 0
      ? y > 0
        ? "s"
        : "n"
      : y > 0
        ? x > 0
          ? "se"
          : "sw"
        : x > 0
          ? "ne"
          : "nw";
}
export function sceneBounds(width: number, height: number) {
  return {
    x: -height * 16 - 64,
    y: -160,
    width: (width + height) * 16 + 128,
    height: (width + height) * 8 + 256,
  };
}
