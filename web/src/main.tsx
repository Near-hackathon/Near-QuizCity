import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { AppLayout } from "./app/AppLayout";
import { appRouter } from "./app/router";
import { WalletProvider } from "./wallet/WalletProvider";
import { StateProvider } from "./state/StateProvider";
import "./styles.css";

export { AppLayout };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WalletProvider>
      <StateProvider>
        <RouterProvider router={appRouter} />
      </StateProvider>
    </WalletProvider>
  </React.StrictMode>,
);
