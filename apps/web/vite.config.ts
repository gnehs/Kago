import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";
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
const webRoot = path.resolve(__dirname);
const slashPath = (value: string) => value.replaceAll(path.sep, "/");
const privateServerPathPatterns = ["../server/data", "../server/app-data"].map(
  (directory) => `${slashPath(path.resolve(webRoot, directory))}/**`
);

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

const repoRoot = path.resolve(webRoot, "../..");
const licenseFiles: Record<string, string> = { "LICENSE.txt": "LICENSE", "THIRD-PARTY-NOTICES.txt": "THIRD-PARTY-NOTICES" };

/**
 * Kago's own licence and the notices of what it is distributed with, served under /licenses/ as the
 * text files they are: the About page links to them, and they are there to be read without signing in.
 */
function licenseTexts(): Plugin {
  return {
    name: "kago-license-texts",
    configureServer(server) {
      server.middlewares.use("/licenses", (request, response, next) => {
        const name = (request.url ?? "").split("?")[0]!.slice(1);
        if (!Object.hasOwn(licenseFiles, name)) return next();
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        fs.createReadStream(path.join(repoRoot, licenseFiles[name]!)).pipe(response);
      });
    },
    generateBundle() {
      for (const [name, source] of Object.entries(licenseFiles)) this.emitFile({ type: "asset", fileName: `licenses/${name}`, source: fs.readFileSync(path.join(repoRoot, source)) });
    }
  };
}

/** The commit being built. An image is built without .git, so there it is handed in as KAGO_COMMIT; anywhere else git is asked. */
function buildCommit(): string | null {
  let commit = process.env.KAGO_COMMIT?.trim();
  try {
    commit ||= execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // Neither told nor in a checkout: the About page leaves the commit out.
  }
  return commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null;
}

/** Which build this is, for Settings → About. The dev server builds nothing, so it has no build date. */
function buildInfo(): Plugin {
  return {
    name: "kago-build-info",
    config: (_, { command }) => ({
      define: {
        __KAGO_BUILD__: JSON.stringify({
          version: JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version,
          commit: buildCommit(),
          date: command === "build" ? new Date().toISOString() : null
        })
      }
    })
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), libassAssets(), pdfjsAssets(), licenseTexts(), buildInfo()],
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
    // Bind locally by default; --host or KAGO_VITE_HOST can opt into LAN access.
    host: process.env.KAGO_VITE_HOST ?? "127.0.0.1",
    port: 5173,
    fs: {
      strict: true,
      // Setting allow disables Vite's workspace-root auto-detection. Dependencies remain
      // available through imports from this app, while sibling workspace files stay private.
      allow: [webRoot],
      // Keep Vite's built-in sensitive-file protections and also block server-owned data.
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", ...privateServerPathPatterns]
    },
    proxy: {
      "/api": "http://localhost:8080",
      "^/s/": "http://localhost:8080",
      "/ws": {
        target: "ws://localhost:8080",
        ws: true
      }
    }
  },
  preview: {
    host: process.env.KAGO_VITE_HOST ?? "127.0.0.1"
  }
});
