export type ServerCompatibilityCheck = {
  id: string;
  label: string;
  codec: string;
  operation: "encode" | "decode";
  backend: string;
  hardware: boolean;
  status: "passed" | "failed" | "unsupported" | "unavailable";
  detail: string;
  durationMs: number | null;
  deviceId: string | null;
  deviceLabel: string | null;
  deviceScope: "device" | "system" | "none";
};

export type ServerCompatibilityReport = {
  checkedAt: string;
  ffmpeg: { available: boolean; version: string | null };
  checks: ServerCompatibilityCheck[];
  discoveryNotes?: string[];
};

/** Device identity, rather than a shared model name or backend, keeps results from different GPUs apart. */
export function groupServerChecks(checks: ServerCompatibilityCheck[]) {
  const groups = new Map<string, { key: string; device: ServerCompatibilityCheck; checks: ServerCompatibilityCheck[] }>();
  for (const check of checks) {
    const key = JSON.stringify([check.backend, check.deviceScope, check.deviceId]);
    const group = groups.get(key) ?? { key, device: check, checks: [] };
    group.checks.push(check);
    groups.set(key, group);
  }
  return [...groups.values()];
}
