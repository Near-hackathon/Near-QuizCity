import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // NEAR's browser crypto stack still reaches `safe-buffer`. Resolve the
  // Node builtin name to the maintained browser polyfill so production does
  // not receive Vite's empty compatibility stub.
  resolve: { alias: { buffer: "buffer/" } },
  server: { port: 5173 },
  build: { manifest: true },
});
