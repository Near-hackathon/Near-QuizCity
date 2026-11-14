import { WorldScene } from "./WorldScene";
import type { GameBridge } from "../bridge/GameBridge";
import type { GameRuntime } from "../systems/GameRuntime";
export class InteriorScene extends WorldScene {
  constructor(bridge: GameBridge, runtime: GameRuntime) {
    super("InteriorScene", bridge, runtime);
  }
}
