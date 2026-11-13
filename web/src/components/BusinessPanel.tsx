import { useState } from "react";
import type { Business } from "../api";
import { money } from "./CityGrid";

type Props = {
  businesses: Business[];
  me: string | null;
  busy: boolean;
  onPay: (business: Business, amount: string) => void;
  onTransfer: (business: Business, newOwner: string) => void;
};

export function BusinessPanel({ businesses, me, busy, onPay, onTransfer }: Props) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Businesses</h2>
        <span className="muted">venue services</span>
      </div>
      <div className="stack">
        {businesses.length === 0 && <p className="muted">No businesses yet. Buy a plot, then open one.</p>}
        {businesses.map((business) => (
          <BusinessCard
            key={business.id}
            business={business}
            me={me}
            busy={busy}
            onPay={onPay}
            onTransfer={onTransfer}
          />
        ))}
      </div>
    </section>
  );
}

type CardProps = {
  business: Business;
  me: string | null;
  busy: boolean;
  onPay: (business: Business, amount: string) => void;
  onTransfer: (business: Business, newOwner: string) => void;
};

function BusinessCard({ business, me, busy, onPay, onTransfer }: CardProps) {
  const [newOwner, setNewOwner] = useState("bob-quizcity.testnet");
  const mine = me === business.owner_account;

  return (
    <article className="business">
      <div className="card-head">
        <strong>{business.name}</strong>
        <span className="pill">{business.status}</span>
      </div>
      <dl className="kv">
        <dt>Owner</dt>
        <dd className="mono">{business.owner_account}</dd>
        <dt>Treasury</dt>
        <dd className="mono">{business.treasury_wallet}</dd>
        <dt>Revenue</dt>
        <dd>{money(business.revenue_total)} QC</dd>
      </dl>

      <div className="row">
        <button className="btn primary" disabled={busy || !me || mine} onClick={() => onPay(business, "20")}>
          {mine ? "This is your venue" : me ? "Buy quiz ticket · 20 QC" : "Sign in to buy"}
        </button>
      </div>

      {mine && (
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            onTransfer(business, newOwner);
          }}
        >
          <input
            className="field mono"
            value={newOwner}
            onChange={(event) => setNewOwner(event.target.value)}
            placeholder="new owner account"
          />
          <button className="btn" disabled={busy || newOwner.trim() === ""}>
            Transfer business
          </button>
        </form>
      )}
    </article>
  );
}
