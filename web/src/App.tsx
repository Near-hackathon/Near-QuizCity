import { useCallback, useEffect, useRef, useState } from "react";
import { createQueryCoordinator, startFallbackRefresh } from "./state/queries";
import { useAppState } from "./state/StateProvider";
import { api, type Business, type DemoAccount, type Job, type Property, type ServerConfig } from "./api";
import { clearSession, loadSession, saveSession, view, type ChainPlayer } from "./chain";
import type { WalletSession as Session } from "./wallet/types";
import { registerDemoKey, demoSigner, demoTransaction } from "./wallet/demo-loader";
import { useWallet } from "./wallet/WalletProvider";
import { ensureAuth, logout as authLogout } from "./auth";
import { BusinessPanel } from "./components/BusinessPanel";
import { CityGrid, PropertyCard, money } from "./components/CityGrid";
import { JobsPanel, QuizPanel } from "./components/JobsPanel";
import { Ledger } from "./components/Ledger";
import { Onboard } from "./components/Onboard";
import { CityLoading } from "./components/CityLoading";

type Notice = { kind: "ok" | "err"; text: string; tx?: string | null };

export type AppMode = "city" | "manage" | "admin";

export function App({ mode = "city" }: { mode?: AppMode } = {}) {
  const [session, setSession] = useState<Session | null>(loadSession());
  const [enteringCity, setEnteringCity] = useState(false);
  const [restoringSession, setRestoringSession] = useState(!!session);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [player, setPlayer] = useState<ChainPlayer | null>(null);
  const [balance, setBalance] = useState("0");
  const { state, dispatch } = useAppState();
  const wallet = useWallet();
  const coordinatorRef = useRef(createQueryCoordinator());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const properties = state.lists.propertyIds.map((id) => state.entities.properties[id]);
  const businesses = state.lists.businessIds.map((id) => state.entities.businesses[id]);
  const jobs = state.lists.jobIds.map((id) => state.entities.jobs[id]);
  const wallets = state.lists.walletIds.map((id) => state.entities.wallets[id]);
  const transactions = state.lists.transactionIds.map((id) => state.entities.transactions[id]);
  const economy = state.economy;

  const refresh = useCallback(async () => {
    const query = coordinatorRef.current.begin();
    const scopes = [
      ...(mode === "admin" ? [] : ["properties", "businesses"]),
      ...(mode === "manage" ? ["jobs", "quizzes"] : []),
      ...(mode === "admin" ? ["wallets", "transactions"] : []),
      "economy",
    ];
    for (const scope of scopes) dispatch({ type: "bootstrapStart", scope });
    try {
      const [p, b, j, q, w, t, e] = await Promise.all([
        mode === "admin" ? Promise.resolve(null) : api.properties({ signal: query.signal }),
        mode === "admin" ? Promise.resolve(null) : api.businesses({ signal: query.signal }),
        mode === "manage" ? api.jobs({ signal: query.signal }) : Promise.resolve(null),
        mode === "manage" ? api.quizzes({ signal: query.signal }) : Promise.resolve(null),
        mode === "admin" ? api.wallets({ signal: query.signal }) : Promise.resolve(null),
        mode === "admin" ? api.transactions({ signal: query.signal }) : Promise.resolve(null),
        api.economy({ signal: query.signal }),
      ]);
      if (query.signal.aborted || query.generation !== coordinatorRef.current.generation()) return;
      if (p) dispatch({ type: "properties", items: p });
      if (b) dispatch({ type: "businesses", items: b });
      if (j) dispatch({ type: "jobs", items: j });
      if (q) dispatch({ type: "quizzes", items: q });
      if (w) dispatch({ type: "wallets", items: w });
      if (t) dispatch({ type: "transactions", items: t });
      dispatch({ type: "economy", value: e });
      for (const scope of scopes) dispatch({ type: "bootstrapSuccess", scope });

      if (session) {
        const [chainPlayer, chainBalance] = await Promise.all([
          view<ChainPlayer | null>("get_player", { account: session.accountId }),
          view<string>("get_balance", { wallet: `player:${session.accountId}` }),
        ]);
        if (!query.signal.aborted) {
          setPlayer(chainPlayer);
          setBalance(chainBalance ?? "0");
        }
      } else {
        setPlayer(null);
        setBalance("0");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : "refresh failed";
      for (const scope of scopes) dispatch({ type: "bootstrapFailure", scope, message });
      throw error;
    } finally {
      query.finish();
    }
  }, [dispatch, mode, session]);

  useEffect(() => {
    let active = true;
    setRestoringSession(!!session);
    api
      .config()
      .then(async (runtime) => {
        if (!active) return;
        setConfig(runtime);
        if (!session) return;
        const signer =
          session.walletId === "demo"
            ? await demoSigner(runtime.demoMode, session.accountId)
            : await wallet
                .restore(runtime.networkId, runtime.contractId)
                .then((account) =>
                  account?.accountId === session.accountId ? wallet.signer(session.accountId) : null,
                );
        if (!signer) {
          throw new Error(
            runtime.demoMode
              ? "demo sign-in expired; select a demo account again"
              : "wallet is not connected or the account changed",
          );
        }
        const authenticated = await ensureAuth(session.accountId, signer);
        if (active) window.dispatchEvent(new Event("qc:auth-ready"));
        return authenticated;
      })
      .catch((err: Error) => {
        if (active) setNotice({ kind: "err", text: `sign-in failed: ${err.message}` });
      })
      .finally(() => {
        if (active) setRestoringSession(false);
      });
    return () => {
      active = false;
    };
  }, [session, wallet.restore, wallet.signer]);

  useEffect(() => {
    if (session?.walletId !== "demo" && wallet.account && wallet.account.accountId !== session?.accountId) {
      clearSession();
      setSession(null);
      dispatch({ type: "reset" });
      setNotice({
        kind: "err",
        text: `Wallet switched to ${wallet.account.accountId}; please sign in again.`,
      });
    }
  }, [dispatch, session, wallet.account]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    let active = true;
    refresh().catch((err: Error) => {
      if (active) setNotice({ kind: "err", text: err.message });
    });
    const stop = startFallbackRefresh({
      intervalMs: 20_000,
      isHidden: () => typeof document !== "undefined" && document.hidden,
      isOnline: () => typeof navigator === "undefined" || navigator.onLine,
      isRefreshing: () => busyRef.current,
      refresh: () => refresh().catch(() => undefined),
    });
    return () => {
      active = false;
      coordinatorRef.current.reset();
      stop();
    };
  }, [refresh]);

  async function run(action: () => Promise<string | null | undefined>, success: string) {
    setBusy(true);
    setNotice(null);
    try {
      const tx = await action();
      setNotice({ kind: "ok", text: success, tx: tx ?? null });
      await refresh();
    } catch (err) {
      setNotice({ kind: "err", text: err instanceof Error ? err.message : "action failed" });
    } finally {
      setBusy(false);
    }
  }

  function retryRefresh() {
    setNotice(null);
    void refresh().catch((err: Error) => setNotice({ kind: "err", text: err.message }));
  }

  const me = session?.accountId ?? null;
  const selected = properties.find((property) => property.id === selectedId) ?? null;
  const selectedBusiness = selected
    ? businesses.find((business) => business.property_id === selected.id)
    : undefined;

  async function login(account: DemoAccount) {
    if (!config?.demoMode) throw new Error("demo accounts are disabled by the server");
    setEnteringCity(true);
    try {
      await registerDemoKey(config.demoMode, account.accountId, account.publicKey, account.secretKey);
      const signer = await demoSigner(config.demoMode, account.accountId);
      if (!signer) throw new Error("demo signer unavailable");
      // Publish local identity only after the authenticated server session exists.
      // Otherwise the city route briefly falls back to the registration dashboard.
      await ensureAuth(account.accountId, signer);
      const next: Session = {
        accountId: account.accountId,
        publicKey: account.publicKey,
        networkId: config.networkId,
        walletId: "demo",
        authenticatedAt: new Date().toISOString(),
      };
      saveSession(next);
      setSession(next);
      setNotice({ kind: "ok", text: `Signed in as ${account.accountId}` });
    } catch {
      setNotice({ kind: "err", text: "Demo sign-in could not start. Refresh the page and try again." });
    } finally {
      setEnteringCity(false);
    }
  }

  async function connectNormalWallet() {
    setEnteringCity(true);
    try {
      if (!config) throw new Error("deployment configuration is not loaded");
      const account = await wallet.connect(config.networkId, config.contractId);
      if (!account) {
        setNotice({ kind: "err", text: "wallet connection was not completed" });
        return;
      }
      await ensureAuth(account.accountId, wallet.signer(account.accountId));
      const next: Session = {
        accountId: account.accountId,
        publicKey: account.publicKey,
        networkId: config.networkId,
        walletId: wallet.connector?.id ?? "my-near-wallet",
        authenticatedAt: new Date().toISOString(),
      };
      saveSession(next);
      setSession(next);
    } catch (error) {
      setNotice({
        kind: "err",
        text: error instanceof Error ? error.message : "wallet connection failed",
      });
    } finally {
      setEnteringCity(false);
    }
  }

  async function logout() {
    await Promise.all([authLogout(), wallet.disconnect()]);
    clearSession();
    coordinatorRef.current.reset();
    dispatch({ type: "reset" });
    setSession(null);
    setPlayer(null);
    setBalance("0");
    setSelectedId(null);
    setNotice(null);
  }

  const sendContractTransaction = useCallback(
    async (methodName: string, args: Record<string, unknown>): Promise<string> => {
      if (!session || !config) throw new Error("sign in before sending a transaction");
      const input = { receiverId: config.contractId, methodName, args };
      if (session.walletId === "demo") {
        const result = await demoTransaction(config.demoMode, session.accountId, input);
        if (!result) throw new Error("demo signer is unavailable; sign in again");
        return result.txHash;
      }
      const result = await wallet.sendTransaction(input);
      if (!result) throw new Error("wallet did not return a transaction result");
      return result.txHash;
    },
    [config, session, wallet.sendTransaction],
  );

  function buyProperty(property: Property) {
    if (!session) return;
    void run(async () => {
      const tx = await sendContractTransaction("buy_property", { property_id: Number(property.id) });
      await api.buyProperty(property.id, tx);
      return tx;
    }, `Bought plot #${property.id}`);
  }

  function openBusiness(property: Property, name: string) {
    if (!session) return;
    void run(async () => {
      const tx = await sendContractTransaction("create_business", {
        property_id: Number(property.id),
        name,
      });
      await api.createBusiness(property.id, name, tx);
      return tx;
    }, `Opened ${name}`);
  }

  function acceptJob(job: Job) {
    if (!me) return;
    void run(async () => {
      await api.acceptJob(job.id);
      return null;
    }, `Accepted "${job.title}"`);
  }

  function completeJob(job: Job) {
    if (!me) return;
    const success =
      job.status === "accepted"
        ? "Job submitted for operator verification"
        : job.status === "payment_failed"
          ? "Payment reconciled"
          : `Job paid: ${job.payment} QC`;
    void run(async () => {
      if (job.status === "accepted") {
        await api.submitJob(job.id, "Delivered through the demo client");
        return null;
      }
      if (job.status === "payment_failed") {
        await api.retryJobPayment(job.id);
        return null;
      }
      if (job.status !== "verified") {
        throw new Error("An operator must verify this job before payment");
      }
      const result = await api.completeJob(job.id);
      return result.txHash;
    }, success);
  }

  function payService(business: Business, amount: string) {
    if (!session) return;
    void run(
      async () => {
        const tx = await sendContractTransaction("pay_service", {
          business_id: business.id,
          amount,
        });
        await api.payService(business.id, amount, tx);
        return tx;
      },
      `Paid ${money(amount)} QC to ${business.name}`,
    );
  }

  function transferBusiness(business: Business, newOwner: string) {
    if (!session) return;
    void run(async () => {
      const tx = await sendContractTransaction("transfer_business", {
        business_id: business.id,
        new_owner: newOwner,
      });
      await api.transferBusiness(business.id, newOwner, tx);
      return tx;
    }, `Transferred ${business.name} to ${newOwner}`);
  }

  if (mode === "city" && (enteringCity || restoringSession)) return <CityLoading message="Signing you in…" />;

  return (
    <div className="shell">
      <header>
        <div>
          <h1>QUIZ CITY</h1>
          <p className="tagline">knowledge · work · ownership</p>
        </div>
        <div className="stats">
          <Stat label="Circulating QC" value={economy ? money(economy.circulating_qc) : "—"} />
          <Stat label="Residents" value={economy?.players ?? "—"} />
          <Stat label="Plots" value={economy?.properties ?? "—"} />
          <Stat label="Businesses" value={economy?.businesses ?? "—"} />
          <Stat label="Tx" value={economy?.transactions ?? "—"} />
        </div>
      </header>

      {mode === "city" && (
        <Onboard
          session={session}
          chainPlayer={player}
          onLogin={(account) => void login(account)}
          onLogout={logout}
          onConnect={() => void connectNormalWallet()}
          refresh={refresh}
          sendTransaction={sendContractTransaction}
        />
      )}

      {notice && (
        <div className={`notice ${notice.kind}`}>
          <span>{notice.text}</span>
          {notice.tx && (
            <a
              className="link"
              href={`https://testnet.nearblocks.io/txns/${notice.tx}`}
              target="_blank"
              rel="noreferrer"
            >
              view on chain
            </a>
          )}
          {notice.kind === "err" && (
            <button className="btn ghost small" onClick={retryRefresh}>
              Retry
            </button>
          )}
          <button className="notice-close" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      <main className="columns">
        {mode === "city" && (
          <div className="column">
            <CityGrid properties={properties} selectedId={selectedId} onSelect={setSelectedId} />

            {selected && (
              <section className="card">
                <PropertyCard
                  property={selected}
                  business={selectedBusiness}
                  me={me}
                  busy={busy}
                  onBuy={buyProperty}
                  onOpenBusiness={openBusiness}
                />
              </section>
            )}

            <BusinessPanel
              businesses={businesses}
              me={me}
              busy={busy}
              onPay={payService}
              onTransfer={transferBusiness}
            />
          </div>
        )}

        {mode !== "city" && (
          <div className="column">
            {mode === "manage" && session && (
              <section className="card player-card">
                <div className="card-head">
                  <h2>{player?.username ?? "Resident"}</h2>
                  <button className="btn ghost small" onClick={logout}>
                    switch
                  </button>
                </div>
                <p className="mono muted">{session.accountId}</p>
                <div className="balance">
                  <span>QC balance</span>
                  <strong>{money(balance)}</strong>
                </div>
                {!player && <p className="muted">Register above to claim your 500 QC.</p>}
              </section>
            )}

            {mode === "manage" && (
              <>
                <QuizPanel
                  me={me}
                  busy={busy}
                  start={async () => api.startQuiz("daily-quiz")}
                  submit={async (attemptId, answers) => api.submitQuiz("daily-quiz", attemptId, answers)}
                />
                <JobsPanel jobs={jobs} me={me} busy={busy} onAccept={acceptJob} onComplete={completeJob} />
                <BusinessPanel
                  businesses={businesses}
                  me={me}
                  busy={busy}
                  onPay={payService}
                  onTransfer={transferBusiness}
                />
              </>
            )}
            {mode === "admin" && <Ledger wallets={wallets} transactions={transactions} />}
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
