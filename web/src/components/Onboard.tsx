import { useEffect, useState } from "react";
import { api, type DemoAccount, type ServerConfig } from "../api";
import { call, type ChainPlayer, type Session } from "../chain";

type Props = {
  session: Session | null;
  chainPlayer: ChainPlayer | null;
  onLogin: (session: Session) => void;
  onLogout: () => void;
  refresh: () => Promise<void>;
};

export function Onboard({ session, chainPlayer, onLogin, onLogout, refresh }: Props) {
  const [demo, setDemo] = useState<DemoAccount[]>([]);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .config()
      .then((data) => {
        setConfig(data);
        if (data.demoMode) {
          return api.demoAccounts().then((accounts) => setDemo(accounts.accounts));
        }
        return undefined;
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (session) setUsername(session.accountId.split(".")[0].replace("-quizcity", ""));
  }, [session]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "action failed");
    } finally {
      setBusy(false);
    }
  }

  function register() {
    if (!session) return;
    void run(async () => {
      const hash = await call(session, "register_player", { username });
      await api.register(session.accountId, hash);
    });
  }

  function claim() {
    if (!session) return;
    void run(async () => {
      const hash = await call(session, "claim_starter", {});
      await api.claim(session.accountId, hash);
    });
  }

  if (!session) {
    return (
      <section className="card onboard">
        <h2>Enter the city</h2>
        {!config ? (
          <p className="muted">Loading deployment configuration...</p>
        ) : config.demoMode ? (
          <>
            <p className="warning">
              Disposable testnet keys only. They are served only with{" "}
              <span className="mono">DEMO_MODE=1</span> and stored in this browser&apos;s localStorage. Never
              use them for real assets.
            </p>
            <p className="muted">
              Playing on <span className="mono">{config.networkId}</span> · {config.contractId}
            </p>
            <div className="account-list">
              {demo.map((account, index) => (
                <button
                  key={account.accountId}
                  className="account-choice"
                  disabled={busy}
                  onClick={() => onLogin(account)}
                >
                  <span className={`dot ${index === 0 ? "player" : "business"}`} />
                  <strong>{account.accountId.split("-")[0]}</strong>
                  <span className="mono">{account.accountId}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="readonly-note">
            <p className="muted">
              This deployment is read-only. Wallet sign-in is unavailable until QC-0502 is implemented; there
              is no account picker in non-demo mode.
            </p>
            <p className="muted mono">
              {config.networkId} · {config.contractId}
            </p>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  if (chainPlayer?.starter_claimed) {
    return null;
  }

  return (
    <section className="card onboard">
      <h2>{chainPlayer ? "Claim your allowance" : "Register as a resident"}</h2>
      <p className="muted mono">{session.accountId}</p>

      {chainPlayer ? (
        <div className="row">
          <p>
            You are registered as <strong>{chainPlayer.username}</strong>. Claim 500 QC to start trading.
          </p>
          <button className="btn primary" disabled={busy} onClick={claim}>
            {busy ? "Claiming..." : "Claim 500 QC"}
          </button>
        </div>
      ) : (
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            register();
          }}
        >
          <input
            className="field"
            value={username}
            maxLength={32}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Resident name"
          />
          <button className="btn primary" disabled={busy || username.trim() === ""}>
            {busy ? "Registering..." : "Register on chain"}
          </button>
        </form>
      )}

      <button className="btn ghost" onClick={onLogout} disabled={busy}>
        Switch account
      </button>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
