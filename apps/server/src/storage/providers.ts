import { z } from "zod";
import { AppError } from "../lib/errors.js";

type Field = {
  /** The name of the rclone option this fills in. */
  key: string;
  label: string;
  kind?: "text" | "number" | "secret" | "boolean" | "select";
  required?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
};

export type Provider = {
  type: string;
  label: string;
  fields: Field[];
  /** What the path inside the remote means, and whether a location cannot do without one. */
  path: { label: string; placeholder: string; required: boolean };
};

/**
 * The kinds of remote a location can be. Only the options listed here ever reach rclone:
 * some of its other options run commands or read files of the server's own.
 */
export const providers: Provider[] = [
  {
    type: "smb",
    label: "SMB",
    fields: [
      { key: "host", label: "Server", required: true, placeholder: "nas.local" },
      { key: "port", label: "Port", kind: "number", placeholder: "445" },
      { key: "user", label: "Username" },
      { key: "pass", label: "Password", kind: "secret" },
      { key: "domain", label: "Domain", placeholder: "WORKGROUP" }
    ],
    path: { label: "Share and folder", placeholder: "share/folder", required: true }
  },
  {
    type: "sftp",
    label: "SFTP",
    fields: [
      { key: "host", label: "Server", required: true, placeholder: "example.com" },
      { key: "port", label: "Port", kind: "number", placeholder: "22" },
      { key: "user", label: "Username", required: true },
      { key: "pass", label: "Password", kind: "secret" },
      { key: "key_file", label: "Sign in with Kago's SSH key", kind: "boolean" }
    ],
    path: { label: "Folder", placeholder: "/home/user/files", required: false }
  },
  {
    type: "webdav",
    label: "WebDAV",
    fields: [
      { key: "url", label: "Address", required: true, placeholder: "https://example.com/dav" },
      {
        key: "vendor",
        label: "Server software",
        kind: "select",
        options: [
          { value: "other", label: "Other" },
          { value: "nextcloud", label: "Nextcloud" },
          { value: "owncloud", label: "ownCloud" },
          { value: "sharepoint", label: "SharePoint" }
        ]
      },
      { key: "user", label: "Username" },
      { key: "pass", label: "Password", kind: "secret" }
    ],
    path: { label: "Folder", placeholder: "folder", required: false }
  },
  {
    type: "ftp",
    label: "FTP",
    fields: [
      { key: "host", label: "Server", required: true, placeholder: "example.com" },
      { key: "port", label: "Port", kind: "number", placeholder: "21" },
      { key: "user", label: "Username" },
      { key: "pass", label: "Password", kind: "secret" },
      { key: "explicit_tls", label: "Use TLS", kind: "boolean" }
    ],
    path: { label: "Folder", placeholder: "folder", required: false }
  }
];

export type RemoteConfig = { type: string; base: string; params: Record<string, string> };

export const remoteConfigSchema = z.object({
  type: z.string().min(1),
  base: z.string().max(1024).default(""),
  params: z.record(z.union([z.string().max(4096), z.boolean(), z.number()])).default({})
});

export function providerOf(type: string): Provider {
  const provider = providers.find((item) => item.type === type);
  if (!provider) throw new AppError(400, "Unknown kind of location", "UNKNOWN_PROVIDER");
  return provider;
}

/**
 * Checks what was typed against the provider and returns it as it is stored.
 * A secret left empty keeps the one in `previous`, so a form can be saved without typing passwords again.
 */
export function normalizeRemoteConfig(input: z.infer<typeof remoteConfigSchema>, previous?: RemoteConfig): RemoteConfig {
  const provider = providerOf(input.type);
  const params: Record<string, string> = {};
  for (const field of provider.fields) {
    const raw = input.params[field.key];
    let value = typeof raw === "boolean" ? (raw ? "true" : "") : raw === undefined ? "" : String(raw).trim();
    if (field.kind === "secret" && !value && previous?.type === input.type) value = previous.params[field.key] ?? "";
    if (field.kind === "number" && value && !/^\d{1,5}$/.test(value)) throw new AppError(400, "Invalid port", "INVALID_INPUT");
    if (field.kind === "select" && value && !field.options?.some((option) => option.value === value)) throw new AppError(400, "Invalid input", "INVALID_INPUT");
    if (/[\r\n\0]/.test(value)) throw new AppError(400, "Invalid input", "INVALID_INPUT");
    if (field.required && !value) throw new AppError(400, "A required field is empty", "REMOTE_FIELD_REQUIRED");
    if (value) params[field.key] = value;
  }
  const segments = input.base.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || /[\r\n\0]/.test(segment))) throw new AppError(400, "Invalid path", "INVALID_PATH");
  if (provider.path.required && segments.length === 0) throw new AppError(400, "A required field is empty", "REMOTE_FIELD_REQUIRED");
  // An absolute path on an SFTP server keeps its leading slash; everywhere else the path is relative to the remote's root.
  const absolute = input.type === "sftp" && input.base.trim().startsWith("/");
  return { type: input.type, base: `${absolute ? "/" : ""}${segments.join("/")}`, params };
}

/** A stored configuration as the administrator may see it again: every secret replaced by whether one is set. */
export function publicRemoteConfig(config: RemoteConfig) {
  const provider = providerOf(config.type);
  const secrets = new Set(provider.fields.filter((field) => field.kind === "secret").map((field) => field.key));
  return {
    type: config.type,
    base: config.base,
    params: Object.fromEntries(Object.entries(config.params).filter(([key]) => !secrets.has(key))),
    secrets: [...secrets].filter((key) => Boolean(config.params[key]))
  };
}
