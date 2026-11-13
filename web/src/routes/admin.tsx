import { App } from "../App";
import { RequireRole } from "../app/RequireRole";

export function Component() {
  return (
    <RequireRole role="operator">
      <App mode="admin" />
    </RequireRole>
  );
}
