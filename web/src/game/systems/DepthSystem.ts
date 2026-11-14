export function depthFor(y: number, offset = 0) {
  return y * 100 + offset;
}

/** Less than one thousandth of a pixel; stable across creation/replay order. */
export function entityDepth(screenY: number, id: string) {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return screenY + 0.1 + (hash % 1000) / 1_000_000;
}
