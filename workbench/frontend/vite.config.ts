import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  // ws must be on, or the terminal socket is accepted and then never answered.
  // changeOrigin would rewrite Host and the app would refuse the socket as the wrong place.
  server: { proxy: { "/api": { target: "http://127.0.0.1:8000", ws: true, changeOrigin: false } } },
});
