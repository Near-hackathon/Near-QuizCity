import { Link } from "react-router-dom";

export function Component() {
  return (
    <section className="card">
      <h1>Page not found</h1>
      <p className="muted">That city address does not exist.</p>
      <Link className="link" to="/">
        Return to the city
      </Link>
    </section>
  );
}
