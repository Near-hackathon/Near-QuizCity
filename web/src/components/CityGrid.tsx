import { useState } from "react";
import type { Business, Property } from "../api";

const COLS = 8;
const ROWS = 6;

export function short(wallet: string) {
  return wallet
    .replace("player:", "")
    .replace("-quizcity", "")
    .replace(".testnet", "")
    .replace("biz:", "business #")
    .replace("gov:", "")
    .replace("npc:", "");
}

export function money(value: string) {
  const canonical = value.replace(/^0+(?=\d)/, "");
  return canonical.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

type GridProps = {
  properties: Property[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
};

export function CityGrid({ properties, selectedId, onSelect }: GridProps) {
  const byTile = new Map(properties.map((p) => [`${p.x}:${p.y}`, p]));
  const tiles = Array.from({ length: COLS * ROWS }, (_, i) => ({
    x: i % COLS,
    y: Math.floor(i / COLS),
  }));

  return (
    <section className="card">
      <div className="card-head">
        <h2>Knowledge / Commercial District</h2>
        <span className="muted">click a plot</span>
      </div>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}>
        {tiles.map(({ x, y }) => {
          const property = byTile.get(`${x}:${y}`);
          return (
            <button
              key={`${x}:${y}`}
              type="button"
              onClick={() => onSelect(property ? property.id : null)}
              className={`tile ${property ? "owned" : "empty"} ${property?.for_sale ? "for-sale" : ""} ${
                property && property.id === selectedId ? "selected" : ""
              }`}
            >
              {property ? (
                <>
                  <span className="tile-kind">{property.property_type}</span>
                  <span className="tile-owner">{short(property.owner_wallet)}</span>
                  {property.for_sale && <span className="tile-price">{money(property.price)} QC</span>}
                </>
              ) : (
                <span className="tile-empty">
                  {x},{y}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

type PropertyCardProps = {
  property: Property;
  business: Business | undefined;
  me: string | null;
  busy: boolean;
  onBuy: (property: Property) => void;
  onOpenBusiness: (property: Property, name: string) => void;
};

export function PropertyCard({ property, business, me, busy, onBuy, onOpenBusiness }: PropertyCardProps) {
  const [name, setName] = useState("Central Quiz Centre");
  const mine = me !== null && property.owner_wallet === `player:${me}`;

  return (
    <div className="property-card">
      <div className="card-head">
        <h3>
          Plot #{property.id} · {property.property_type}
        </h3>
        <span className="pill">{property.district}</span>
      </div>
      <dl className="kv">
        <dt>Owner</dt>
        <dd className="mono">{property.owner_wallet}</dd>
        <dt>Status</dt>
        <dd>
          {property.for_sale
            ? `For sale · ${money(property.price)} QC`
            : mine
              ? "Owned by you"
              : "Not listed"}
        </dd>
        <dt>Transfers</dt>
        <dd>{property.transfer_count}</dd>
      </dl>

      {property.for_sale && (
        <button className="btn primary" disabled={busy || !me} onClick={() => onBuy(property)}>
          {me ? `Buy for ${money(property.price)} QC` : "Sign in to buy"}
        </button>
      )}

      {mine && !business && (
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            onOpenBusiness(property, name);
          }}
        >
          <input
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
          />
          <button className="btn primary" disabled={busy || name.trim() === ""}>
            Open business · 100 QC permit
          </button>
        </form>
      )}

      {business && (
        <p className="muted">
          Business: <strong>{business.name}</strong> · treasury {short(business.treasury_wallet)} · revenue{" "}
          {money(business.revenue_total)} QC
        </p>
      )}
    </div>
  );
}
