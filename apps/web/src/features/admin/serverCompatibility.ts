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

export type ServerDeviceSummary = {
  key: string;
  name: string;
  /** The kind of acceleration, where the device has a name of its own to go by. */
  backend: string | null;
  hardware: boolean;
  /** Each result under `"<codec> <operation>"`. */
  checks: Map<string, ServerCompatibilityCheck>;
  /** The tests that ran and failed. */
  problems: ServerCompatibilityCheck[];
};

/**
 * The report as the page tells it: the devices that were put to the test, graphics hardware ahead of the CPU, and
 * apart from them the kinds of acceleration the server simply does not have, which are named rather than tabulated.
 */
export function summarizeServerChecks(checks: ServerCompatibilityCheck[]) {
  const devices: ServerDeviceSummary[] = [];
  const missing: string[] = [];
  for (const { key, device, checks: results } of groupServerChecks(checks)) {
    if (results.every((check) => check.status === "unsupported" || check.status === "unavailable")) {
      if (!missing.includes(device.backend)) missing.push(device.backend);
      continue;
    }
    devices.push({
      key,
      name: device.deviceLabel ?? device.backend,
      backend: device.deviceLabel ? device.backend : null,
      hardware: device.hardware,
      checks: new Map(results.map((check) => [check.codec + " " + check.operation, check])),
      problems: results.filter((check) => check.status === "failed")
    });
  }
  devices.sort((a, b) => Number(b.hardware) - Number(a.hardware));
  const encodes = (device: ServerDeviceSummary) => [...device.checks.values()].some((check) => check.operation === "encode" && check.status === "passed");
  return {
    codecs: [...new Set(checks.map((check) => check.codec))],
    devices,
    missing,
    /** The graphics devices that can take transcoding off the CPU. */
    hardware: devices.filter((device) => device.hardware && encodes(device)).map((device) => device.name),
    software: devices.some((device) => !device.hardware && encodes(device))
  };
}
