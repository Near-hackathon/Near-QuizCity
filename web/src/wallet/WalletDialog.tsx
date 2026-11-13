type Props = {
  networkId: string;
  contractId: string;
  error: string | null;
  connecting: boolean;
  onConnect: () => void;
  onClose: () => void;
};

export function WalletDialog({ networkId, contractId, error, connecting, onConnect, onClose }: Props) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="wallet-dialog-title" className="card">
      <h2 id="wallet-dialog-title">Connect a NEAR wallet</h2>
      <p className="muted">
        Network <span className="mono">{networkId}</span> · {contractId}
      </p>
      <button className="btn primary" disabled={connecting} onClick={onConnect}>
        {connecting ? "Connecting..." : "Continue with MyNearWallet"}
      </button>
      <button className="btn ghost" onClick={onClose}>
        Cancel
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
