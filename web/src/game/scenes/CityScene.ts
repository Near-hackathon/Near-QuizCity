import { WorldScene } from "./WorldScene";
import type { GameBridge } from "../bridge/GameBridge";
import type { GameRuntime } from "../systems/GameRuntime";
export class CityScene extends WorldScene {
  constructor(bridge: GameBridge, runtime: GameRuntime) {
    super("CityScene", bridge, runtime);
  }
}
