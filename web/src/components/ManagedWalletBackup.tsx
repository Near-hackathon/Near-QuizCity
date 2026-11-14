import { Spinner } from "./LoadingStatus";
import { useState } from "react";
import { api, type Resident } from "../api";
export function ManagedWalletBackup({ profile }: { profile: Resident }) {
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  if (profile.walletKind !== "embedded") return null;
  const download = async () => {
    setBusy(true);
    setMessage("");
    try {
      const blob = await api.downloadManagedBackup(profile.id),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = `quiz-city-${profile.username}-testnet-backup.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        "Recovery backup downloaded. Keep it private and import it into a compatible NEAR wallet to recover on another device.",
      );
      setConfirmed(false);
    } catch {
      setMessage("The recovery backup could not be downloaded. Wait for account confirmation, then retry.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Testnet wallet recovery">
      <h4>Keep a recovery backup</h4>
      <p>
        This is a game-managed testnet wallet. The game retains an encrypted key. The backup file gives access
        to this same account and its assets.
      </p>
      <label>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I
        understand this file controls my testnet account and must be kept private.
      </label>
      <button disabled={!confirmed || busy} onClick={() => void download()}>
        {busy ? (
          <>
            <Spinner />
            Preparing backup…
          </>
        ) : (
          "Download testnet wallet backup"
        )}
      </button>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
