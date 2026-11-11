import fs from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { logger } from "../lib/logger.js";

/** The one version of the plugin interface this server speaks. A plugin written against another is not loaded. */
export const PLUGIN_API = 1;

/** Where every plugin's files are served from, each under a folder named by its token. */
export const PLUGIN_PREFIX = "/_kago/plugin/";

export type PluginId = string & { readonly __brand: "PluginId" };

/** A file within a plugin's folder, written the way a URL path is: no leading slash, no `..`, no backslashes. */
const relativePath = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.split("/").every((part) => part !== "" && part !== "." && part !== "..") && !/[\\\0]/.test(value), "a path inside the plugin's dist folder");

const previewerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  extensions: z.array(z.string().regex(/^[a-z0-9]{1,16}$/)).min(1).max(32),
  entry: relativePath
});

const manifestSchema = z.object({
  // An npm package name, which is what the plugin is known by.
  name: z.string().regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/).max(214),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
  kago: z.object({
    api: z.literal(PLUGIN_API),
    title: z.string().trim().min(1).max(80),
    previewers: z.array(previewerSchema).max(16).default([])
  })
});

export type PreviewerManifest = z.infer<typeof previewerSchema>;

export type PluginManifest = {
  id: PluginId;
  version: string;
  title: string;
  /** The folder that is served: the plugin's built `dist`. */
  root: string;
  /** Names the plugin's folder in URLs. It changes with every version and every start of the server. */
  token: string;
  previewers: PreviewerManifest[];
};

/** A previewer as the interface is told of it: what it opens, and the page to frame for it. */
export type PluginPreviewer = { pluginId: PluginId; previewerId: string; extensions: string[]; title: string; src: string };

/**
 * The plugins found at start, from the folders given in order: Kago's own first, then those installed beside its
 * data. A folder whose package.json is not a plugin of this version, or that has nothing built to serve, is passed
 * over with the reason in the log; the server never fails to start for one.
 */
export class PluginService {
  private readonly byToken = new Map<string, PluginManifest>();
  /** Which previewer opens each extension. The first plugin to name an extension keeps it. */
  private readonly byExtension = new Map<string, PluginPreviewer>();

  constructor(roots: string[], secret: Buffer = randomBytes(32)) {
    const seen = new Set<PluginId>();
    for (const root of roots) {
      for (const folder of listFolders(root)) {
        const loaded = loadPlugin(path.join(root, folder));
        if (typeof loaded === "string") {
          logger.warn(`plugin in ${path.join(root, folder)} skipped: ${loaded}`);
          continue;
        }
        if (seen.has(loaded.id)) {
          logger.warn(`plugin in ${path.join(root, folder)} skipped: ${loaded.id} is already loaded`);
          continue;
        }
        seen.add(loaded.id);
        const token = createHmac("sha256", secret).update(`${loaded.id}@${loaded.version}`).digest("hex").slice(0, 32);
        const plugin: PluginManifest = { ...loaded, token };
        this.byToken.set(token, plugin);
        for (const previewer of plugin.previewers) {
          const entry: PluginPreviewer = { pluginId: plugin.id, previewerId: previewer.id, extensions: [], title: plugin.title, src: `${PLUGIN_PREFIX}${token}/${previewer.entry}` };
          for (const extension of previewer.extensions) {
            if (this.byExtension.has(extension)) continue;
            this.byExtension.set(extension, entry);
            entry.extensions.push(extension);
          }
        }
      }
    }
  }

  plugins(): PluginManifest[] {
    return [...this.byToken.values()];
  }

  previewers(): PluginPreviewer[] {
    return [...new Set(this.byExtension.values())];
  }

  /**
   * The file a plugin URL names, or null when the token is no plugin's or the path leads anywhere but a file inside
   * that plugin's folder: `..`, an absolute path and a link out of the folder all end here.
   */
  async file(token: string, relative: string): Promise<{ file: string; size: number; mtimeMs: number } | null> {
    const plugin = this.byToken.get(token);
    if (!plugin || !relativePath.safeParse(relative).success) return null;
    try {
      const root = await fs.promises.realpath(plugin.root);
      const file = await fs.promises.realpath(path.resolve(root, relative));
      if (!file.startsWith(root + path.sep)) return null;
      const stat = await fs.promises.stat(file);
      return stat.isFile() ? { file, size: stat.size, mtimeMs: stat.mtimeMs } : null;
    } catch {
      return null;
    }
  }
}

function listFolders(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No such folder: nothing is installed there.
    return [];
  }
}

/** The plugin in `folder`, or why it is not one. */
function loadPlugin(folder: string): Omit<PluginManifest, "token"> | string {
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8"));
  } catch {
    return "no readable package.json";
  }
  const kago = (json as { kago?: { api?: unknown } } | null)?.kago;
  if (!kago) return "package.json has no kago field";
  if (kago.api !== PLUGIN_API) return `it is written for plugin API ${JSON.stringify(kago.api)}, and this server speaks ${PLUGIN_API}`;
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) return `invalid manifest (${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")})`;
  const root = path.join(folder, "dist");
  const missing = parsed.data.kago.previewers.find((previewer) => !fs.existsSync(path.join(root, previewer.entry)));
  if (missing) return `dist/${missing.entry} is not built`;
  return { id: parsed.data.name as PluginId, version: parsed.data.version, title: parsed.data.kago.title, root, previewers: parsed.data.kago.previewers };
}

/** A host as a CSP source may name it: a name or address and maybe a port, nothing else. */
const HOST = /^[\w.\-:[\]]+$/;

/** The host of the page that framed the plugin, as it says in the frame's URL, if that is a plain http(s) origin. */
export function framingHost(origin: unknown): string | null {
  if (typeof origin !== "string") return null;
  try {
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.origin !== origin) return null;
    return HOST.test(url.host) ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * What a plugin's page may do: run its own files and what it makes from blobs, and reach nothing. It has no
 * network but data and blob URLs, so the file it shows comes only through Kago, and Kago's API is out of reach.
 * The page is sandboxed whatever frames it, which gives it an origin of its own that matches nothing, so its own
 * folder is named in full, under both schemes, for the host the request came to and the one the browser used.
 * Behind a proxy that does not pass the Host on, those are not the same.
 */
export function pluginPolicy(token: string, hosts: (string | null | undefined)[]): string {
  const folders = [...new Set(hosts.filter((host): host is string => Boolean(host && HOST.test(host))))].flatMap((host) => [`http://${host}${PLUGIN_PREFIX}${token}/`, `https://${host}${PLUGIN_PREFIX}${token}/`]);
  const own = (...more: string[]) => [...folders, ...more].join(" ");
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${own("'wasm-unsafe-eval'", "blob:")}`,
    `worker-src ${own("blob:")}`,
    `style-src ${own("'unsafe-inline'")}`,
    `img-src ${own("data:", "blob:")}`,
    `font-src ${own("data:")}`,
    "connect-src blob: data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'"
  ].join("; ");
}
