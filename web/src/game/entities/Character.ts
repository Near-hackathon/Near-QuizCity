import Phaser from "phaser";
import { facingRows } from "../assets/pipeline";
import { toScreen, directionForDelta } from "../maps/coordinates";
import { entityDepth } from "../systems/DepthSystem";

export class Character {
  readonly sprite: Phaser.GameObjects.Sprite;
  readonly label: Phaser.GameObjects.Text;
  x = 0;
  y = 0;
  private direction: string | null = null;
  private positioned = false;
  constructor(
    scene: Phaser.Scene,
    readonly id: string,
    readonly skin: string,
    label: string,
    local = false,
  ) {
    this.sprite = scene.add.sprite(0, 0, `${skin}.idle`, 0).setOrigin(0.5, 28 / 32);
    this.label = scene.add
      .text(0, 0, label, {
        fontFamily: "monospace",
        fontSize: "8px",
        color: local ? "#ffe5a0" : "#fff3dd",
        backgroundColor: "#192935dd",
        padding: { x: 3, y: 2 },
      })
      .setOrigin(0.5, 1);
  }
  draw(x: number, y: number, facing: string, activity: string, reduced: boolean, visible = true) {
    const moving = this.positioned && Math.hypot(x - this.x, y - this.y) > 0.002;
    this.positioned = true;
    if (moving) this.direction = directionForDelta(x - this.x, y - this.y);
    this.x = x;
    this.y = y;
    const point = toScreen(x, y);
    this.sprite.setPosition(Math.round(point.x), Math.round(point.y));
    this.sprite.setDepth(entityDepth(point.y, this.id));
    this.label.setPosition(point.x, point.y - 31).setDepth(point.y + 0.2);
    this.sprite.setVisible(visible);
    this.label.setVisible(visible);
    const action = moving ? "walk" : activity === "phone" ? "phone" : "idle";
    const direction = this.direction ?? facingRows[facing] ?? "s";
    const key = `${this.skin}.${action}.${direction}`;
    if (!visible) {
      this.sprite.anims.pause();
      return;
    }
    this.sprite.anims.resume();
    if (!reduced || moving) this.sprite.play(key, true);
    else {
      this.sprite.anims.stop();
      this.sprite.setTexture(
        `${this.skin}.idle`,
        ["s", "sw", "w", "nw", "n", "ne", "e", "se"].indexOf(direction) * 4,
      );
    }
  }
  destroy() {
    this.sprite.destroy();
    this.label.destroy();
  }
}
