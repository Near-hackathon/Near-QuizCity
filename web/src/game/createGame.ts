import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { CityScene } from "./scenes/CityScene";
import { InteriorScene } from "./scenes/InteriorScene";
import type { GameBridge } from "./bridge/GameBridge";
import { GameRuntime } from "./systems/GameRuntime";
import type { GameInstance } from "./GameHost";
export function createGame(parent: HTMLElement, bridge: GameBridge): GameInstance {
  const runtime = new GameRuntime(bridge);
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: "#141824",
    pixelArt: true,
    render: { antialias: false, roundPixels: true },
    scale: { mode: Phaser.Scale.RESIZE },
    banner: false,
    scene: [
      new BootScene(bridge, runtime),
      new CityScene(bridge, runtime),
      new InteriorScene(bridge, runtime),
    ],
  });
  game.events.once(Phaser.Core.Events.DESTROY, () => runtime.dispose());
  let destroyed: Promise<void> | null = null;
  return {
    destroy(removeCanvas) {
      destroyed ??= new Promise<void>((resolve) => {
        game.events.once(Phaser.Core.Events.DESTROY, resolve);
        game.destroy(removeCanvas);
      });
      return destroyed;
    },
  };
}
