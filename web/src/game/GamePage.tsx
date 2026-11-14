import { sendManagedIntent } from "../wallet/managed-intents";
import { isBrowserAccount } from "@quiz-city/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, Navigate } from "react-router-dom";
import { clearSession, loadSession, saveSession, type Session } from "../chain";
import { createWorldTransport, type WorldTransport, type WorldStatus } from "../state/world-transport";

import { GameHost, type GameFactory } from "./GameHost";
import type { GameBridge } from "./bridge/GameBridge";
import { CITY_DISTRICT_SCENE_ID } from "./types/game";
import { api } from "../api";
import { GameUi } from "./ui/GameUi";
import { logout as authLogout, ensureAuth } from "../auth";
import { useWallet } from "../wallet/WalletProvider";
import { clearDemoKeys } from "../wallet/demo-loader";
import { useAppState } from "../state/StateProvider";
import { CityLoading } from "../components/CityLoading";
import { sendDemoWalletTransaction } from "./demo-wallet";
import { CONTRACT, NETWORK, viewContract } from "../wallet/rpc";
import type { ChainPlayer } from "../chain";
import { createWalletSetup } from "./wallet-setup";

function sceneHint(path: string): string {
  if (!path.startsWith("/interior/")) return CITY_DISTRICT_SCENE_ID;
  let id: string;
  try {
    id = decodeURIComponent(path.slice("/interior/".length));
  } catch {
    return CITY_DISTRICT_SCENE_ID;
  }
  return /^[a-z0-9_-]{1,64}$/.test(id) ? id : CITY_DISTRICT_SCENE_ID;
}

export function GamePage({
  transport: injected,
  createGameFn,
}: {
  transport?: WorldTransport;
  createGameFn?: GameFactory;
} = {}) {
  const location = useLocation();
  const { disconnect, restore, sendTransaction, connect, signer, connector } = useWallet();
  const { dispatch } = useAppState();
  const navigate = useNavigate();
  const pathRef = useRef(location.pathname);
  const navigateRef = useRef(navigate);
  pathRef.current = location.pathname;
  navigateRef.current = navigate;
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [ownedBridge, setOwnedBridge] = useState<{ bridge: GameBridge; identity: string | null } | null>(
    null,
  );
  const [status, setStatus] = useState<WorldStatus>("offline");
  const [authCheck, setAuthCheck] = useState(0);
  const [authenticated, setAuthenticated] = useState<string | null>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [authoritativePath, setAuthoritativePath] = useState<string | null>(null);
  const identity = session ? `${session.networkId}:${session.accountId}:${session.authenticatedAt}` : null;
  const setupWallet = useMemo(
    () =>
      createWalletSetup({
        player: () => viewContract<ChainPlayer | null>("get_player", { account: session?.accountId }),
        send: async (methodName, args) => {
          if (!session) throw new Error("Sign in again before setting up your wallet.");
          const config = await api.config();
          if (config.contractId !== CONTRACT || config.networkId !== NETWORK)
            throw new Error("The browser and server chain configuration differ. Check local configuration.");
          if (config.networkId !== session.networkId)
            throw new Error("Your wallet network has changed. Sign in again.");
          const input = { receiverId: config.contractId, methodName, args };
          if (session.walletId === "embedded")
            return sendManagedIntent(session.accountId, methodName, args, api.managedTransaction);
          if (session.walletId !== "demo") {
            const account = await restore(config.networkId, config.contractId);
            if (account?.accountId !== session.accountId)
              throw new Error("Reconnect the wallet you used to sign in.");
          }
          const result =
            session.walletId === "demo"
              ? await sendDemoWalletTransaction(config.demoMode, session.accountId, input)
              : await sendTransaction(input);
          if (!result) throw new Error("Wallet approval was not completed. Please try again.");
          return result.txHash;
        },
        register: api.register,
        claim: api.claim,
      }),
    [identity, sendTransaction, restore],
  );
  const bridge = ownedBridge?.identity === identity ? ownedBridge.bridge : null;
  const connectProfileWallet = async () => {
    if (!session) return;
    const profiles = await api.profiles();
    const profile = profiles.profiles.find((p) => p.accountId === session.accountId);
    const config = await api.config();
    const account = await connect(config.networkId, config.contractId);
    if (!account) throw new Error("Wallet connection was cancelled.");
    await ensureAuth(account.accountId, signer(account.accountId), true);
    try {
      await api.linkProfileWallet(profile?.id);
    } catch (error) {
      if (profile) await api.enterProfile(profile.id);
      throw error;
    }
    saveSession({
      accountId: account.accountId,
      publicKey: account.publicKey,
      networkId: config.networkId,
      walletId: connector?.id ?? "my-near-wallet",
      authenticatedAt: new Date().toISOString(),
    });
  };
  const transact = async (methodName: string, args: Record<string, unknown>) => {
    if (!session || isBrowserAccount(session.accountId))
      throw new Error("Connect your wallet in the Wallet app first.");
    const cfg = await api.config();
    if (session.walletId === "embedded")
      return sendManagedIntent(session.accountId, methodName, args, api.managedTransaction);
    if (session.walletId !== "demo") {
      const account = await restore(cfg.networkId, cfg.contractId);
      if (account?.accountId !== session.accountId)
        throw new Error("Connect your saved wallet in the Wallet app first.");
    }
    const input = { receiverId: cfg.contractId, methodName, args };
    const result =
      session.walletId === "demo"
        ? await sendDemoWalletTransaction(cfg.demoMode, session.accountId, input)
        : await sendTransaction(input);
    if (!result) throw new Error("Transaction approval was cancelled.");
    return result.txHash;
  };
  const readWallet = useCallback(async () => {
    if (session ? isBrowserAccount(session.accountId) : false) return null;
    const player = await viewContract<ChainPlayer | null>("get_player", { account: session?.accountId });
    return player ? viewContract<string>("get_balance", { wallet: `player:${session?.accountId}` }) : null;
  }, [identity]);
  const attachBridge = useCallback(
    (next: GameBridge) => setOwnedBridge({ bridge: next, identity }),
    [identity],
  );
  const transport = useMemo(
    () => injected ?? (identity ? createWorldTransport() : null),
    [injected, identity],
  );

  const signOut = async () => {
    bridge?.send({ type: "settingsChanged", settings: { uiModalOpen: true } });
    transport?.disconnect();
    await Promise.allSettled([
      authLogout(),
      disconnect(),
      session?.walletId === "demo" ? clearDemoKeys() : Promise.resolve(),
    ]);
    clearSession();
    dispatch({ type: "reset" });
    setAuthoritativePath(null);
    setAuthenticated(null);
    setSession(null);
    navigate("/", { replace: true });
  };

  useEffect(() => {
    if (!session?.profileId || !isBrowserAccount(session.accountId)) return;
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const status = await api.managedWalletStatus(session.profileId!);
        if (!active) return;
        if (status.stage === "ready") {
          const entered = await api.enterProfile(session.profileId!);
          if (active)
            saveSession({
              ...session,
              accountId: entered.profile.accountId,
              walletId: "embedded",
              authenticatedAt: new Date().toISOString(),
            });
          return;
        }
        if (status.stage === "not_requested") return;
      } catch {
        /* The saved device login remains available. */
      }
      if (active) timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [identity]);
  useEffect(() => {
    const refresh = () => setSession(loadSession());
    const recheck = () => setAuthCheck((value) => value + 1);
    window.addEventListener("qc:session-changed", refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener("qc:auth-ready", recheck);
    return () => {
      window.removeEventListener("qc:session-changed", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("qc:auth-ready", recheck);
    };
  }, []);

  useEffect(() => {
    let active = true;
    setAuthenticated(null);
    setAuthFailed(false);
    setAuthoritativePath(null);
    if (session) {
      void api.authMe().then(
        (me) => {
          if (!active) return;
          if (me.accountId === session.accountId) setAuthenticated(identity);
          else setAuthFailed(true);
        },
        () => {
          if (active) setAuthFailed(true);
        },
      );
    }
    return () => {
      active = false;
    };
  }, [identity, authCheck]);

  useEffect(() => {
    if (authoritativePath && location.pathname !== authoritativePath) {
      navigate(authoritativePath, { replace: true });
    }
  }, [authoritativePath, location.pathname, navigate]);

  useEffect(() => {
    if (!transport || !bridge || !session || authenticated !== identity) return;
    const accountId = session.accountId;
    let connected = false;
    let active = true;
    let online = false;
    const connect = () => {
      if (!connected && bridge.isReady()) {
        connected = true;
        transport.connect(sceneHint(pathRef.current), null);
      }
    };
    const offStatus = transport.onStatus((next) => {
      online = next === "online";
      setStatus(next);
      bridge.send({ type: "transportStatus", status: next });
    });
    const offMessage = transport.onMessage((message) => {
      if (message.type === "world.bootstrap") {
        if (message.player.accountId !== accountId) {
          transport.disconnect();
          setCommandError("Your account changed. Please sign in again.");
          return;
        }
        bridge.send({ type: "bootstrap", bootstrap: message });
        setCommandError(null);
        if (message.scene.id === CITY_DISTRICT_SCENE_ID || message.scene.sceneType === "exterior") {
          setAuthoritativePath("/play");
          if (pathRef.current !== "/play") navigateRef.current("/play", { replace: true });
        } else if (message.scene.sceneType === "interior") {
          setAuthoritativePath(`/interior/${message.scene.id}`);
          navigateRef.current(`/interior/${message.scene.id}`, { replace: true });
        }
      }
    });
    const unsubscribe = bridge.subscribe((message) => {
      if (message.type === "gameReady") {
        connect();
      } else if (message.type === "moveIntent" || message.type === "interactIntent") {
        if (!online) {
          bridge.send({ type: "commandResult", requestId: message.requestId, accepted: false });
          return;
        }
        const result =
          message.type === "moveIntent"
            ? transport.sendMove(message.x, message.y)
            : transport.sendInteract(message.targetType, message.targetId);
        void result.then(
          () => {
            if (active) bridge.send({ type: "commandResult", requestId: message.requestId, accepted: true });
          },
          (error: unknown) => {
            if (!active) return;
            bridge.send({ type: "commandResult", requestId: message.requestId, accepted: false });
            setCommandError(
              error instanceof Error && error.message === "TARGET_CLOSED"
                ? "This building is closed right now. Check its opening hours."
                : "That action could not be accepted. Please try again.",
            );
          },
        );
      } else if (message.type === "fatalError") {
        transport.disconnect();
      }
    });
    const offEvents = transport.onEvent((event) => {
      bridge.send({ type: "worldEvent", event });
      if (event.type === "player.scene_changed" && event.payload.accountId === accountId) {
        setAuthoritativePath(
          event.payload.sceneId === CITY_DISTRICT_SCENE_ID ? "/play" : `/interior/${event.payload.sceneId}`,
        );
        navigateRef.current(
          event.payload.sceneId === CITY_DISTRICT_SCENE_ID ? "/play" : `/interior/${event.payload.sceneId}`,
          { replace: true },
        );
      }
    });
    connect();
    return () => {
      active = false;
      offStatus();
      offMessage();
      offEvents();
      unsubscribe();
      transport.disconnect();
    };
  }, [bridge, identity, authenticated, transport]);

  if (!session || authFailed)
    return (
      <>
        <Navigate to="/" replace />
        <Outlet />
      </>
    );
  if (authenticated !== identity) return <CityLoading message="Checking your city session…" />;
  return (
    <>
      <h1 className="visually-hidden">Quiz City</h1>
      <GameHost key={identity} createGameFn={createGameFn} onBridge={attachBridge} />
      <GameUi
        key={`ui:${identity}`}
        bridge={bridge}
        accountId={session.accountId}
        networkId={session.networkId}
        status={status}
        onSignOut={signOut}
        onSetupWallet={
          isBrowserAccount(session.accountId)
            ? undefined
            : async () => {
                const result = await api.profiles();
                const profile = result.profiles.find((p) => p.accountId === session.accountId);
                await setupWallet(
                  profile?.username ?? session.accountId.split(".")[0].replace("-quizcity", "").slice(0, 32),
                );
              }
        }
        onReadWallet={readWallet}
        onTransaction={transact}
        onConnectWallet={session.walletId === "embedded" ? undefined : connectProfileWallet}
      />
      <p className="game-status" aria-live="polite">
        World: {status}
      </p>
      {status === "reconnecting" || status === "resyncing" ? (
        <aside className="city-reconnect" role="status">
          Reconnecting to the city. Movement resumes when the connection is ready.{" "}
          <button onClick={() => transport?.connect(sceneHint(pathRef.current), null)}>Reconnect now</button>
        </aside>
      ) : null}
      {commandError ? <p role="alert">{commandError}</p> : null}
      <Outlet />
    </>
  );
}
