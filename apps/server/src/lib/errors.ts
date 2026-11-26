import { logger } from "./logger.js";

export function errnoIs(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "APP_ERROR",
    /** The refusal is in the audit log already, written by whoever refused: the request's own failure would say it twice. */
    public readonly recorded = false
  ) {
    super(message);
  }
}

const multipartLimitErrors: Record<string, { error: string; code: string }> = {
  FST_FILES_LIMIT: { error: "Too many files in one upload", code: "TOO_MANY_UPLOAD_FILES" },
  FST_PARTS_LIMIT: { error: "Too many files in one upload", code: "TOO_MANY_UPLOAD_FILES" }
};

// What the server's own disk refuses is not a fault of Kago's and not for the person to retry: it is for whoever runs the server to put right.
const noPermission = { statusCode: 500, error: "Kago’s system account has no permission for this on the server’s disk. An administrator needs to check PUID / PGID and who owns the folder.", code: "FS_PERMISSION_DENIED" };
// A pool such as Unraid's cache fills up partway through a large file, and a FAT disk takes nothing past 4 GB.
const noSpace = { statusCode: 507, error: "There is not enough free space on the server’s disk for this", code: "FS_NO_SPACE" };
const fileSystemRefusals: Record<string, { statusCode: number; error: string; code: string }> = {
  EACCES: noPermission,
  EPERM: noPermission,
  EROFS: { statusCode: 500, error: "This folder is mounted read-only on the server", code: "FS_READ_ONLY" },
  ENOSPC: noSpace,
  EDQUOT: noSpace,
  EFBIG: { statusCode: 413, error: "The file is larger than the server’s disk can hold in one file", code: "FS_FILE_TOO_LARGE" }
};

/** The account the server runs as, which is the one the disk's own permissions are checked against. */
export function systemAccount(): { uid: number; gid: number } | null {
  return process.getuid && process.getgid ? { uid: process.getuid(), gid: process.getgid() } : null;
}

/** A refusal of the disk's own (ownership, mode bits, a read-only mount, no room left) in words that say so; the path and the account go to the log. */
export function fileSystemRefusal(error: unknown): AppError | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const refusal = fileSystemRefusals[String(error.code)];
  if (!refusal) return null;
  const { syscall, path } = error as NodeJS.ErrnoException;
  logger.warn(`the file system refused ${syscall ?? "an operation"}${path ? ` on ${path}` : ""}`, { code: error.code, ...systemAccount() });
  return new AppError(refusal.statusCode, refusal.error, refusal.code);
}

export function publicError(error: unknown): { statusCode: number; body: { error: string; code: string } } {
  const known = error instanceof AppError ? error : fileSystemRefusal(error);
  if (known) {
    return {
      statusCode: known.statusCode,
      body: { error: known.message, code: known.code }
    };
  }

  // @fastify/multipart reports its limits with its own errors; name them so the user learns which limit was hit.
  const multipart = error instanceof Error && "code" in error ? multipartLimitErrors[String(error.code)] : undefined;
  if (multipart) return { statusCode: 413, body: multipart };

  // Fastify's own client errors (malformed or empty body, oversized payload) are not server faults.
  const statusCode = error instanceof Error && "statusCode" in error ? Number(error.statusCode) : 500;
  if (statusCode >= 400 && statusCode < 500) {
    return { statusCode, body: { error: "Bad request", code: "BAD_REQUEST" } };
  }

  return {
    statusCode: 500,
    body: { error: "Internal server error", code: "INTERNAL_SERVER_ERROR" }
  };
}
