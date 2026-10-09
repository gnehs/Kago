import { logger } from "./logger.js";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "APP_ERROR"
  ) {
    super(message);
  }
}

const multipartLimitErrors: Record<string, { error: string; code: string }> = {
  FST_FILES_LIMIT: { error: "Too many files in one upload", code: "TOO_MANY_UPLOAD_FILES" },
  FST_PARTS_LIMIT: { error: "Too many files in one upload", code: "TOO_MANY_UPLOAD_FILES" }
};

// What the server's own disk refuses is not a fault of Kago's and not for the person to retry: it is for whoever runs the server to put right.
const noPermission = { error: "Kago’s system account has no permission for this on the server’s disk. An administrator needs to check PUID / PGID and who owns the folder.", code: "FS_PERMISSION_DENIED" };
const fileSystemRefusals: Record<string, { error: string; code: string }> = {
  EACCES: noPermission,
  EPERM: noPermission,
  EROFS: { error: "This folder is mounted read-only on the server", code: "FS_READ_ONLY" }
};

/** The account the server runs as, which is the one the disk's own permissions are checked against. */
export function systemAccount(): { uid: number; gid: number } | null {
  return process.getuid && process.getgid ? { uid: process.getuid(), gid: process.getgid() } : null;
}

/** A refusal of the disk's own (ownership, mode bits, a read-only mount) in words that say so; the path and the account go to the log. */
export function fileSystemRefusal(error: unknown): AppError | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const refusal = fileSystemRefusals[String(error.code)];
  if (!refusal) return null;
  const { syscall, path } = error as NodeJS.ErrnoException;
  logger.warn(`the file system refused ${syscall ?? "an operation"}${path ? ` on ${path}` : ""}`, { code: error.code, ...systemAccount() });
  return new AppError(500, refusal.error, refusal.code);
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
