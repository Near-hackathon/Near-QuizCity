import type { WorldSpawn } from "./schema.js";

export const residentProfiles = [
  {
    id: "professor-kofi",
    name: "Professor Reed",
    role: "Research professor",
    skin: "man_tee",
    tint: 0xffffff,
    action: "jobs",
    greeting:
      "Our city is a living NEAR classroom. Research accounts, access keys and contracts through my funded assignments. Accept one on your phone, then show what you learned.",
  },
  {
    id: "librarian-ama",
    name: "Emma",
    role: "Librarian",
    skin: "woman_jeans",
    tint: 0xe7dcff,
    action: "research",
    greeting:
      "Welcome to the NEAR learning library. Named accounts identify people and contracts; access keys control what they can do. Professor Reed’s assignments put those ideas into practice.",
  },
  {
    id: "quiz-attendant-yaw",
    name: "Max",
    role: "Quiz attendant",
    skin: "man_tee",
    tint: 0xcce8f2,
    action: "quiz",
    greeting:
      "Welcome to the NEAR Quiz Centre. Practise protocol knowledge or challenge a friend in a shared room. Stakes stay in escrow until the server scores the session and confirms its outcome.",
  },
  {
    id: "barista-esi",
    name: "Sam",
    role: "Café worker",
    skin: "woman_jeans",
    tint: 0xffdfb4,
    action: "business",
    greeting:
      "Welcome to Common Ground. Our café is a place to compare NEAR discoveries. Remember: QC is a game credit; native NEAR pays blockchain network fees.",
  },
  {
    id: "resident-kojo",
    name: "Alex",
    role: "Resident",
    skin: "man_tee",
    tint: 0xd2edc8,
    action: "residents",
    greeting:
      "I’m learning why sharding divides network work across parallel parts. I read in the library, discuss it at the café, then practise at the quiz centre. Find us in the phone’s resident directory.",
  },
  {
    id: "student-abena",
    name: "Jamie",
    role: "Student",
    skin: "woman_jeans",
    tint: 0xffd4df,
    action: "quiz",
    greeting:
      "I’m studying NEAR contracts at university: code and state live in accounts, and transactions call their methods. I practise at the quiz centre after studying in the library.",
  },
] as const;

export function residentProfile(id: string) {
  return residentProfiles.find((profile) => profile.id === id);
}

const waypoint = (id: string, x: number, y: number): WorldSpawn => ({ id, kind: "npc_waypoint", x, y });
export const residentSpawns: Record<string, WorldSpawn[]> = {
  "library-interior": [
    waypoint("ama-library-desk", 3, 8),
    waypoint("kojo-library-reading", 18, 10),
    waypoint("abena-library-reading", 15, 12),
  ],
  "quiz-centre-interior": [waypoint("yaw-quiz-desk", 10, 4)],
  "cafe-interior": [
    waypoint("esi-cafe-counter", 5, 4),
    waypoint("kojo-cafe-table", 9, 5),
    waypoint("abena-cafe-table", 12, 8),
    waypoint("ama-cafe-table", 7, 7),
  ],
  "city-district": [
    waypoint("market-queue", 5, 8),
    waypoint("ama-park", 23, 34),
    waypoint("ama-walk", 21, 38),
    waypoint("kojo-park", 28, 34),
    waypoint("kojo-walk", 26, 40),
    waypoint("yaw-walk", 32, 40),
    waypoint("esi-walk", 40, 38),
    waypoint("abena-walk", 38, 40),
    waypoint("abena-park", 34, 35),
    waypoint("yaw-park", 30, 36),
    waypoint("esi-park", 35, 34),
  ],
  "university-interior": [waypoint("abena-university-desk", 15, 8)],
};

type Routine = {
  id: string;
  start: number;
  end: number;
  activity: string;
  scene: string;
  spawn: string;
  patrol?: string[];
};
const stop = (
  id: string,
  start: number,
  end: number,
  activity: string,
  scene: string,
  spawn: string,
): Routine => ({ id, start, end, activity, scene, spawn });
const stroll = (id: string, start: number, end: number, resident: string): Routine => ({
  ...stop(id, start, end, "garden_walk", "city-district", `${resident}-park`),
  patrol: [`${resident}-park`, `${resident}-walk`],
});
export const residentRoutines: Record<string, Routine[]> = {
  "librarian-ama": [
    stroll("ama-morning", 0, 450, "ama"),
    stop("ama-library-morning", 450, 720, "helping_readers", "library-interior", "ama-library-desk"),
    stop("ama-lunch", 720, 780, "cafe_break", "cafe-interior", "ama-cafe-table"),
    stop("ama-library-afternoon", 780, 1200, "helping_readers", "library-interior", "ama-library-desk"),
    stroll("ama-evening", 1200, 1440, "ama"),
  ],
  "quiz-attendant-yaw": [
    stroll("yaw-morning", 0, 510, "yaw"),
    stop("yaw-quiz-morning", 510, 780, "hosting_quizzes", "quiz-centre-interior", "yaw-quiz-desk"),
    stop("yaw-break", 780, 840, "park_break", "city-district", "yaw-park"),
    stop("yaw-quiz-afternoon", 840, 1320, "hosting_quizzes", "quiz-centre-interior", "yaw-quiz-desk"),
    stroll("yaw-evening", 1320, 1440, "yaw"),
  ],
  "barista-esi": [
    stroll("esi-morning", 0, 330, "esi"),
    stop("esi-cafe-morning", 330, 840, "working_counter", "cafe-interior", "esi-cafe-counter"),
    stop("esi-break", 840, 900, "park_break", "city-district", "esi-park"),
    stop("esi-cafe-afternoon", 900, 1380, "working_counter", "cafe-interior", "esi-cafe-counter"),
    stroll("esi-evening", 1380, 1440, "esi"),
  ],
  "resident-kojo": [
    stroll("kojo-morning", 0, 480, "kojo"),
    stroll("kojo-walk", 480, 540, "kojo"),
    stop("kojo-reading", 540, 720, "reading", "library-interior", "kojo-library-reading"),
    stop("kojo-cafe", 720, 780, "cafe_break", "cafe-interior", "kojo-cafe-table"),
    stroll("kojo-afternoon", 780, 1080, "kojo"),
    stroll("kojo-evening", 1080, 1440, "kojo"),
  ],
  "student-abena": [
    stroll("abena-morning", 0, 510, "abena"),
    stop("abena-studying", 510, 720, "studying", "university-interior", "abena-university-desk"),
    stop("abena-cafe", 720, 810, "cafe_break", "cafe-interior", "abena-cafe-table"),
    stroll("abena-walk", 810, 1020, "abena"),
    stop("abena-reading", 1020, 1200, "reading", "library-interior", "abena-library-reading"),
    stroll("abena-evening", 1200, 1440, "abena"),
  ],
};
