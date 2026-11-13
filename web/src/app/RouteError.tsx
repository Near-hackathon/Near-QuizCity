import { Link, useRouteError } from "react-router-dom";

export function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "The page could not be loaded.";
  return (
    <section className="card">
      <h1>Something went wrong</h1>
      <p className="error" role="alert">
        {message}
      </p>
      <Link className="link" to="/">
        Return to the city
      </Link>
    </section>
  );
}
