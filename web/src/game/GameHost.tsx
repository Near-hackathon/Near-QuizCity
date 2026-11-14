import { useEffect, useRef, useState } from "react";
import { createGameBridge, type GameBridge } from "./bridge/GameBridge";
import "./game.css";
import { loadPreferences } from "./settings/settings";
import { CityLoading } from "../components/CityLoading";

export type GameInstance = { destroy(removeCanvas: boolean): void | Promise<void> };
export type GameFactory = (
  parent: HTMLElement,
  bridge: GameBridge,
  signal: AbortSignal,
) => GameInstance | Promise<GameInstance>;
const defaultFactory: GameFactory = async (parent, bridge, signal) => {
  const { createGame } = await import("./createGame");
  signal.throwIfAborted();
  return createGame(parent, bridge);
};
export function GameHost({
  createGameFn = defaultFactory,
  onBridge,
}: {
  createGameFn?: GameFactory;
  onBridge?: (bridge: GameBridge) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const game = useRef<GameInstance | null>(null);
  const lifecycle = useRef<Promise<void>>(Promise.resolve());
  const [failed, setFailed] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loadingStage, setLoadingStage] = useState<string | null>("Preparing city assets…");
  useEffect(() => {
    const parent = container.current;
    if (!parent || game.current) return;
    let cancelled = false;
    const abort = new AbortController();
    const bridge = createGameBridge();
    onBridge?.(bridge);
    const offBridge = bridge.subscribe((message) => {
      if (message.type === "fatalError") setFailed(message.message);
      if (message.type === "gameReady") setLoadingStage("Connecting to the city…");
      if (message.type === "sceneRendered") setLoadingStage(null);
    });
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const sendSettings = () =>
      bridge.send({
        type: "settingsChanged",
        settings: {
          reducedMotion: loadPreferences().reducedMotion,
          online: typeof navigator === "undefined" || navigator.onLine,
          transitioning: false,
          hidden: typeof document !== "undefined" && document.hidden,
        },
      });
    const onVisibility = () => sendSettings();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onVisibility);
    window.addEventListener("offline", onVisibility);
    document.addEventListener("focusin", onVisibility);
    document.addEventListener("focusout", onVisibility);
    motion?.addEventListener("change", onVisibility);
    sendSettings();
    const startup = lifecycle.current.then(async () => {
      try {
        // Let Strict Mode finish its probe cleanup before allocating browser resources.
        await Promise.resolve();
        if (cancelled) return;
        const instance = await createGameFn(parent, bridge, abort.signal);
        if (cancelled) {
          await instance.destroy(true);
          return;
        }
        game.current = instance;
      } catch (error) {
        if (!cancelled) setFailed(error instanceof Error ? error.message : "game failed to load");
      }
    });
    lifecycle.current = startup;
    return () => {
      cancelled = true;
      abort.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onVisibility);
      window.removeEventListener("offline", onVisibility);
      document.removeEventListener("focusin", onVisibility);
      document.removeEventListener("focusout", onVisibility);
      motion?.removeEventListener("change", onVisibility);
      bridge.send({ type: "dispose" });
      offBridge();
      const instance = game.current;
      if (instance) {
        const destroyed = instance.destroy(true);
        lifecycle.current = startup.then(() => destroyed);
      }
      game.current = null;
      bridge.dispose();
    };
  }, [createGameFn, onBridge, retry]);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failed) errorRef.current?.focus();
  }, [failed]);
  return (
    <div className="game-host">
      <div ref={container} className="game-container" aria-label="Quiz City game" />
      {loadingStage && !failed ? <CityLoading message={loadingStage} overlay /> : null}
      {failed ? (
        <div ref={errorRef} className="game-error" role="alert" tabIndex={-1}>
          <p>Unable to load the city.</p>
          <button
            type="button"
            onClick={() => {
              setFailed(null);
              setLoadingStage("Preparing city assets…");
              setRetry((x) => x + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}
