import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
const mapRoot = fileURLToPath(new URL("../assets/maps/", import.meta.url));

const phaserEntry = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../node_modules/phaser/dist/phaser.esm.min.js",
);

export default defineConfig({
  // Legacy browser dependencies in NEAR expect Node's global alias. Keep native
  // Web Crypto available in both Vite's dependency prebundle and application code.
  define: { global: "globalThis" },
  optimizeDeps: { esbuildOptions: { define: { global: "globalThis" } } },
  plugins: [
    react(),
    {
      name: "quizcity-maps",
      async buildStart() {
        if (this.meta.watchMode) return;
        const { readdir, readFile } = await import("node:fs/promises");
        for (const name of await readdir(mapRoot))
          this.emitFile({
            type: "asset",
            fileName: `game-assets/maps/${name}`,
            source: await readFile(path.join(mapRoot, name)),
          });
      },
      configureServer(server) {
        server.middlewares.use("/game-assets/maps", async (request, response, next) => {
          const name = request.url?.slice(1);
          if (!name || !/^[a-z0-9_-]+\.(tmj|json)$/.test(name)) return next();
          try {
            const { readFile } = await import("node:fs/promises");
            response.setHeader("Content-Type", "application/json");
            response.end(await readFile(path.join(mapRoot, name)));
          } catch {
            next();
          }
        });
      },
    },
  ],
  // NEAR's browser crypto stack still reaches `safe-buffer`. Resolve the
  // Node builtin name to the maintained browser polyfill so production does
  // not receive Vite's empty compatibility stub.
  resolve: { alias: { buffer: "buffer/", phaser: phaserEntry } },
  server: { port: 5173 },
  build: { manifest: true },
});
