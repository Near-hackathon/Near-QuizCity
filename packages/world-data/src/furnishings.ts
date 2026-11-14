import type { WorldProp } from "./schema.js";
type Furniture = Omit<WorldProp, "id">;
const piece = (kind: Furniture["kind"], x: number, y: number, width = 1, height = 1): Furniture => ({
  kind,
  x,
  y,
  width,
  height,
});
// Seat belongs beside its table, rather than overlapping its sprite and legs.
const desk = (x: number, y: number) => [piece("desk", x, y, 2), piece("chair", x + 1, y + 1)];
export const interiorFurnishings: Record<string, Furniture[]> = {
  "library-interior": [
    ...desk(6, 10),
    ...desk(10, 10),
    ...desk(16, 9),
    piece("bookshelf", 2, 6),
    piece("bookshelf", 2, 9),
    piece("bookshelf", 19, 5),
    piece("bookshelf", 19, 7),
    piece("plant", 20, 14),
    piece("counter", 3, 7, 2),
  ],
  "university-interior": [
    ...desk(6, 7),
    ...desk(11, 7),
    ...desk(17, 7),
    ...desk(6, 11),
    ...desk(11, 11),
    ...desk(17, 11),
    piece("counter", 14, 4, 2),
    piece("plant", 24, 5),
    piece("bookshelf", 3, 6),
    piece("bookshelf", 3, 9),
  ],
  "apartment-interior": [
    piece("bed", 2, 2, 2, 2),
    piece("bookshelf", 5, 2),
    piece("bookshelf", 11, 3),
    ...desk(11, 6),
    piece("counter", 12, 2, 3),
    piece("fridge", 15, 2),
    piece("sofa", 4, 8, 2),
    piece("armchair", 6, 10),
    piece("plant", 3, 6),
    piece("plant", 15, 9),
  ],
  "cafe-interior": [
    piece("counter", 3, 5, 4),
    piece("stove", 3, 3),
    ...desk(10, 4),
    ...desk(10, 7),
    ...desk(4, 8),
    piece("plant", 13, 9),
    piece("fridge", 2, 2),
  ],
  "quiz-centre-interior": [
    // Two side stations keep the entrance-to-Max aisle completely open.
    ...desk(3, 7),
    ...desk(15, 7),
    piece("plant", 17, 3),
    piece("plant", 2, 12),
  ],
};
