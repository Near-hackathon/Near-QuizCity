import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { loadSession } from "../chain";

export function RequireSession({ children }: { children: ReactNode }) {
  const session = loadSession();
  if (!session) return <Navigate to="/" replace />;
  return <>{children}</>;
}
