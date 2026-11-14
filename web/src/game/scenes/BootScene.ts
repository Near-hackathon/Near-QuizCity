import Phaser from "phaser";
import type { GameBridge } from "../bridge/GameBridge";
import type { GameRuntime } from "../systems/GameRuntime";
import { prepareRuntimeAssets, registerFrames } from "../assets/pipeline";
export class BootScene extends Phaser.Scene {
  constructor(
    private readonly bridge: GameBridge,
    private readonly runtime: GameRuntime,
  ) {
    super("BootScene");
  }
  create() {
    const abort = new AbortController();
    const off = this.runtime.subscribe((model) => {
      if (!model.scene) return;
      const key = model.scene.id === "city-district" ? "CityScene" : "InteriorScene";
      const other = key === "CityScene" ? "InteriorScene" : "CityScene";
      this.scene.stop(other);
      if (!this.scene.isActive(key)) this.scene.launch(key);
    });
    const cleanup = () => {
      abort.abort();
      off();
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, cleanup);
    this.events.once(Phaser.Scenes.Events.DESTROY, cleanup);
    void prepareRuntimeAssets(abort.signal).then(
      (plans) => {
        if (abort.signal.aborted) return;
        let failed = false;
        const fail = () => {
          failed = true;
          this.bridge.emit({ type: "fatalError", message: "A required city texture could not load." });
        };
        this.load.once("loaderror", fail);
        this.load.once("complete", () => {
          this.load.off("loaderror", fail);
          if (abort.signal.aborted || failed) return;
          registerFrames(this, plans);
          this.bridge.emit({ type: "gameReady" });
        });
        for (const plan of plans) {
          if (plan.character) this.load.spritesheet(plan.key, plan.path, { frameWidth: 32, frameHeight: 32 });
          else this.load.image(plan.key, plan.path);
        }
        this.load.start();
      },
      () => {
        if (!abort.signal.aborted)
          this.bridge.emit({
            type: "fatalError",
            message: "City assets could not be loaded. Prepare the approved assets and retry.",
          });
      },
    );
  }
}
