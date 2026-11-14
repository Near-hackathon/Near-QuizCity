import { LoadingStatus } from "../../components/LoadingStatus";
import { useEffect, useRef, useState } from "react";
import { api, type Business } from "../../api";
type Item = Awaited<ReturnType<typeof api.catalogue>>["items"][number];
type Order = Awaited<ReturnType<typeof api.myOrders>>["orders"][number];
type Send = (method: string, args: Record<string, unknown>) => Promise<string>;
const money = (v: string) => v.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function ShopsPanel({
  businesses,
  accountId,
  online,
  send,
  onChanged,
}: {
  businesses: Business[];
  accountId: string;
  online: boolean;
  send?: Send;
  onChanged: () => void;
}) {
  const [catalogues, setCatalogues] = useState<Record<string, Item[]>>({}),
    [orders, setOrders] = useState<Order[]>([]),
    [ready, setReady] = useState(false),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [owners, setOwners] = useState<Record<string, string>>({}),
    [names, setNames] = useState<Record<string, string>>({}),
    [prices, setPrices] = useState<Record<string, string>>({});
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    void Promise.all([
      Promise.all(businesses.map(async (b) => [b.id, (await api.catalogue(b.id)).items] as const)),
      api.myOrders(),
      businesses.length ? api.commerceCapabilities() : Promise.resolve({ orderPayments: false }),
    ])
      .then(([items, history, cap]) => {
        if (active) {
          setCatalogues(Object.fromEntries(items));
          setOrders(history.orders);
          setReady(cap.orderPayments);
        }
      })
      .catch(() => {
        if (active) setError("Shops could not refresh. Reopen Business to retry.");
      });
    return () => {
      active = false;
    };
  }, [businesses.map((b) => b.id).join(","), revision]);
  async function run(action: () => Promise<unknown>) {
    if (lock.current || !online) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      setRevision((v) => v + 1);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That shop action could not be confirmed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function pay(order: Order) {
    if (!send) throw Error("Connect your wallet in the Wallet app first.");
    const key = `quizcity.order-proof:${order.id}`;
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(key);
    } catch {
      /* optional recovery cache */
    }
    const hash =
      order.tx_hash ??
      saved ??
      (await send("pay_order", {
        business_id: Number(order.business_id),
        amount: order.total,
        reference: order.reference,
      }));
    try {
      sessionStorage.setItem(key, hash);
    } catch {
      /* server also retains submitted hashes */
    }
    await api.confirmOrder(order.id, hash);
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* optional */
    }
  }

  const disabled = busy || !online;
  return (
    <div className="phone-shops">
      {busy ? <LoadingStatus>Processing your shop request…</LoadingStatus> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!businesses.length ? (
        <p>No businesses are registered yet. Your next chapter could start with a plot.</p>
      ) : null}
      {businesses.map((b) => (
        <article className="city-list-item" key={b.id}>
          <span className="city-eyebrow">
            {b.owner_account === accountId ? "YOUR BUSINESS" : "NEIGHBOURHOOD SHOP"}
          </span>
          <h3>{b.name}</h3>
          <p>Gross sales · {money(b.revenue_total)} QC</p>
          {(catalogues[b.id] ?? []).length === 0 ? <p>The shelves are being prepared.</p> : null}
          {(catalogues[b.id] ?? []).map((item) => (
            <div className="shop-item" key={item.id}>
              <strong>{item.name}</strong>
              <p>
                {money(item.unit_price)} QC · {item.on_hand - item.reserved} available
                {item.on_hand - item.reserved <= item.low_stock ? " · Low stock" : ""}
              </p>
              {b.owner_account !== accountId ? (
                <button
                  disabled={disabled || !ready || item.on_hand <= item.reserved}
                  onClick={() => void run(() => api.reserveOrder(item.id, 1))}
                >
                  Reserve one · {money(item.unit_price)} QC
                </button>
              ) : (
                <div className="phone-form">
                  <label>
                    New price in QC
                    <input
                      aria-label={`Price for ${item.name}`}
                      inputMode="numeric"
                      pattern="[1-9][0-9]*"
                      value={prices[item.id] ?? item.unit_price}
                      onChange={(e) => setPrices({ ...prices, [item.id]: e.target.value })}
                    />
                  </label>
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void run(() => api.itemSettings(item.id, prices[item.id] ?? item.unit_price, true))
                    }
                  >
                    Save price
                  </button>
                  <p>Restock through Business → Supplies. Delivery arrives after confirmed payment.</p>
                </div>
              )}
            </div>
          ))}
          {b.owner_account === accountId ? (
            <>
              <form
                className="phone-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void run(() =>
                    api.createItem(b.id, {
                      sku: String(data.get("sku")),
                      name: String(data.get("name")),
                      unitPrice: String(data.get("price")),
                      quantity: Number(data.get("quantity")),
                    }),
                  );
                }}
              >
                <h4>Add an item</h4>
                <label>
                  Item name
                  <input name="name" required maxLength={60} />
                </label>
                <label>
                  Stock code
                  <input name="sku" required pattern="[a-z0-9_-]{3,40}" placeholder="coffee-small" />
                </label>
                <label>
                  Price in QC
                  <input name="price" required inputMode="numeric" pattern="[1-9][0-9]*" />
                </label>
                <label>
                  Starter stock (10 units per business in total)
                  <input name="quantity" type="number" min="0" max="10" defaultValue="0" required />
                </label>
                <button disabled={disabled}>Stock my shelves</button>
              </form>
              <form
                className="phone-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const amount = names[b.id] ?? "";
                  void run(async () => {
                    if (!send) throw Error("Connect your wallet first.");
                    const hash = await send("business_withdraw", { business_id: Number(b.id), amount });
                    await api.withdrawBusiness(b.id, amount, hash);
                  });
                }}
              >
                <h4>Move funds to your wallet</h4>
                <label>
                  QC to withdraw
                  <input
                    inputMode="numeric"
                    required
                    pattern="[1-9][0-9]*"
                    value={names[b.id] ?? ""}
                    onChange={(e) => setNames({ ...names, [b.id]: e.target.value })}
                  />
                </label>
                <button disabled={disabled}>Withdraw QC</button>
              </form>
              <form
                className="phone-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const newOwner = owners[b.id]?.trim();
                  if (!newOwner) return;
                  void run(async () => {
                    if (!send) throw Error("Connect your wallet first.");
                    const hash = await send("transfer_business", {
                      business_id: Number(b.id),
                      new_owner: newOwner,
                    });
                    await api.transferBusiness(b.id, newOwner, hash);
                  });
                }}
              >
                <h4>Transfer this business</h4>
                <p>The business changes hands. The property remains yours.</p>
                <label>
                  New owner’s NEAR account
                  <input
                    required
                    value={owners[b.id] ?? ""}
                    maxLength={64}
                    onChange={(e) => setOwners({ ...owners, [b.id]: e.target.value })}
                  />
                </label>
                <button disabled={disabled || owners[b.id]?.trim() === accountId}>Transfer ownership</button>
              </form>
            </>
          ) : null}
        </article>
      ))}
      {businesses.length && !ready ? (
        <p className="shop-status">The shops are getting ready for checkout. Your QC has not been charged.</p>
      ) : null}
      {orders.length ? (
        <section aria-label="My orders">
          <h3>My orders</h3>
          {orders.map((order) => (
            <article className="city-list-item" key={order.id}>
              <strong>
                {order.quantity} × {order.item_name}
              </strong>
              <p>
                {money(order.total)} QC ·{" "}
                {order.status === "paid"
                  ? "Purchase confirmed"
                  : order.status === "refunded"
                    ? "Refund confirmed"
                    : order.status === "cancelled"
                      ? "Cancelled"
                      : order.status === "confirming"
                        ? "Awaiting payment confirmation"
                        : "Reserved for you"}
              </p>
              {["reserved", "confirming"].includes(order.status) ? (
                <button disabled={disabled || !ready} onClick={() => void run(() => pay(order))}>
                  {order.tx_hash ? "Check payment confirmation" : `Pay ${money(order.total)} QC`}
                </button>
              ) : (
                <p>Your purchase is saved. The shop’s stock and revenue reflect this confirmed payment.</p>
              )}
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}
