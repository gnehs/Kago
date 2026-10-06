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
  FST_REQ_FILE_TOO_LARGE: { error: "Uploaded file is too large", code: "UPLOAD_TOO_LARGE" },
  FST_FILES_LIMIT: { error: "Too many files in one upload", code: "TOO_MANY_UPLOAD_FILES" },
  FST_PARTS_LIMIT: { error: "Too many files in one upload", code: "TOO_MANY_UPLOAD_FILES" }
};

export function publicError(error: unknown): { statusCode: number; body: { error: string; code: string } } {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code }
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
