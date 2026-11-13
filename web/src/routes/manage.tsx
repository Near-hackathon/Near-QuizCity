import { App } from "../App";
import { RequireSession } from "../app/RequireSession";

export function Component() {
  return (
    <RequireSession>
      <App mode="manage" />
    </RequireSession>
  );
}
