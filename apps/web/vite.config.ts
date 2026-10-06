import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  // Pre-bundle the Base UI entry points up front; discovering them lazily makes the dev
  // server re-optimise mid-session and briefly load two copies of React.
  optimizeDeps: {
    include: ["@base-ui/react/context-menu", "@base-ui/react/dialog", "@base-ui/react/popover", "@base-ui/react/tooltip"]
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "^/s/": "http://localhost:8080",
      "/ws": {
        target: "ws://localhost:8080",
        ws: true
      }
    }
  }
});
