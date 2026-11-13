import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import { appReducer, type StateAction } from "./reducer";
import { initialAppState, type AppState } from "./entities";

const StateContext = createContext<{ state: AppState; dispatch: (action: StateAction) => void } | null>(null);

export function StateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StateContext.Provider value={value}>{children}</StateContext.Provider>;
}

export function useAppState() {
  const value = useContext(StateContext);
  if (!value) throw new Error("useAppState must be used inside StateProvider");
  return value;
}
