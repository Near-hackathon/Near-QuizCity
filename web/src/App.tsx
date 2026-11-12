import { useCallback, useEffect, useState } from "react";
import {
  api,
  type Business,
  type DemoAccount,
  type Economy,
  type Job,
  type Property,
  type Tx,
  type Wallet,
} from "./api";
import { call, clearSession, loadSession, saveSession, view, type ChainPlayer, type Session } from "./chain";
import { BusinessPanel } from "./components/BusinessPanel";
import { CityGrid, PropertyCard, money } from "./components/CityGrid";
import { JobsPanel, QuizPanel } from "./components/JobsPanel";
import { Ledger } from "./components/Ledger";
import { Onboard } from "./components/Onboard";

type Notice = { kind: "ok" | "err"; text: string; tx?: string | null };

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession());
  const [player, setPlayer] = useState<ChainPlayer | null>(null);
  const [balance, setBalance] = useState("0");
  const [properties, setProperties] = useState<Property[]>([]);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [transactions, setTransactions] = useState<Tx[]>([]);
  const [economy, setEconomy] = useState<Economy | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const refresh = useCallback(async () => {
    const [p, b, j, w, t, e] = await Promise.all([
      api.properties(),
      api.businesses(),
      api.jobs(),
      api.wallets(),
      api.transactions(),
      api.economy(),
    ]);
    setProperties(p);
    setBusinesses(b);
    setJobs(j);
    setWallets(w);
    setTransactions(t);
    setEconomy(e);

    if (session) {
      const [chainPlayer, chainBalance] = await Promise.all([
        view<ChainPlayer | null>("get_player", { account: session.accountId }),
        view<string>("get_balance", { wallet: `player:${session.accountId}` }),
      ]);
      setPlayer(chainPlayer);
      setBalance(chainBalance ?? "0");
    } else {
      setPlayer(null);
      setBalance("0");
    }
  }, [session]);

  useEffect(() => {
    refresh().catch((err: Error) => setNotice({ kind: "err", text: err.message }));
    const timer = setInterval(() => {
      refresh().catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
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

  const me = session?.accountId ?? null;
  const selected = properties.find((property) => property.id === selectedId) ?? null;
  const selectedBusiness = selected
    ? businesses.find((business) => Number(business.property_id) === selected.id)
    : undefined;

  function login(account: DemoAccount) {
    const next: Session = {
      accountId: account.accountId,
      publicKey: account.publicKey,
      secretKey: account.secretKey,
    };
    saveSession(next);
    setSession(next);
    setNotice({ kind: "ok", text: `Signed in as ${account.accountId}` });
  }

  function logout() {
    clearSession();
    setSession(null);
    setPlayer(null);
    setBalance("0");
    setSelectedId(null);
    setNotice(null);
  }

  function buyProperty(property: Property) {
    if (!session) return;
    void run(async () => {
      const tx = await call(session, "buy_property", { property_id: property.id });
      await api.buyProperty(property.id, session.accountId, tx);
      return tx;
    }, `Bought plot #${property.id}`);
  }

  function openBusiness(property: Property, name: string) {
    if (!session) return;
    void run(async () => {
      const tx = await call(session, "create_business", { property_id: property.id, name });
      await api.createBusiness(session.accountId, property.id, name, tx);
      return tx;
    }, `Opened ${name}`);
  }

  function acceptJob(job: Job) {
    if (!me) return;
    void run(async () => {
      await api.acceptJob(job.id, me);
      return null;
    }, `Accepted "${job.title}"`);
  }

  function completeJob(job: Job) {
    if (!me) return;
    void run(async () => {
      const result = await api.completeJob(job.id, me);
      return result.txHash;
    }, `Job paid: ${job.payment} QC`);
  }

  function payService(business: Business, amount: number) {
    if (!session) return;
    void run(async () => {
      const tx = await call(session, "pay_service", { business_id: business.id, amount: String(amount) });
      await api.payService(business.id, session.accountId, amount, tx);
      return tx;
    }, `Paid ${amount} QC to ${business.name}`);
  }

  function transferBusiness(business: Business, newOwner: string) {
    if (!session) return;
    void run(async () => {
      const tx = await call(session, "transfer_business", { business_id: business.id, new_owner: newOwner });
      await api.transferBusiness(business.id, session.accountId, newOwner, tx);
      return tx;
    }, `Transferred ${business.name} to ${newOwner}`);
  }

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

      <Onboard session={session} chainPlayer={player} onLogin={login} onLogout={logout} refresh={refresh} />

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
          <button className="notice-close" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      <main className="columns">
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

        <div className="column">
          {session && (
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

          <QuizPanel
            me={me}
            busy={busy}
            start={async () => api.startQuiz("daily-quiz", session!.accountId)}
            submit={async (attemptId, answers) =>
              api.submitQuiz("daily-quiz", session!.accountId, attemptId, answers)
            }
          />

          <JobsPanel jobs={jobs} me={me} busy={busy} onAccept={acceptJob} onComplete={completeJob} />

          <Ledger wallets={wallets} transactions={transactions} />
        </div>
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
