import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const libassDir = path.dirname(createRequire(import.meta.url).resolve("@jellyfin/libass-wasm"));
const libassFiles: Record<string, string> = {
  "subtitles-octopus-worker.js": "text/javascript",
  "subtitles-octopus-worker.wasm": "application/wasm",
  "default.woff2": "font/woff2"
};

/**
 * The subtitle renderer's worker loads its .wasm from next to itself by name, so the files
 * are served untouched under /libass/ rather than going through the hashed asset pipeline.
 */
function libassAssets(): Plugin {
  return {
    name: "kago-libass-assets",
    configureServer(server) {
      server.middlewares.use("/libass", (request, response, next) => {
        const name = (request.url ?? "").split("?")[0]!.slice(1);
        if (!libassFiles[name]) return next();
        response.setHeader("Content-Type", libassFiles[name]);
        fs.createReadStream(path.join(libassDir, name)).pipe(response);
      });
    },
    generateBundle() {
      for (const name of Object.keys(libassFiles)) this.emitFile({ type: "asset", fileName: `libass/${name}`, source: fs.readFileSync(path.join(libassDir, name)) });
    }
  };
}

const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const pdfjsFolders = ["cmaps", "standard_fonts", "wasm", "iccs"];
const pdfjsTypes: Record<string, string> = { ".wasm": "application/wasm", ".js": "text/javascript" };

/**
 * pdf.js fetches character maps, fallback fonts and image decoders by name from a base URL,
 * so those folders are served as they are under /pdfjs/, like the subtitle renderer's files.
 */
function pdfjsAssets(): Plugin {
  return {
    name: "kago-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (request, response, next) => {
        const [folder, name, ...rest] = (request.url ?? "").split("?")[0]!.slice(1).split("/");
        const file = path.join(pdfjsDir, folder ?? "", name ?? "");
        if (rest.length > 0 || !pdfjsFolders.includes(folder ?? "") || !/^[\w.-]+$/.test(name ?? "") || !fs.existsSync(file)) return next();
        response.setHeader("Content-Type", pdfjsTypes[path.extname(file)] ?? "application/octet-stream");
        fs.createReadStream(file).pipe(response);
      });
    },
    generateBundle() {
      for (const folder of pdfjsFolders) {
        for (const name of fs.readdirSync(path.join(pdfjsDir, folder))) {
          // The script sandbox is for PDFs that run JavaScript, which the viewer never does.
          if (!name.startsWith("LICENSE") && !name.startsWith("quickjs")) this.emitFile({ type: "asset", fileName: `pdfjs/${folder}/${name}`, source: fs.readFileSync(path.join(pdfjsDir, folder, name)) });
        }
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), libassAssets(), pdfjsAssets()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  // Pre-bundle the Base UI entry points up front; discovering them lazily makes the dev
  // server re-optimise mid-session and briefly load two copies of React.
  optimizeDeps: {
    include: ["@jellyfin/libass-wasm", "@base-ui/react/context-menu", "@base-ui/react/dialog", "@base-ui/react/menu", "@base-ui/react/popover", "@base-ui/react/tooltip"]
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
