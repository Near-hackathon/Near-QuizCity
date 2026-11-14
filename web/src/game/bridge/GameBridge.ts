import type { ReactToGame, GameToReact } from "./messages";

export type GameBridge = {
  isReady(): boolean;
  send(message: ReactToGame): void;
  onReact(listener: (message: ReactToGame) => void): () => void;
  subscribe(listener: (message: GameToReact) => void): () => void;
  emit(message: GameToReact): void;
  dispose(): void;
};

export function createGameBridge(): GameBridge {
  const listeners = new Set<(message: GameToReact) => void>();
  const reactListeners = new Set<(message: ReactToGame) => void>();
  let disposed = false;
  let ready = false;
  const retained = new Map<string, ReactToGame>();
  return {
    isReady: () => ready && !disposed,
    send(message) {
      if (disposed) return;
      if (message.type === "settingsChanged" || message.type === "transportStatus") {
        const previous = retained.get(message.type);
        retained.set(
          message.type,
          message.type === "settingsChanged" && previous?.type === "settingsChanged"
            ? { type: "settingsChanged", settings: { ...previous.settings, ...message.settings } }
            : message,
        );
      }
      for (const listener of [...reactListeners]) {
        if (disposed) break;
        listener(message);
      }
    },
    onReact(listener) {
      if (disposed) return () => undefined;
      reactListeners.add(listener);
      for (const message of retained.values()) listener(message);
      return () => reactListeners.delete(listener);
    },
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(message) {
      if (disposed) return;
      if (message.type === "gameReady") ready = true;
      for (const listener of [...listeners]) {
        if (disposed) break;
        listener(message);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ready = false;
      retained.clear();
      listeners.clear();
      reactListeners.clear();
    },
  };
}
