import type { WorldScene } from "../schema.js";

export const cityDistrict: WorldScene = {
  id: "city-district",
  assetVersion: "1",
  width: 64,
  height: 48,
  tileSize: 32,
  blocked: [
    { x: 0, y: 0, width: 64, height: 2 },
    { x: 0, y: 46, width: 64, height: 2 },
    { x: 0, y: 0, width: 2, height: 48 },
    { x: 62, y: 0, width: 2, height: 48 },
    { x: 28, y: 18, width: 8, height: 6 },
  ],
  doors: [
    {
      id: "library-door-exterior",
      x: 20,
      y: 10,
      radius: 2,
      targetSceneId: "library-interior",
      targetSpawnId: "library-spawn",
    },
    {
      id: "quiz-door-exterior",
      x: 40,
      y: 12,
      radius: 2,
      targetSceneId: "quiz-centre-interior",
      targetSpawnId: "quiz-spawn",
    },
    {
      id: "apartment-door-exterior",
      x: 10,
      y: 36,
      radius: 2,
      targetSceneId: "apartment-interior",
      targetSpawnId: "apartment-spawn",
    },
    {
      id: "university-door-exterior",
      x: 50,
      y: 10,
      radius: 2,
      targetSceneId: "university-interior",
      targetSpawnId: "university-spawn",
    },
    {
      id: "cafe-door-exterior",
      x: 45,
      y: 35,
      radius: 2,
      targetSceneId: "cafe-interior",
      targetSpawnId: "cafe-spawn",
    },
  ],
  interactions: [
    { id: "building-library", kind: "building", x: 20, y: 10, radius: 2 },
    { id: "building-quiz-centre", kind: "building", x: 40, y: 12, radius: 2 },
    { id: "library-door-exterior", kind: "door", x: 20, y: 10, radius: 2 },
    { id: "quiz-door-exterior", kind: "door", x: 40, y: 12, radius: 2 },
    { id: "building-apartment", kind: "building", x: 10, y: 36, radius: 2 },
    { id: "building-university", kind: "building", x: 50, y: 10, radius: 2 },
    { id: "building-cafe", kind: "building", x: 45, y: 35, radius: 2 },
    { id: "apartment-door-exterior", kind: "door", x: 10, y: 36, radius: 2 },
    { id: "university-door-exterior", kind: "door", x: 50, y: 10, radius: 2 },
    { id: "cafe-door-exterior", kind: "door", x: 45, y: 35, radius: 2 },
  ],
  spawns: [
    { id: "city-spawn", kind: "player_default", x: 32, y: 24 },
    { id: "library-door-exterior", kind: "door", x: 20, y: 10 },
    { id: "quiz-door-exterior", kind: "door", x: 40, y: 12 },
    { id: "apartment-door-exterior", kind: "door", x: 10, y: 36 },
    { id: "university-door-exterior", kind: "door", x: 50, y: 10 },
    { id: "cafe-door-exterior", kind: "door", x: 45, y: 35 },
    { id: "park-waypoint", kind: "npc_waypoint", x: 30, y: 35 },
  ],
};

export const libraryInterior: WorldScene = {
  id: "library-interior",
  assetVersion: "1",
  width: 24,
  height: 18,
  tileSize: 32,
  blocked: [
    { x: 0, y: 0, width: 24, height: 1 },
    { x: 0, y: 17, width: 24, height: 1 },
    { x: 0, y: 0, width: 1, height: 18 },
    { x: 23, y: 0, width: 1, height: 18 },
    { x: 4, y: 4, width: 10, height: 2 },
  ],
  doors: [
    {
      id: "library-spawn",
      x: 12,
      y: 16,
      radius: 2,
      targetSceneId: "city-district",
      targetSpawnId: "library-door-exterior",
    },
  ],
  interactions: [
    { id: "library-spawn", kind: "door", x: 12, y: 16, radius: 2 },
    { id: "building-library", kind: "building", x: 8, y: 8, radius: 2 },
    { id: "professor-kofi", kind: "npc", x: 6, y: 8, radius: 2 },
  ],
  spawns: [
    { id: "library-spawn", kind: "door", x: 12, y: 16 },
    { id: "library-default", kind: "player_default", x: 12, y: 12 },
    { id: "library-desk", kind: "npc_waypoint", x: 6, y: 8 },
  ],
};

function simpleInterior(input: {
  id: string;
  width: number;
  height: number;
  exteriorDoor: string;
  door: string;
  defaultSpawn: string;
  waypoint: string;
  waypointX: number;
  waypointY: number;
}): WorldScene {
  return {
    id: input.id,
    assetVersion: "1",
    width: input.width,
    height: input.height,
    tileSize: 32,
    blocked: [
      { x: 0, y: 0, width: input.width, height: 1 },
      { x: 0, y: input.height - 1, width: input.width, height: 1 },
      { x: 0, y: 0, width: 1, height: input.height },
      { x: input.width - 1, y: 0, width: 1, height: input.height },
    ],
    doors: [
      {
        id: input.door,
        x: Math.floor(input.width / 2),
        y: input.height - 2,
        radius: 2,
        targetSceneId: "city-district",
        targetSpawnId: input.exteriorDoor,
      },
    ],
    interactions: [
      { id: input.door, kind: "door", x: Math.floor(input.width / 2), y: input.height - 2, radius: 2 },
    ],
    spawns: [
      { id: input.door, kind: "door", x: Math.floor(input.width / 2), y: input.height - 2 },
      { id: input.defaultSpawn, kind: "player_default", x: Math.floor(input.width / 2), y: input.height - 5 },
      { id: input.waypoint, kind: "npc_waypoint", x: input.waypointX, y: input.waypointY },
    ],
  };
}

export const apartmentInterior = simpleInterior({
  id: "apartment-interior",
  width: 14,
  height: 12,
  exteriorDoor: "apartment-door-exterior",
  door: "apartment-spawn",
  defaultSpawn: "apartment-default",
  waypoint: "apartment-home",
  waypointX: 6,
  waypointY: 5,
});

export const universityInterior = simpleInterior({
  id: "university-interior",
  width: 28,
  height: 20,
  exteriorDoor: "university-door-exterior",
  door: "university-spawn",
  defaultSpawn: "university-default",
  waypoint: "research-desk",
  waypointX: 14,
  waypointY: 8,
});

export const cafeInterior = simpleInterior({
  id: "cafe-interior",
  width: 16,
  height: 12,
  exteriorDoor: "cafe-door-exterior",
  door: "cafe-spawn",
  defaultSpawn: "cafe-default",
  waypoint: "cafe-table",
  waypointX: 8,
  waypointY: 5,
});

export const quizCentreInterior: WorldScene = {
  id: "quiz-centre-interior",
  assetVersion: "1",
  width: 20,
  height: 16,
  tileSize: 32,
  blocked: [
    { x: 0, y: 0, width: 20, height: 1 },
    { x: 0, y: 15, width: 20, height: 1 },
    { x: 0, y: 0, width: 1, height: 16 },
    { x: 19, y: 0, width: 1, height: 16 },
    { x: 6, y: 6, width: 8, height: 3 },
  ],
  doors: [
    {
      id: "quiz-spawn",
      x: 10,
      y: 14,
      radius: 2,
      targetSceneId: "city-district",
      targetSpawnId: "quiz-door-exterior",
    },
  ],
  interactions: [
    { id: "quiz-spawn", kind: "door", x: 10, y: 14, radius: 2 },
    { id: "quiz-desk", kind: "quiz", x: 10, y: 9, radius: 2 },
  ],
  spawns: [
    { id: "quiz-spawn", kind: "door", x: 10, y: 14 },
    { id: "quiz-default", kind: "player_default", x: 10, y: 11 },
  ],
};

export const worldScenes: WorldScene[] = [
  cityDistrict,
  libraryInterior,
  quizCentreInterior,
  apartmentInterior,
  universityInterior,
  cafeInterior,
];
