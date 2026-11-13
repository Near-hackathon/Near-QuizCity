import type { Tx, Wallet } from "../api";
import { money, short } from "./CityGrid";

type Props = {
  wallets: Wallet[];
  transactions: Tx[];
};

export function Ledger({ wallets, transactions }: Props) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Ledger</h2>
        <span className="muted">mirrored from chain</span>
      </div>

      <h3 className="subhead">Wallets</h3>
      <ul className="list">
        {wallets.length === 0 && <li className="muted">no wallets yet</li>}
        {wallets.map((wallet) => (
          <li key={wallet.wallet_id}>
            <span className={`dot ${wallet.owner_type}`} />
            <span className="mono">{short(wallet.wallet_id)}</span>
            <strong>{money(wallet.balance)} QC</strong>
          </li>
        ))}
      </ul>

      <h3 className="subhead">Recent transactions</h3>
      <ul className="list">
        {transactions.length === 0 && <li className="muted">no transactions yet</li>}
        {transactions.map((tx) => (
          <li key={tx.seq}>
            <span className="mono">
              {tx.wallet_from ? short(tx.wallet_from) : "mint"} →{" "}
              {tx.wallet_to ? short(tx.wallet_to) : "burn"}
            </span>
            <strong>{money(tx.amount)}</strong>
            <span className="kind">{tx.kind}</span>
            {tx.tx_hash && (
              <a
                className="link"
                href={`https://testnet.nearblocks.io/txns/${tx.tx_hash}`}
                target="_blank"
                rel="noreferrer"
              >
                chain
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
