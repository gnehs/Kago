import type { RunFailureCode } from "@kago/contract";
import { AppError, fileSystemRefusal, noPermission, noSpace } from "./errors.js";

export type Failure = { code: RunFailureCode; detail: string | null };

const DETAIL_LIMIT = 200;

/** What a kind of failure is called when a task ends with it, for the ones that are not a refusal of the disk's or an AppError already. */
const KINDS: Record<RunFailureCode, { statusCode: number; message: string; code: string }> = {
  unreadable: { statusCode: 422, message: "This file can’t be read as media", code: "MEDIA_UNREADABLE" },
  unsupported: { statusCode: 422, message: "This file’s codec or format can’t be converted here", code: "CONVERT_UNSUPPORTED" },
  no_space: { statusCode: noSpace.statusCode, message: noSpace.error, code: noSpace.code },
  permission: { statusCode: noPermission.statusCode, message: noPermission.error, code: noPermission.code },
  exists: { statusCode: 409, message: "Target already exists", code: "TARGET_EXISTS" },
  not_found: { statusCode: 404, message: "Path not found", code: "PATH_NOT_FOUND" },
  unreachable: { statusCode: 502, message: "The remote location could not be reached", code: "REMOTE_FAILED" },
  misconfigured: { statusCode: 400, message: "This task’s settings are not valid", code: "TASK_MISCONFIGURED" },
  changed: { statusCode: 409, message: "The file changed while it was converted", code: "CONVERT_SOURCE_CHANGED" },
  busy: { statusCode: 409, message: "This file is still being copied or moved by another task", code: "CONVERT_SOURCE_BUSY" },
  timeout: { statusCode: 422, message: "Reading this file took too long", code: "MEDIA_TIMEOUT" },
  encoder_missing: { statusCode: 501, message: "This server’s ffmpeg can’t make the chosen format", code: "CONVERT_ENCODER_MISSING" },
  unknown: { statusCode: 422, message: "This file couldn’t be converted", code: "CONVERT_FAILED" }
};

/** An error that knows what kind of failure it is, and a line more about it that is safe to show. */
export class RunFailure extends AppError {
  readonly detail: string | null;

  constructor(
    readonly kind: RunFailureCode,
    detail: string | null,
    override: Partial<{ statusCode: number; message: string; code: string }> = {}
  ) {
    const { statusCode, message, code } = { ...KINDS[kind], ...override };
    super(statusCode, message, code);
    this.detail = detail;
  }
}

/** What each AppError code that can end a run says about the kind of failure it was. */
const BY_CODE: Record<string, RunFailureCode> = {
  MEDIA_UNREADABLE: "unreadable",
  MEDIA_TIMEOUT: "timeout",
  CONVERT_UNSUPPORTED: "unsupported",
  CONVERT_NO_AUDIO: "unsupported",
  CONVERT_NO_VIDEO: "unsupported",
  CONVERT_COPY_UNSUPPORTED: "unsupported",
  CONVERT_CODEC_UNSUPPORTED: "unsupported",
  CONVERT_ENCODER_MISSING: "encoder_missing",
  FFMPEG_MISSING: "encoder_missing",
  FS_NO_SPACE: "no_space",
  FS_FILE_TOO_LARGE: "no_space",
  TRANSFER_NO_SPACE: "no_space",
  FS_PERMISSION_DENIED: "permission",
  FS_READ_ONLY: "permission",
  FORBIDDEN: "permission",
  SYMLINK_FORBIDDEN: "permission",
  PATH_ESCAPES_ROOT: "permission",
  REMOTE_PERMISSION_DENIED: "permission",
  TRANSFER_PERMISSION_DENIED: "permission",
  REMOTE_SHARES_FIXED: "permission",
  TARGET_EXISTS: "exists",
  PATH_NOT_FOUND: "not_found",
  REMOTE_FAILED: "unreachable",
  REMOTE_UNAVAILABLE: "unreachable",
  CONVERT_SOURCE_CHANGED: "changed",
  CONVERT_SOURCE_BUSY: "busy",
  CONVERT_OVERLAP: "misconfigured",
  SYNC_OVERLAP: "misconfigured",
  INVALID_SYNC_TASK: "misconfigured",
  TASK_MISCONFIGURED: "misconfigured",
  NOT_FOLDER: "misconfigured",
  NOT_FILE: "misconfigured",
  INVALID_PATH: "misconfigured"
};

/** Which kind of failure an error is and what to show of it. Anything unrecognised is "unknown" with no detail: the raw message is for the log. */
export function failureOf(error: unknown): Failure {
  if (error instanceof RunFailure) return { code: error.kind, detail: error.detail };
  const known = error instanceof AppError ? error : fileSystemRefusal(error);
  if (known) return { code: BY_CODE[known.code] ?? "unknown", detail: trimDetail(known.message) };
  if (error instanceof Error && error.name === "ZodError") return { code: "misconfigured", detail: null };
  if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) return { code: "unknown", detail: String(error.code) };
  return { code: "unknown", detail: null };
}

/** The kind of failure ffmpeg's own words say it was, or null when they say nothing that tells. */
export function classifyFfmpeg(complaint: string): RunFailureCode | null {
  if (/no space left on device|disk quota exceeded/i.test(complaint)) return "no_space";
  if (/permission denied|operation not permitted|read-only file system/i.test(complaint)) return "permission";
  if (/file exists|already exists/i.test(complaint)) return "exists";
  if (/unknown encoder|encoder \S+ not found|unrecognized option|no such filter|not compiled in|device creation failed|no va display|failed to initiali[sz]e vaapi|could not open encoder|failed to open codec|cannot load libcuda/i.test(complaint)) return "encoder_missing";
  if (/decoder \(codec .*\) not found|unknown decoder|unsupported codec|codec not currently supported|could not find tag for codec|not (?:on|in) (?:the )?whitelist|whitelist|(?:audio|subtitle|video) codec .* not supported/i.test(complaint)) return "unsupported";
  if (/invalid data found|moov atom not found|truncated|end of file|invalid nal|non-existing pps|error while decoding|could not find codec parameters|header missing|corrupt|failed to read frame/i.test(complaint)) return "unreadable";
  return null;
}

/** Lines of ffmpeg's report that are about the build or the file's description, never about what went wrong. */
const BOILERPLATE = /^(?:ffmpeg|ffprobe) version|^built with|^configuration:|^lib\w+\s+\d|^Input #|^Output #|^Stream mapping|^Metadata:|^Stream #|^Press \[q\]|^Duration:|^frame=|^size=|^video:|^\[out#|^\[(?:aist|vist)#|^Conversion failed!|^Last message repeated|^Error opening output files?:?$/;

/** The last line of ffmpeg's report that says something, as `trimDetail` leaves it. */
export function ffmpegDetail(complaint: string): string | null {
  const lines = complaint.split(/\r?\n/).filter((line) => line.trim() !== "" && !/^\s{2,}/.test(line) && !BOILERPLATE.test(line.trim()));
  return trimDetail(lines.at(-1) ?? "");
}

/**
 * A line of someone's tool output as it may be shown: no path (the file's, a temporary one, the server's), URL, address
 * or host name, no bracketed library prefix with its memory address, one line, short. Null when nothing is left.
 */
export function trimDetail(text: string): string | null {
  const scrubbed = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'")]+/gi, "<url>")
    .replace(/(?<![\w.])(?:~|\.{1,2}|[A-Za-z]:|:[\w-]+:)?(?:[\\/][^\s'"():;,]+)+/g, "<path>")
    .replace(/[\w.-]+:<path>/g, "<path>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<address>")
    .replace(/\blookup \S+/gi, "lookup <host>")
    .replace(/\b0x[0-9a-f]+\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  // "<path>: Invalid data found" is the reason with the file in front of it. A name with spaces in it is cut at the
  // first, so what is left of it up to the colon goes too: it is the file's name, and differs from file to file.
  const reason = scrubbed.replace(/^.*<(?:path|url)>[^:<]*:\s*/, "").replace(/^(?:<path>|<url>|<address>)\s*$/, "");
  const line = (reason || scrubbed.replace(/<path>|<url>/g, "").trim()).trim();
  if (!line || /^[\W_]*$/.test(line)) return null;
  return line.length > DETAIL_LIMIT ? `${line.slice(0, DETAIL_LIMIT - 1)}…` : line;
}

/** The kind of failure rclone's words say a transfer was, or null when they say nothing that tells. */
export function classifyRclone(reason: string): RunFailureCode | null {
  if (/no space left|quota exceeded|disk quota|insufficient storage|storage full|not enough space/i.test(reason)) return "no_space";
  if (/permission denied|access[ _]denied|access is denied|operation not permitted|authentication failed|login failed|unauthori[sz]ed|invalid credentials|invalid password|\b40[13]\b/i.test(reason)) return "permission";
  if (/directory not found|object not found|no such file|doesn.t exist|does not exist|not found/i.test(reason)) return "not_found";
  if (/connection refused|connection reset|no such host|i\/o timeout|dial tcp|network is unreachable|couldn.t connect|tls handshake|timed out|timeout|unexpected eof|broken pipe/i.test(reason)) return "unreachable";
  return null;
}
