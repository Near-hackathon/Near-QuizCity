import { describe, expect, it } from "vitest";
import type { GameToReact, ReactToGame } from "./messages";

function label(message: GameToReact | ReactToGame): string {
  switch (message.type) {
    case "bootstrap":
    case "worldEvent":
    case "transportStatus":
    case "settingsChanged":
    case "commandResult":
    case "dispose":
    case "activateInteraction":
      return `react:${message.type}`;
    case "gameReady":
    case "transitionStatus":
    case "moveIntent":
    case "interactIntent":
    case "interactionCandidateChanged":
    case "sceneRendered":
    case "metrics":
    case "interactionCompleted":
    case "fatalError":
      return `game:${message.type}`;
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

describe("bridge messages", () => {
  it("narrows every message channel discriminant", () => {
    expect(label({ type: "dispose" })).toBe("react:dispose");
    expect(label({ type: "gameReady" })).toBe("game:gameReady");
    expect(label({ type: "moveIntent", requestId: "move-1", x: 1, y: 2 })).toBe("game:moveIntent");
    expect(label({ type: "fatalError", message: "bad" })).toBe("game:fatalError");
  });
});
