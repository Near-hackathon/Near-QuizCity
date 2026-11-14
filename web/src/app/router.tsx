import { createBrowserRouter, createMemoryRouter, type RouteObject } from "react-router-dom";
import { AppLayout } from "./AppLayout";
import { RouteError } from "./RouteError";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppLayout />,
    errorElement: <RouteError />,
    HydrateFallback: () => <p className="muted">Loading city...</p>,
    children: [
      { index: true, lazy: () => import("../routes/landing") },
      {
        lazy: () => import("../game/layout"),
        children: [
          { path: "play", lazy: () => import("../routes/city") },
          { path: "interior/:sceneId", lazy: () => import("../routes/interior") },
        ],
      },
      { path: "manage", lazy: () => import("../routes/manage") },
      { path: "admin", lazy: () => import("../routes/admin") },
      { path: "*", lazy: () => import("../routes/not-found") },
    ],
  },
];

export const appRouter = createBrowserRouter(routes);

export function createTestRouter(initialEntries: string[] = ["/"]) {
  return createMemoryRouter(routes, { initialEntries });
}
