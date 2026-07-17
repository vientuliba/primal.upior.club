import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  server: { port: 5173, proxy: { "/socket.io": "http://127.0.0.1:3001", "/api": "http://127.0.0.1:3001" } },
});

