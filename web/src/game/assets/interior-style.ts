type RoomStyle = {
  title: string;
  subtitle: string;
  floor: number;
  floorAlt: number;
  wall: number;
  sideWall: number;
  trim: number;
  rug: number;
  accent: number;
};
export const interiorStyles: Record<string, RoomStyle> = {
  "library-interior": {
    title: "CENTRAL LIBRARY",
    subtitle: "RESEARCH · READ · DISCOVER",
    floor: 0xc7b58e,
    floorAlt: 0xcbb993,
    wall: 0xe4dbc6,
    sideWall: 0xcfc1a6,
    trim: 0x755b43,
    rug: 0x3d6865,
    accent: 0xc5a66e,
  },
  "university-interior": {
    title: "KNOWLEDGE UNIVERSITY",
    subtitle: "LECTURE HALL · RESEARCH OFFICE",
    floor: 0xb5c3bf,
    floorAlt: 0xbdc9c4,
    wall: 0xe3e9dd,
    sideWall: 0xc3cebf,
    trim: 0x526b62,
    rug: 0x456877,
    accent: 0xd0bd84,
  },
  "quiz-centre-interior": {
    title: "QUIZ CENTRE",
    subtitle: "THINK · LEARN · EARN",
    floor: 0xc0bcce,
    floorAlt: 0xc7c3d4,
    wall: 0xeee9df,
    sideWall: 0xcac4d6,
    trim: 0x625674,
    rug: 0x635b85,
    accent: 0xe2bb6f,
  },
  "apartment-interior": {
    title: "PROFESSOR REED’S HOME",
    subtitle: "BOOKS · RESEARCH · A PLACE TO UNWIND",
    floor: 0xc59770,
    floorAlt: 0xcba17c,
    wall: 0xebdbc4,
    sideWall: 0xd3bfa3,
    trim: 0x84634d,
    rug: 0x975b52,
    accent: 0xe2bc81,
  },
  "cafe-interior": {
    title: "COMMON GROUND CAFÉ",
    subtitle: "COFFEE · CONVERSATION · COMMUNITY",
    floor: 0xccb18f,
    floorAlt: 0xd1b997,
    wall: 0xead8bc,
    sideWall: 0xd1b997,
    trim: 0x704c39,
    rug: 0x547763,
    accent: 0xe1bf7a,
  },
};
