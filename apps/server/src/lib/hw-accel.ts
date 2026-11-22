import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RENDER_NODE_DIR = "/dev/dri";

/** `TRANSCODE_HWACCEL`: `auto` where it is unset, otherwise the kind of GPU asked for, or `none` / `software` to do without. */
export function hwAccelPreference(): string {
  return (process.env.TRANSCODE_HWACCEL ?? "auto").toLowerCase();
}

export function softwareOnly(preference: string): boolean {
  return preference === "none" || preference === "software";
}

/** The render nodes in /dev/dri as full paths, in the order the directory lists them. Throws as reading the directory does. */
export async function readRenderNodes(match: RegExp = /^renderD/): Promise<string[]> {
  return (await fsp.readdir(RENDER_NODE_DIR)).filter((name) => match.test(name)).map((name) => path.join(RENDER_NODE_DIR, name));
}

/** The render nodes to try, in order: the one `TRANSCODE_VAAPI_DEVICE` names, or else every one there is, none where the directory is not. */
export async function renderNodes(): Promise<string[]> {
  if (process.env.TRANSCODE_VAAPI_DEVICE) return [process.env.TRANSCODE_VAAPI_DEVICE];
  return (await readRenderNodes().catch(() => [] as string[])).sort();
}

/**
 * Runs a short encode of a test picture on a device, which throws if it cannot. `filter` is the whole `-vf` chain
 * and `encode` what takes the place of the software encoder.
 */
export async function testEncode(ffmpeg: string, input: string[], filter: string, encode: string[]): Promise<void> {
  await execFileAsync(
    ffmpeg,
    ["-nostdin", "-hide_banner", "-loglevel", "error", ...input, "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-frames:v", "30", "-vf", filter, ...encode, "-f", "null", "-"],
    { timeout: 20_000 }
  );
}
