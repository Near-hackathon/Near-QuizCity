import { NavLink, Outlet, useLocation } from "react-router-dom";
import { NETWORK } from "../wallet/rpc";

export function AppLayout() {
  const path = useLocation().pathname;
  if (path === "/" || path === "/play" || path.startsWith("/interior/")) return <Outlet />;
  return (
    <div className="shell">
      <nav aria-label="Primary" className="row">
        <NavLink className="link" to="/" end>
          City
        </NavLink>
        <NavLink className="link" to="/manage">
          Manage
        </NavLink>
        <NavLink className="link" to="/admin">
          Admin
        </NavLink>
        <span className="pill" aria-label={`Environment ${NETWORK}`}>
          {NETWORK}
        </span>
      </nav>
      <Outlet />
    </div>
  );
}
