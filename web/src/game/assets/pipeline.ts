import type Phaser from "phaser";
import { worldScenes } from "@quiz-city/world-data";
import { loadManifest } from "./loadManifest";
import { knowledgeSheets } from "./visual-slice";

export type SpritePlan = {
  key: string;
  path: string;
  frames?: Record<string, { x: number; y: number; w: number; h: number }>;
  character?: { name: string; activity: string; frames: number; fps: number; rows: string[] };
};
export const facingRows: Record<string, string> = {
  north: "n",
  north_east: "ne",
  east: "e",
  south_east: "se",
  south: "s",
  south_west: "sw",
  west: "w",
  north_west: "nw",
};
const base = "/game-assets/runtime/";
export async function checkedFile(url: string, hash: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Asset request failed");
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  if ([...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("") !== hash)
    throw new Error("Asset hash mismatch");
  return bytes;
}

export async function prepareRuntimeAssets(signal: AbortSignal): Promise<SpritePlan[]> {
  const inventory = await loadManifest(signal);
  const files = new Map(inventory.files.map((file) => [file.path, file]));
  const read = async (path: string) => {
    const file = files.get(path);
    if (!file) throw new Error("Missing declared asset");
    return JSON.parse(new TextDecoder().decode(await checkedFile(base + path, file.sha256, signal)));
  };
  const registry = await fetch("/game-assets/maps/registry.json", { signal }).then((response) => {
    if (!response.ok) throw new Error("Map registry unavailable");
    return response.json();
  });
  if (registry.version !== 1 || registry.maps?.length !== worldScenes.length)
    throw new Error("Invalid map registry");
  for (const scene of worldScenes) {
    const entry = registry.maps.find((item: { sceneId: string }) => item.sceneId === scene.id);
    if (!entry || entry.path !== `${scene.id}.tmj`) throw new Error("Missing scene map");
    const map = JSON.parse(
      new TextDecoder().decode(await checkedFile(`/game-assets/maps/${entry.path}`, entry.sha256, signal)),
    );
    if (
      map.sceneId !== scene.id ||
      map.width !== scene.width ||
      map.height !== scene.height ||
      map.assetVersion !== scene.assetVersion ||
      map.tilewidth !== 32 ||
      map.tileheight !== 16
    )
      throw new Error("Map version mismatch");
  }
  const plans: SpritePlan[] = [];
  for (const sheet of knowledgeSheets) {
    const file = files.get(sheet.path);
    if (!file) throw new Error("Missing knowledge district art; run assets:prepare");
    const bytes = await checkedFile(base + sheet.path, file.sha256, signal);
    const dimensions = new DataView(bytes);
    for (const frame of Object.values(sheet.frames))
      if (frame.x + frame.w > dimensions.getUint32(16) || frame.y + frame.h > dimensions.getUint32(20))
        throw new Error("Knowledge district frame exceeds texture bounds");
    plans.push({ key: sheet.key, path: base + sheet.path, frames: sheet.frames });
  }
  for (const path of files.keys()) {
    if (!/^world\/(city|interiors)\/Sheets\/[a-z]+_1x\.json$/.test(path)) continue;
    const data = await read(path);
    const image = path.replace(/[^/]+$/, data.image);
    if (!files.has(image) || !Array.isArray(data.size)) throw new Error("Missing texture");
    for (const frame of Object.values(data.sprites) as { x: number; y: number; w: number; h: number }[]) {
      if (
        ![frame.x, frame.y, frame.w, frame.h].every(Number.isInteger) ||
        frame.x < 0 ||
        frame.y < 0 ||
        frame.w <= 0 ||
        frame.h <= 0 ||
        frame.x + frame.w > data.size[0] ||
        frame.y + frame.h > data.size[1]
      )
        throw new Error("Invalid texture frame");
    }
    await checkedFile(base + image, files.get(image)!.sha256, signal);
    plans.push({ key: path.replace(/\.json$/, ""), path: base + image, frames: data.sprites });
  }
  const characters = await read("characters/city-people/characters.json");
  for (const character of characters.characters) {
    const path = `characters/city-people/${character.data}`;
    const data = await read(path);
    for (const [activity, animation] of Object.entries(data.animations) as [
      string,
      { image: string; frames: number; fps: number; size: number[] },
    ][]) {
      const image = path.replace(/[^/]+$/, animation.image);
      if (
        !files.has(image) ||
        animation.frames < 1 ||
        animation.frames * 32 !== animation.size[0] ||
        animation.size[1] !== 256 ||
        animation.fps < 1 ||
        animation.fps > 30 ||
        data.rows.length !== 8
      )
        throw new Error("Invalid character animation");
      await checkedFile(base + image, files.get(image)!.sha256, signal);
      plans.push({
        key: `${character.name}.${activity}`,
        path: base + image,
        character: {
          name: character.name,
          activity,
          frames: animation.frames,
          fps: animation.fps,
          rows: data.rows,
        },
      });
    }
  }
  return plans;
}

export function registerFrames(scene: Phaser.Scene, plans: SpritePlan[]) {
  for (const plan of plans) {
    if (plan.frames) {
      const texture = scene.textures.get(plan.key);
      for (const [name, frame] of Object.entries(plan.frames))
        texture.add(name, 0, frame.x, frame.y, frame.w, frame.h);
    }
    if (plan.character) {
      const data = plan.character;
      data.rows.forEach((direction, row) => {
        const key = `${plan.key}.${direction}`;
        if (!scene.anims.exists(key))
          scene.anims.create({
            key,
            frames: scene.anims.generateFrameNumbers(plan.key, {
              start: row * data.frames,
              end: (row + 1) * data.frames - 1,
            }),
            frameRate: data.fps,
            repeat: -1,
          });
      });
    }
  }
}
