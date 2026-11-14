import { LoadingStatus } from "../../components/LoadingStatus";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { CityCommandType } from "@quiz-city/protocol";
type Send = (method: string, args: Record<string, unknown>) => Promise<string>;
const value = (form: FormData, key: string) => String(form.get(key) ?? "");
const number = (form: FormData, key: string) => Number(value(form, key));
const money = (v: unknown) => String(v ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function CityServices({
  accountId,
  send,
  onChanged,
}: {
  accountId: string;
  send?: Send;
  onChanged: () => void;
}) {
  const [data, setData] = useState<any>(null),
    [section, setSection] = useState("Activity"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [moderation, setModeration] = useState<any>(null),
    [health, setHealth] = useState<any>(null),
    [admin, setAdmin] = useState(false),
    [revision, setRevision] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    void Promise.all([api.cityOverview(), api.authMe()])
      .then(([d, me]) => {
        if (active) {
          setData(d);
          setAdmin(me.roles.some((r) => r === "operator" || r === "admin"));
        }
      })
      .catch(() => {
        if (active) setError("City services could not refresh. Reopen Business to try again.");
      });
    return () => {
      active = false;
    };
  }, [accountId, revision]);
  async function run(action: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice("Saved. Confirmed changes are now shown in your phone.");
      setRevision((v) => v + 1);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That action could not be confirmed.");
      setRevision((v) => v + 1);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function pay(op: any) {
    if (op.status === "confirmed") return;
    if (op.kind === "settlement") {
      if (op.tx_hash) await api.cityConfirm(op.id, op.tx_hash);
      else await api.cityExecute(op.id);
      return;
    }
    if (!send) throw Error("Connect your wallet in the Wallet app first.");
    const key = `quizcity.city-proof:${op.id}`;
    let hash = op.tx_hash;
    try {
      hash ??= sessionStorage.getItem(key);
    } catch {
      /* optional */
    }
    if (!hash) hash = await send(op.method, op.args);
    try {
      sessionStorage.setItem(key, hash);
    } catch {
      /* optional */
    }
    await api.cityConfirm(op.id, hash);
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* optional */
    }
  }
  async function command(input: Omit<CityCommandType, "requestId">) {
    const { operation } = await api.cityCommand({ ...input, requestId: crypto.randomUUID() });
    await pay(operation);
  }
  async function market(id: string, method: string, args: Record<string, unknown>) {
    if (!send) throw Error("Connect your wallet first.");
    const hash = await send(method, args);
    await api.marketConfirm(id, method, args, hash);
  }
  const owns = (id: unknown) =>
    data?.shops.find((s: any) => String(s.id) === String(id))?.owner_account === accountId;
  if (!data)
    return (
      <section className="city-services">
        <h3>City services</h3>
        {error ? <p role="alert">{error}</p> : <LoadingStatus>Opening your city services…</LoadingStatus>}
      </section>
    );
  const available = data.policy.available;
  const submit = (event: React.FormEvent<HTMLFormElement>, action: (f: FormData) => Promise<unknown>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(() => action(form));
  };
  return (
    <section className="city-services">
      <h3>Make your next move</h3>
      <nav aria-label="City services">
        {["Activity", "Supplies", "Team", "Property market", "Quiz studio", "City hall"].map((s) => (
          <button key={s} aria-pressed={section === s} onClick={() => setSection(s)}>
            {s}
          </button>
        ))}
      </nav>
      {!available ? (
        <p>
          New city services are awaiting their reviewed economy upgrade. Existing jobs, wallet and property
          controls remain available.
        </p>
      ) : null}
      {busy ? <LoadingStatus>Saving your action and checking payment confirmation…</LoadingStatus> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {section === "Activity" ? (
        <>
          <p>
            Saved payments keep their original prices and references. Rechecking a saved payment never creates
            another purchase.
          </p>
          {data.operations.map((o: any) => (
            <article className="city-list-item" key={o.id}>
              <strong>{o.kind.replace(/_/g, " ")}</strong>
              <p>
                {o.status === "cancelled"
                  ? "Permanently cancelled"
                  : o.status === "confirmed"
                    ? "Confirmed"
                    : o.status === "unknown"
                      ? "Awaiting confirmation"
                      : "Ready for your wallet"}
              </p>
              {o.status !== "confirmed" && o.status !== "cancelled" ? (
                <button disabled={busy || !available} onClick={() => void run(() => pay(o))}>
                  Continue saved payment
                </button>
              ) : null}
              {["awaiting", "unknown"].includes(o.status) &&
              ["pay_charge", "pay_rent", "pay_admission"].includes(o.method) ? (
                <button
                  disabled={busy || !available}
                  onClick={() => void run(() => command({ action: "cancel-payment", targetId: o.id }))}
                >
                  Permanently cancel unpaid quote
                </button>
              ) : null}
              <details>
                <summary>Receipt</summary>
                <code className="phone-receipt">{o.tx_hash ?? "No confirmed transaction yet"}</code>
              </details>
            </article>
          ))}
        </>
      ) : null}
      {section === "Activity" ? (
        <>
          <h4>Venue tickets</h4>
          {data.admissions.map((ticket: any) => (
            <article key={ticket.operation_id} className="city-list-item">
              <strong>{ticket.title}</strong>
              <p>
                {money(ticket.total)} QC ·{" "}
                {ticket.refunded_at
                  ? "Refunded"
                  : ticket.attempt_id
                    ? "Used"
                    : ticket.paid_at
                      ? "Paid admission"
                      : "Awaiting payment"}
              </p>
              {ticket.owner_account === accountId &&
              ticket.paid_at &&
              !ticket.attempt_id &&
              !ticket.refunded_at ? (
                <button
                  disabled={busy || !available}
                  onClick={() =>
                    void run(() => command({ action: "refund-admission", targetId: ticket.operation_id }))
                  }
                >
                  Refund unused ticket
                </button>
              ) : null}
            </article>
          ))}
          <h4>Your orders</h4>
          {data.purchases.map((order: any) => (
            <article key={order.id} className="city-list-item">
              <strong>
                {order.quantity} × {order.item_name}
              </strong>
              <p>
                {money(order.total)} QC · {order.status}
              </p>
              {["reserved", "confirming"].includes(order.status) ? (
                <button
                  disabled={busy || !available}
                  onClick={() => void run(() => command({ action: "cancel-order", targetId: order.id }))}
                >
                  Cancel unpaid order
                </button>
              ) : null}
            </article>
          ))}
          <h4>Your customer sales</h4>
          <p>
            Refunds go only to the original buyer. Returned goods are restocked; any warehouse overflow is
            recorded as discarded goods.
          </p>
          {data.sales.map((order: any) => (
            <article key={order.id} className="city-list-item">
              <strong>{order.item_name}</strong>
              <p>
                {money(order.total)} QC · {order.status} · {order.customer_wallet}
              </p>
              {order.status === "paid" ? (
                <button
                  disabled={busy || !available}
                  onClick={() => void run(() => command({ action: "refund", targetId: order.id }))}
                >
                  Refund original buyer
                </button>
              ) : null}
            </article>
          ))}
        </>
      ) : null}
      {section === "Supplies" ? (
        <>
          <p>
            Supplier quotes start at 2 QC per unit and double below 1,000 available units. Your saved quote
            stays fixed, and shelves update after confirmed payment.
          </p>
          {data.shops
            .filter((shop: any) => owns(shop.id))
            .map((shop: any) => (
              <form
                key={`hours:${shop.id}`}
                onSubmit={(e) =>
                  submit(e, (f) => {
                    const minute = (key: string) =>
                      value(f, key)
                        .split(":")
                        .reduce((sum, v, i) => sum + Number(v) * (i ? 1 : 60), 0);
                    return api.shopHours(String(shop.id), {
                      openMinute: minute("open"),
                      closeMinute: minute("close"),
                      acceptingCustomers: f.get("accepting") === "on",
                    });
                  })
                }
              >
                <strong>{shop.name} · Opening hours</strong>
                <label>
                  Opens
                  <input name="open" type="time" defaultValue="09:00" required />
                </label>
                <label>
                  Closes
                  <input name="close" type="time" defaultValue="21:00" required />
                </label>
                <label>
                  <input
                    name="accepting"
                    type="checkbox"
                    defaultChecked={shop.accepting_customers !== false}
                  />
                  Accept customers
                </label>
                <button disabled={busy}>Save opening hours</button>
              </form>
            ))}
          {data.suppliers.map((s: any) => (
            <p key={s.id}>
              {s.name}: {money(s.unit_price)} QC per unit · {s.on_hand - s.reserved} available
            </p>
          ))}
          <form
            onSubmit={(e) =>
              submit(e, (f) =>
                command({ action: "supplier", targetId: value(f, "item"), quantity: number(f, "quantity") }),
              )
            }
          >
            <label>
              Stock item
              <select name="item">
                {data.items.map((i: any) => (
                  <option key={i.id} value={i.id}>
                    {i.name} · {i.on_hand - i.reserved} available
                    {i.on_hand - i.reserved <= i.low_stock ? " · Low stock" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Units
              <input name="quantity" type="number" min="1" max="1000" defaultValue="10" required />
            </label>
            <button disabled={busy || !available}>Order supplier delivery</button>
          </form>
          <p>
            Low-stock shelves are flagged for restocking. Your saved quote does not change if a supplier
            updates its price.
          </p>
        </>
      ) : null}
      {section === "Team" ? (
        <>
          <p>
            Fund the full wage before posting. Workers submit a deliverable, employers review it, and disputes
            keep the wage reserved.
          </p>
          <form
            onSubmit={(e) =>
              submit(e, (f) =>
                command({
                  action: "job",
                  targetId: value(f, "business"),
                  title: value(f, "title"),
                  description: value(f, "description"),
                  amount: value(f, "wage"),
                  days: number(f, "days"),
                }),
              )
            }
          >
            <label>
              Your business
              <select name="business">
                {data.shops
                  .filter((b: any) => owns(b.id))
                  .map((b: any) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Job title
              <input name="title" required minLength={3} maxLength={100} />
            </label>
            <label>
              Deliverable
              <textarea name="description" required minLength={20} maxLength={2000} />
            </label>
            <label>
              Reserved wage (QC)
              <input name="wage" type="number" min="1" max="10000" required />
            </label>
            <label>
              Deadline in days
              <input name="days" type="number" min="1" max="30" defaultValue="7" />
            </label>
            <button disabled={busy || !available}>Fund and post job</button>
          </form>
          {data.jobs.map((j: any) => (
            <article className="city-list-item" key={j.job_id}>
              <strong>{j.title}</strong>
              <p>
                {money(j.payment)} QC · {j.status ?? "Awaiting funding"} · {j.state}
              </p>
              <p>{j.deliverable}</p>
              {owns(j.business_id) && j.status === "submitted" ? (
                <form
                  onSubmit={(e) =>
                    submit(e, (f) => api.reviewWork(j.job_id, value(f, "decision"), value(f, "note")))
                  }
                >
                  <label>
                    Review
                    <select name="decision">
                      <option value="approve">Approve completed work</option>
                      <option value="revise">Request a revision</option>
                      <option value="dispute">Ask an operator to resolve a dispute</option>
                    </select>
                  </label>
                  <label>
                    Reason
                    <textarea name="note" required minLength={10} maxLength={500} />
                  </label>
                  <button disabled={busy}>Save review</button>
                </form>
              ) : null}
              {j.employee_account === accountId && ["accepted", "submitted"].includes(j.status) ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      api.reviewWork(j.job_id, "dispute", "The worker requests independent review."),
                    )
                  }
                >
                  Request dispute review
                </button>
              ) : null}
            </article>
          ))}
          <p>Accepted paid assignments appear in Jobs. Your active team is listed below.</p>
          {data.staff.map((s: any) => (
            <p key={s.job_id}>
              {s.account_id} · {s.ended_at ? "Assignment finished" : "Working on a funded assignment"}
            </p>
          ))}
        </>
      ) : null}
      {section === "Property market" ? (
        <>
          <p>
            Property title stays on-chain. Leases grant use for the paid term plus a three-day grace period;
            missed rent never deletes a property.
          </p>
          {data.shops
            .filter((shop: any) => owns(shop.id))
            .map((shop: any) => (
              <form
                key={`sale:${shop.id}`}
                onSubmit={(e) =>
                  submit(e, (f) =>
                    market(String(shop.id), "list_business", {
                      business_id: Number(shop.id),
                      price: value(f, "price"),
                    }),
                  )
                }
              >
                <strong>Sell {shop.name}</strong>
                <p>
                  The sale transfers the company and treasury. Property title remains separate. Existing
                  funded wages and prizes remain reserved.
                </p>
                <label>
                  Company price (QC)
                  <input name="price" type="number" min="0" max="1000000" required />
                </label>
                <button disabled={busy || !available}>List company · use 0 to cancel</button>
              </form>
            ))}
          {data.businessSales
            .filter((listing: any) => listing.owner_account !== accountId)
            .map((listing: any) => (
              <article className="city-list-item" key={listing.id}>
                <strong>{listing.name}</strong>
                <p>{money(listing.asking_price)} QC · company and treasury</p>
                <button
                  disabled={busy || !available}
                  onClick={() =>
                    void run(() =>
                      market(listing.asset_id, "buy_business", {
                        business_id: Number(listing.asset_id),
                        expected_owner: listing.owner_account,
                        expected_price: listing.asking_price,
                      }),
                    )
                  }
                >
                  Buy company
                </button>
              </article>
            ))}
          <p>
            Property condition loses 5 points per week. A 10 QC maintenance payment restores condition and
            adds 30 days of utilities. Expired utilities pause new orders; title and treasury are retained.
          </p>
          {data.market.map((p: any) => (
            <article className="city-list-item" key={p.id}>
              <strong>Plot {p.id}</strong>
              <p>{p.for_sale ? `${money(p.price)} QC` : "Not listed"}</p>
              <p>
                Condition: {p.condition ?? 100}% · utilities until{" "}
                {p.utilities_paid_until
                  ? new Date(p.utilities_paid_until).toLocaleDateString()
                  : "first service check"}
              </p>
              {p.owner_wallet === `player:${accountId}` ? (
                <>
                  <form
                    onSubmit={(e) =>
                      submit(e, (f) =>
                        market(String(p.id), "list_property", {
                          property_id: Number(p.id),
                          price: value(f, "price"),
                        }),
                      )
                    }
                  >
                    <label>
                      Sale price (QC)
                      <input name="price" type="number" min="1" max="1000000" required />
                    </label>
                    <button disabled={busy}>List property</button>
                  </form>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        market(String(p.id), "cancel_property_listing", { property_id: Number(p.id) }),
                      )
                    }
                  >
                    Cancel listing
                  </button>
                  <form
                    onSubmit={(e) =>
                      submit(e, async (f) => {
                        if (!send) throw Error("Connect your wallet first.");
                        const rent = value(f, "rent"),
                          periodDays = number(f, "days") as 7 | 30;
                        const txHash = await send("list_lease", {
                          property_id: Number(p.id),
                          rent,
                          period_days: periodDays,
                        });
                        return api.rentOffer(String(p.id), { rent, periodDays, active: true }, txHash);
                      })
                    }
                  >
                    <label>
                      Rent (QC)
                      <input name="rent" type="number" min="1" max="10000" required />
                    </label>
                    <label>
                      Term
                      <select name="days">
                        <option value="7">7 days</option>
                        <option value="30">30 days</option>
                      </select>
                    </label>
                    <button disabled={busy}>Offer lease</button>
                  </form>
                  <button
                    disabled={busy || !available}
                    onClick={() => void run(() => command({ action: "upkeep", targetId: String(p.id) }))}
                  >
                    Maintain + 30 days utilities · 10 QC
                  </button>
                </>
              ) : null}
            </article>
          ))}
          {data.rentOffers
            .filter((o: any) => o.owner_wallet !== `player:${accountId}`)
            .map((o: any) => (
              <article className="city-list-item" key={o.property_id}>
                <strong>Lease plot {o.property_id}</strong>
                <p>
                  {money(o.rent)} QC · {o.period_days} days
                </p>
                <button
                  disabled={busy || !available}
                  onClick={() => void run(() => command({ action: "rent", targetId: String(o.property_id) }))}
                >
                  Pay rent and start lease
                </button>
              </article>
            ))}
          {data.leases
            .filter(
              (lease: any) =>
                lease.tenant_account === accountId &&
                lease.status === "active" &&
                new Date(lease.ends_at) > new Date(),
            )
            .map((lease: any) => (
              <form
                key={`open:${lease.id}`}
                onSubmit={(e) =>
                  submit(e, async (f) => {
                    if (!send) throw Error("Connect your wallet first.");
                    const name = value(f, "name"),
                      hash = await send("create_business", { property_id: Number(lease.property_id), name });
                    return api.createBusiness(String(lease.property_id), name, hash);
                  })
                }
              >
                <strong>Your leased plot {lease.property_id}</strong>
                <button
                  type="button"
                  disabled={busy || !available}
                  onClick={() =>
                    void run(() => command({ action: "upkeep", targetId: String(lease.property_id) }))
                  }
                >
                  Renew plot services · 10 QC
                </button>
                <label>
                  Business name
                  <input name="name" required maxLength={48} />
                </label>
                <button disabled={busy || !available}>Open business · 100 QC permit</button>
              </form>
            ))}
          {data.leases.map((l: any) => (
            <p key={l.id}>
              Plot {l.property_id} · {l.status} ·{" "}
              {l.ends_at ? new Date(l.ends_at).toLocaleDateString() : "Awaiting payment"}
            </p>
          ))}
        </>
      ) : null}
      {section === "Quiz studio" ? (
        <>
          <p>
            Write questions about NEAR Protocol using official NEAR sources, submit them for independent
            review, then fund the prizes. Reviewed versions are frozen.
          </p>
          <QuizEditor
            shops={data.shops.filter((b: any) => owns(b.id))}
            busy={busy}
            onSave={(input) => run(() => api.createQuizDraft(input))}
          />
          {data.drafts.map((d: any) => (
            <article className="city-list-item" key={d.id}>
              <strong>{d.title}</strong>
              <p>
                {d.status} · {d.moderation_note}
              </p>
              {d.status === "draft" ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      api.reviewQuizDraft(d.id, "submit", "The creator requests source and answer review."),
                    )
                  }
                >
                  Submit for review
                </button>
              ) : null}
              {d.status === "approved" ? (
                <form
                  onSubmit={(e) =>
                    submit(e, (f) =>
                      command({ action: "quiz-fund", targetId: d.id, amount: value(f, "funding") }),
                    )
                  }
                >
                  <label>
                    Funded prize pool (QC)
                    <input name="funding" type="number" min={d.reward || 1} max="10000" required />
                  </label>
                  <button disabled={busy || !available}>Fund prizes and publish</button>
                </form>
              ) : null}
            </article>
          ))}
        </>
      ) : null}
      {section === "City hall" ? (
        <>
          <button
            disabled={busy}
            onClick={() => void run(async () => setHealth(await api.cityHealth(admin)))}
          >
            View {admin ? "operator diagnostics" : "public economy"}
          </button>
          {data.shops
            .filter((shop: any) => owns(shop.id))
            .map((shop: any) => (
              <p key={`tax:${shop.id}`}>
                <strong>{shop.name}</strong> · 5 QC levy per 30-day city tax period{" "}
                <button
                  disabled={busy || !available}
                  onClick={() => void run(() => command({ action: "tax", targetId: String(shop.id) }))}
                >
                  Pay this period’s levy
                </button>
              </p>
            ))}
          {health ? (
            <>
              <p>
                Confirmed circulation: {money(health.supply.circulating)} QC · mirror difference{" "}
                {health.supply.difference} QC
              </p>
              <p>
                Wealth distribution: {health.wealth.residents} residents · Gini {health.wealth.gini}
              </p>
              <p>
                Issued: {money(health.supply.issued)} QC · burned: {money(health.supply.burned)} QC
              </p>
              {health.walletGroups.map((group: any) => (
                <p key={group.kind}>
                  {group.kind}: {money(group.balance)} QC across {group.count} wallets
                </p>
              ))}
              <h4>Work and businesses</h4>
              <p>
                {health.propertyUse.occupied} of {health.propertyUse.plots} plots occupied ·{" "}
                {health.propertyUse.active_businesses} active companies ·{" "}
                {health.propertyUse.archived_businesses} archived
              </p>
              {health.jobs.map((job: any) => (
                <p key={job.status}>
                  {job.count} {job.status} jobs · {money(job.value)} QC
                </p>
              ))}
              {health.businesses.map((shop: any) => (
                <article key={shop.id} className="city-list-item">
                  <strong>{shop.name}</strong>
                  <p>
                    {money(shop.gross_revenue)} QC gross sales · {money(shop.expenses)} QC expenses ·{" "}
                    {money(shop.treasury)} QC treasury
                  </p>
                  <p>
                    {shop.customers} customer payments · {shop.employees} active staff ·{" "}
                    {shop.active ? "Operating" : "Archived"}
                  </p>
                </article>
              ))}
              <h4>Stock and prices</h4>
              {health.inventory.map((item: any) => (
                <p key={item.id}>
                  {item.name}: {item.on_hand - item.reserved} available · {item.units_sold_day} sold today ·{" "}
                  {money(item.price)} QC {item.previous_price ? `(was ${money(item.previous_price)} QC)` : ""}
                </p>
              ))}
              <h4>Prize reserves</h4>
              {health.rewardPools.map((pool: any) => (
                <p key={pool.id}>
                  {pool.title}: {money(pool.available)} QC available · {money(pool.reserved)} reserved ·{" "}
                  {money(pool.paid)} paid
                </p>
              ))}
              {health.alerts.map((a: any) => (
                <p key={`${a.code}:${a.entity}`}>{a.message}</p>
              ))}
              {health.budgets.map((b: any) => (
                <p key={b.category}>
                  {b.category}: {money(b.spent)} QC spent · {money(b.committed)} reserved · {money(b.ceiling)}{" "}
                  limit
                </p>
              ))}
              {admin ? (
                <details>
                  <summary>Verified events, failed events, wallets and NPC schedules</summary>
                  <pre className="phone-receipt">
                    {JSON.stringify({ contract: health.contractStats, ...health.diagnostics }, null, 2)}
                  </pre>
                </details>
              ) : null}
            </>
          ) : null}
          {admin ? (
            <>
              <form
                onSubmit={(e) => submit(e, (f) => api.setBudget(value(f, "category"), value(f, "ceiling")))}
              >
                <label>
                  Category
                  <select name="category">
                    {["library", "employment", "quizzes", "maintenance", "suppliers"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Budget ceiling (QC)
                  <input name="ceiling" type="number" min="0" max="1000000" required />
                </label>
                <button disabled={busy}>Set category budget</button>
              </form>
              <form
                onSubmit={(e) =>
                  submit(e, (f) =>
                    command({
                      action: "budget",
                      targetId: "council",
                      category: value(f, "category") as CityCommandType["category"],
                      recipient: value(f, "recipient"),
                      amount: value(f, "amount"),
                      description: value(f, "purpose"),
                    }),
                  )
                }
              >
                <label>
                  Category
                  <select name="category">
                    {["library", "employment", "quizzes", "maintenance", "suppliers"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Recipient wallet
                  <input name="recipient" required />
                </label>
                <label>
                  Amount (QC)
                  <input name="amount" type="number" min="1" max="10000" required />
                </label>
                <label>
                  Public purpose
                  <textarea name="purpose" minLength={20} maxLength={500} required />
                </label>
                <button disabled={busy || !available}>Authorise council payment</button>
              </form>
              <form
                onSubmit={(e) =>
                  submit(e, (f) =>
                    command({
                      action: "public-job",
                      targetId: "council",
                      title: value(f, "title"),
                      description: value(f, "description"),
                      amount: value(f, "amount"),
                      days: 7,
                    }),
                  )
                }
              >
                <strong>Fund a public contract</strong>
                <label>
                  Title
                  <input name="title" minLength={3} maxLength={100} required />
                </label>
                <label>
                  Deliverable
                  <textarea name="description" minLength={20} maxLength={2000} required />
                </label>
                <label>
                  Reserved wage (QC)
                  <input name="amount" type="number" min="1" max="10000" required />
                </label>
                <button disabled={busy || !available}>Fund from the employment budget</button>
              </form>
              <button
                disabled={busy}
                onClick={() => void run(async () => setModeration(await api.cityModeration()))}
              >
                Open review queue
              </button>
              {moderation?.drafts.map((d: any) => (
                <article className="city-list-item" key={d.id}>
                  <strong>{d.title}</strong>
                  <p>{d.author_account}</p>
                  <details>
                    <summary>Sources and answer key</summary>
                    <pre className="phone-receipt">{JSON.stringify(d.questions, null, 2)}</pre>
                  </details>
                  <form
                    onSubmit={(e) =>
                      submit(e, (f) => api.reviewQuizDraft(d.id, value(f, "decision"), value(f, "note")))
                    }
                  >
                    <label>
                      Decision
                      <select name="decision">
                        <option value="approve">Approve</option>
                        <option value="reject">Reject</option>
                        <option value="suspend">Suspend publication</option>
                      </select>
                    </label>
                    <label>
                      Review note
                      <textarea name="note" minLength={10} maxLength={500} required />
                    </label>
                    <button disabled={busy}>Record independent review</button>
                  </form>
                </article>
              ))}
              {moderation?.reports.map((report: any) => (
                <form
                  key={report.id}
                  onSubmit={(e) => submit(e, (f) => api.resolveReport(report.id, value(f, "resolution")))}
                >
                  <strong>Player report</strong>
                  <p>{report.reason}</p>
                  <label>
                    Resolution
                    <textarea name="resolution" minLength={10} maxLength={500} required />
                  </label>
                  <button disabled={busy}>Resolve report</button>
                </form>
              ))}
              {moderation?.drafts
                .filter((d: any) => d.quiz_id && new Date(d.closes_at) < new Date())
                .map((d: any) => (
                  <button
                    key={`close:${d.id}`}
                    disabled={busy || !available}
                    onClick={() =>
                      void run(async () => {
                        const { operation } = await api.closeQuiz(
                          d.quiz_id,
                          "Venue closed; return unused confirmed prize funds.",
                        );
                        await pay(operation);
                      })
                    }
                  >
                    Close {d.title} and return unused prizes
                  </button>
                ))}
              {moderation?.disputes.map((j: any) => (
                <form
                  key={j.job_id}
                  onSubmit={(e) =>
                    submit(e, async (f) => {
                      const result: any = await api.reviewWork(
                        j.job_id,
                        value(f, "decision"),
                        value(f, "note"),
                        true,
                      );
                      if (result.operation) await pay(result.operation);
                    })
                  }
                >
                  <strong>{j.title}</strong>
                  <p>{j.deliverable}</p>
                  <label>
                    Resolve
                    <select name="decision">
                      <option value="approve">Pay verified worker</option>
                      <option value="revise">Request revision</option>
                      <option value="cancel">Refund employer</option>
                    </select>
                  </label>
                  <label>
                    Reason
                    <textarea name="note" minLength={10} maxLength={500} required />
                  </label>
                  <button disabled={busy}>Resolve dispute</button>
                </form>
              ))}
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function QuizEditor({
  shops,
  busy,
  onSave,
}: {
  shops: any[];
  busy: boolean;
  onSave: (input: any) => Promise<void>;
}) {
  const [questions, setQuestions] = useState([{ question: "", options: ["", ""], correct: 0, source: "" }]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void onSave({
          businessId: value(f, "business"),
          title: value(f, "title"),
          questions,
          passScore: number(f, "pass"),
          entryFee: value(f, "fee"),
          reward: value(f, "reward"),
          capacity: number(f, "capacity"),
          opensAt: new Date(value(f, "open")).toISOString(),
          closesAt: new Date(value(f, "close")).toISOString(),
        });
      }}
    >
      <label>
        Your venue
        <select name="business" required>
          {shops.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Quiz title
        <input name="title" required minLength={3} maxLength={100} />
      </label>
      {questions.map((q, i) => (
        <fieldset key={i}>
          <legend>Question {i + 1}</legend>
          <label>
            Question text
            <textarea
              required
              minLength={10}
              maxLength={500}
              value={q.question}
              onChange={(e) =>
                setQuestions((rows) => rows.map((v, n) => (n === i ? { ...v, question: e.target.value } : v)))
              }
            />
          </label>
          {q.options.map((option, n) => (
            <label key={n}>
              Answer {n + 1}
              <input
                required
                maxLength={200}
                value={option}
                onChange={(e) =>
                  setQuestions((rows) =>
                    rows.map((v, j) =>
                      j === i
                        ? { ...v, options: v.options.map((o, k) => (k === n ? e.target.value : o)) }
                        : v,
                    ),
                  )
                }
              />
            </label>
          ))}
          <label>
            Correct answer
            <select
              value={q.correct}
              onChange={(e) =>
                setQuestions((rows) =>
                  rows.map((v, n) => (n === i ? { ...v, correct: Number(e.target.value) } : v)),
                )
              }
            >
              {q.options.map((_, n) => (
                <option key={n} value={n}>
                  Answer {n + 1}
                </option>
              ))}
            </select>
          </label>
          <label>
            Official NEAR source link
            <input
              type="url"
              required
              maxLength={500}
              placeholder="https://docs.near.org/…"
              value={q.source}
              onChange={(e) =>
                setQuestions((rows) => rows.map((v, n) => (n === i ? { ...v, source: e.target.value } : v)))
              }
            />
          </label>
          {q.options.length < 6 ? (
            <button
              type="button"
              onClick={() =>
                setQuestions((rows) =>
                  rows.map((v, n) => (n === i ? { ...v, options: [...v.options, ""] } : v)),
                )
              }
            >
              Add answer option
            </button>
          ) : null}
        </fieldset>
      ))}
      {questions.length < 20 ? (
        <button
          type="button"
          onClick={() =>
            setQuestions((rows) => [...rows, { question: "", options: ["", ""], correct: 0, source: "" }])
          }
        >
          Add question
        </button>
      ) : null}
      <label>
        Pass score
        <input name="pass" type="number" min="1" max={questions.length} defaultValue="1" required />
      </label>
      <label>
        Entry fee (QC)
        <input name="fee" type="number" min="0" max="1000" defaultValue="0" required />
      </label>
      <label>
        Prize per winner (QC)
        <input name="reward" type="number" min="0" max="1000" defaultValue="25" required />
      </label>
      <label>
        Capacity
        <input name="capacity" type="number" min="1" max="100" defaultValue="10" required />
      </label>
      <label>
        Opens
        <input name="open" type="datetime-local" required />
      </label>
      <label>
        Closes
        <input name="close" type="datetime-local" required />
      </label>
      <button disabled={busy || !shops.length}>Save quiz draft</button>
    </form>
  );
}
