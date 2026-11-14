import { ManagedWalletSetup } from "../components/ManagedWalletSetup";
import { isBrowserAccount } from "@quiz-city/protocol";
import { useEffect, useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Resident } from "../api";
import { saveSession, loadSession } from "../chain";
import "./landing.css";
import { useWallet } from "../wallet/WalletProvider";
import { ensureAuth } from "../auth";

function CityIllustration() {
  const blocks = [
    [245, 155, 105, 95, "#ffcf82"],
    [455, 210, 115, 110, "#a5b9ec"],
    [650, 285, 90, 85, "#f9b5a7"],
    [345, 350, 90, 75, "#a9d7c3"],
  ] as const;
  return (
    <svg
      viewBox="0 0 900 660"
      role="img"
      aria-label="An illustrated city with colourful buildings, gardens and paths"
      className="landing-city"
    >
      <defs>
        <linearGradient id="island" x2="0" y2="1">
          <stop stopColor="#a4d59c" />
          <stop offset="1" stopColor="#6ca98b" />
        </linearGradient>
      </defs>
      <ellipse cx="460" cy="560" rx="340" ry="48" fill="#244c5514" />
      <path d="M55 330 460 115 865 330 460 555Z" fill="#558a75" />
      <path d="M55 307 460 92 865 307 460 532Z" fill="url(#island)" />
      <path
        d="m100 306 360-190 355 191-40 21-315-168-320 168ZM315 390l355-190 32 18-355 190Z"
        fill="#f7e9bf"
      />
      <path d="m215 365 360-190 35 19-360 190ZM440 500l-32-17 355-190 34 18Z" fill="#e6d3aa" />
      {blocks.map(([x, y, w, h, color], i) => (
        <g key={x}>
          <path d={`M${x} ${y}l${w} -${w / 2} ${w} ${w / 2}-${w} ${w / 2}Z`} fill="#fdf4da" />
          <path d={`M${x} ${y}v${h}l${w} ${w / 2}v-${h}Z`} fill={color} />
          <path
            d={`M${x + w} ${y + w / 2}l${w}-${w / 2}v${h}l-${w} ${w / 2}Z`}
            fill={i % 2 ? "#7897a6" : "#cd9470"}
          />
          {[0, 1, 2].map((n) => (
            <path key={n} d={`M${x + 16 + n * 28} ${y + 25 + n * 14}v28l15 8v-28Z`} fill="#fff4ca" />
          ))}
          <path d={`M${x + w + 22} ${y + w / 2 + 26}v${h - 26}l24-12v-${h - 26}Z`} fill="#344e61" />
        </g>
      ))}
      {[
        [165, 325],
        [570, 390],
        [690, 365],
        [450, 190],
        [520, 455],
        [265, 270],
        [750, 300],
      ].map(([x, y]) => (
        <g key={x}>
          <ellipse cx={x} cy={y + 20} rx="24" ry="12" fill="#47795c44" />
          <path d={`M${x} ${y + 15}v-30`} stroke="#977052" strokeWidth="7" />
          <ellipse cx={x} cy={y - 25} rx="24" ry="32" fill="#4f936d" />
          <ellipse cx={x - 7} cy={y - 35} rx="16" ry="21" fill="#80bd80" />
        </g>
      ))}
      <g transform="translate(470 345)">
        <ellipse cy="25" rx="15" ry="7" fill="#244d4c33" />
        <path d="M-6 15v14m12-14v14" stroke="#334b6c" strokeWidth="6" />
        <rect x="-10" y="-6" width="20" height="25" rx="7" fill="#efab71" />
        <circle cy="-13" r="10" fill="#b67c56" />
        <path d="m0-58 10 17-10 17-10-17Z" fill="#c1f47e" stroke="#fff" strokeWidth="2" />
      </g>
      <g fill="#fff" opacity=".9">
        <ellipse cx="190" cy="115" rx="52" ry="15" />
        <ellipse cx="220" cy="100" rx="30" ry="24" />
        <ellipse cx="720" cy="140" rx="60" ry="16" />
        <ellipse cx="705" cy="125" rx="32" ry="24" />
      </g>
    </svg>
  );
}
export function Component() {
  const navigate = useNavigate();
  const wallet = useWallet();
  const entryRef = useRef<HTMLElement>(null);
  const [profiles, setProfiles] = useState<Resident[]>([]);
  const [entering, setEntering] = useState(false);
  const [pendingProfile, setPendingProfile] = useState<Resident | null>(null);
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [firstName, setFirstName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api
      .profiles()
      .then((r) => setProfiles(r.profiles))
      .catch(() => setError("The city server is taking a break. Try again shortly."));
  }, []);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const entry = entryRef.current;
    entry?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = [...(entry?.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input") ?? [])];
      const first = nodes[0],
        last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === entry)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === entry)) {
        event.preventDefault();
        first?.focus();
      }
    };
    entry?.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = oldOverflow;
      entry?.removeEventListener("keydown", keydown);
      opener?.focus();
    };
  }, [open]);
  async function enter(profile?: Resident) {
    if (entering) return;
    setEntering(true);
    setError(null);
    try {
      const cfg = await api.config();
      if (!profile && cfg.autoTestnetWallets) await api.prepareProfileDevice();
      const result = profile
        ? await api.enterProfile(profile.id)
        : await api.createProfile(username, firstName);
      if (result.profile.walletKind === "embedded" && isBrowserAccount(result.profile.accountId)) {
        setPendingProfile(result.profile);
        setProfiles((await api.profiles()).profiles);
        return;
      }
      saveSession({
        profileId: result.profile.id,
        accountId: result.profile.accountId,
        networkId: cfg.networkId,
        walletId: result.profile.walletKind === "embedded" ? "embedded" : "browser",
        authenticatedAt: new Date().toISOString(),
      });
      navigate("/play");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not enter the city.");
    } finally {
      setEntering(false);
    }
  }
  async function openResident(profile: Resident) {
    const cfg = await api.config();
    saveSession({
      profileId: profile.id,
      accountId: profile.accountId,
      networkId: cfg.networkId,
      walletId:
        profile.walletKind === "embedded" && !isBrowserAccount(profile.accountId) ? "embedded" : "browser",
      authenticatedAt: new Date().toISOString(),
    });
    navigate("/play");
  }
  async function recover() {
    setEntering(true);
    setError(null);
    try {
      const cfg = await api.config();
      const account = await wallet.connect(cfg.networkId, cfg.contractId);
      if (!account) throw new Error("Wallet connection cancelled.");
      await ensureAuth(account.accountId, wallet.signer(account.accountId), true);
      const linked = await api.linkProfileWallet();
      if (linked.profile.walletKind === "embedded" && isBrowserAccount(linked.profile.accountId)) {
        const entered = await api.enterProfile(linked.profile.id);
        setPendingProfile(entered.profile);
        return;
      }
      saveSession({
        profileId: linked.profile.id,
        accountId: account.accountId,
        publicKey: account.publicKey,
        networkId: cfg.networkId,
        walletId: wallet.connector?.id ?? "my-near-wallet",
        authenticatedAt: new Date().toISOString(),
      });
      navigate("/play");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not recover your resident.");
    } finally {
      setEntering(false);
    }
  }
  return (
    <main className="landing">
      <nav className="landing-nav" aria-label="Main">
        <Link to="/" className="landing-logo">
          <span className="city-diamond" /> QUIZ CITY
        </Link>
        <a href="#life">Life in the city</a>
        <button className="game-button" onClick={() => setOpen(true)}>
          Play now <span aria-hidden="true">↗</span>
        </button>
      </nav>
      <section className="landing-hero">
        <div className="landing-copy">
          <span className="landing-kicker">A LITTLE CURIOSITY. A WHOLE NEW LIFE.</span>
          <h1>
            Big ideas.
            <br />
            Little city.
            <br />
            <em>Your story.</em>
          </h1>
          <p>
            Move in. Meet your neighbours. Turn what you know into a life of your own. Welcome to a city built
            on curiosity.
          </p>
          <button className="game-button game-button-primary" onClick={() => setOpen(true)}>
            Let’s play <span aria-hidden="true">▶</span>
          </button>
          <span className="landing-caption">Play in your browser · No download</span>
        </div>
        <div className="landing-world">
          <CityIllustration />
          <span className="landing-sticker">
            YOUR NEXT CHAPTER
            <br />
            <strong>starts right here.</strong>
          </span>
        </div>
      </section>
      <section id="life" className="landing-life">
        <span className="landing-kicker">MAKE YOURSELF AT HOME</span>
        <h2>A small city. So many possibilities.</h2>
        <div className="landing-features">
          <article>
            <span aria-hidden="true">✦</span>
            <h3>Follow your curiosity</h3>
            <p>Visit the library, take a quiz and find your next idea.</p>
          </article>
          <article>
            <span aria-hidden="true">☕</span>
            <h3>Find your people</h3>
            <p>Meet the residents and discover their daily city routines.</p>
          </article>
          <article>
            <span aria-hidden="true">⌂</span>
            <h3>Build your chapter</h3>
            <p>Take on jobs and work toward your own place in the city.</p>
          </article>
        </div>
      </section>
      <footer className="landing-footer">
        <span>QUIZ CITY · KNOWLEDGE, WORK & OWNERSHIP</span>
        <span>A living city, built on NEAR.</span>
      </footer>
      {open ? (
        <div className="entry-shade">
          <section
            ref={entryRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Move into Quiz City"
            className="entry-card"
          >
            <button className="entry-close" aria-label="Close player entry" onClick={() => setOpen(false)}>
              ✕
            </button>
            <span className="city-diamond" />
            <h2>Your city is waiting.</h2>
            {pendingProfile ? (
              <ManagedWalletSetup
                profile={pendingProfile}
                onReady={openResident}
                onExplore={() =>
                  void openResident(pendingProfile).catch(() =>
                    setError("Could not open your saved resident. Try again."),
                  )
                }
              />
            ) : (
              <>
                <p>Choose your resident or start a new story.</p>
                {profiles.length ? (
                  <div className="resident-choices">
                    {profiles.map((p) => (
                      <button disabled={entering} key={p.id} onClick={() => void enter(p)}>
                        <span className="resident-avatar">{p.firstName[0]}</span>
                        <span>
                          <strong>{p.username}</strong>
                          <small>Welcome back, {p.firstName}</small>
                        </span>
                        <span aria-hidden="true">▶</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {!profiles.length && loadSession()?.walletId !== "browser" && loadSession() ? (
                  <Link className="game-button" to="/play">
                    Continue your existing city
                  </Link>
                ) : null}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void enter();
                  }}
                >
                  <h3>{profiles.length ? "Create another resident" : "Make yourself at home"}</h3>
                  <label>
                    First name
                    <input
                      autoComplete="given-name"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      required
                      maxLength={40}
                    />
                  </label>
                  <label>
                    Username
                    <input
                      autoComplete="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                      pattern="[a-zA-Z][a-zA-Z0-9_]{2,23}"
                      minLength={3}
                      maxLength={24}
                    />
                  </label>
                  <small>3–24 letters, numbers or underscores. Start with a letter.</small>
                  <button className="game-button game-button-primary" disabled={entering}>
                    {entering ? "Moving in…" : "Start my story →"}
                  </button>
                </form>
                <button className="game-button" disabled={entering} onClick={() => void recover()}>
                  Recover with wallet
                </button>
                <p className="entry-note">
                  Residents are remembered on this browser. Keep your browser data to keep one-click entry.
                  Download your testnet wallet backup in the phone for recovery on another device.
                </p>
              </>
            )}
            {error ? <p role="alert">{error}</p> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
