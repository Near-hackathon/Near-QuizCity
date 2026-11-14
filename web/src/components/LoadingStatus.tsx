import type { ReactNode } from "react";
import "./LoadingStatus.css";
export function Spinner() {
  return <span className="city-spinner" aria-hidden="true" />;
}
export function LoadingStatus({ children }: { children: ReactNode }) {
  return (
    <span className="city-loading-status" role="status">
      <Spinner />
      {children}
    </span>
  );
}
