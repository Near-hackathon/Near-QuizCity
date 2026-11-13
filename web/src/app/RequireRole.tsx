import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type AuthMe } from "../api";
import { loadSession } from "../chain";

type State =
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "allowed"; me: AuthMe }
  | { kind: "error"; message: string };

export function RequireRole({ role, children }: { role: string; children: ReactNode }) {
  const session = loadSession();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!session) {
      setState({ kind: "denied" });
      return;
    }
    let cancelled = false;
    api
      .authMe()
      .then((me) => {
        if (cancelled) return;
        setState(
          me.accountId === session.accountId && me.roles.includes(role)
            ? { kind: "allowed", me }
            : { kind: "denied" },
        );
      })
      .catch((error: Error) => {
        if (!cancelled) setState({ kind: "error", message: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, [role, session]);

  if (!session) {
    return (
      <section className="card">
        <h1>Sign in required</h1>
        <Link className="link" to="/">
          Sign in from the city
        </Link>
      </section>
    );
  }
  if (state.kind === "loading") return <p className="muted">Checking permissions...</p>;
  if (state.kind === "error") return <p className="error">{state.message}</p>;
  if (state.kind === "denied") {
    return (
      <section className="card">
        <h1>Not authorized</h1>
        <p className="error" role="alert">
          Your account does not have the {role} role.
        </p>
        <Link className="link" to="/">
          Return to the city
        </Link>
      </section>
    );
  }
  return <>{children}</>;
}
