/** Source-sheet rectangles are pixels; placements continue to use shared world tiles. */
export const knowledgeSheets = [
  {
    key: "knowledge-buildings",
    path: "world/knowledge/buildings.png",
    frames: {
      library: { x: 770, y: 1472, w: 770, h: 832 },
      university: { x: 770, y: 2340, w: 738, h: 924 },
      quiz: { x: 0, y: 133, w: 512, h: 507 },
      cafe: { x: 1024, y: 190, w: 512, h: 450 },
      apartment: { x: 1536, y: 784, w: 512, h: 688 },
    },
  },
  {
    key: "knowledge-campus",
    path: "world/knowledge/campus.png",
    frames: {
      paving: { x: 640, y: 32, w: 64, h: 32 },
      flowerbed: { x: 192, y: 0, w: 64, h: 64 },
      bench: { x: 512, y: 192, w: 128, h: 128 },
    },
  },
  {
    key: "knowledge-furniture",
    path: "world/knowledge/furniture.png",
    frames: {
      books: { x: 0, y: 0, w: 64, h: 40 },
      table: { x: 96, y: 96, w: 48, h: 40 },
      bed: { x: 208, y: 48, w: 60, h: 59 },
      counter: { x: 96, y: 145, w: 48, h: 43 },
      fridge: { x: 336, y: 263, w: 36, h: 34 },
      stove: { x: 277, y: 307, w: 37, h: 41 },
      plant: { x: 279, y: 457, w: 22, h: 39 },
      chair: { x: 176, y: 0, w: 16, h: 32 },
    },
  },
] as const;

export function campusFacade(x: number, y: number) {
  if (y === 6 && x === 17) return "library";
  if (y === 6 && x === 47) return "university";
  if (y === 8 && x === 37) return "quiz";
  if (y === 32 && x === 7) return "apartment";
  if (y === 31 && x === 42) return "cafe";
  return null;
}

/** Reachable approach circles sit beside the artwork's doors, inside server interaction range. */
export function entranceMarker(door: { id: string; x: number; y: number }) {
  const offset =
    door.id === "library-door-exterior" || door.id === "apartment-door-exterior"
      ? 2
      : door.id === "cafe-door-exterior" || door.id === "quiz-door-exterior"
        ? 1
        : 0;
  return { x: door.x + offset, y: door.y };
}
