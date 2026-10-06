export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "APP_ERROR"
  ) {
    super(message);
  }
}

export function publicError(error: unknown): { statusCode: number; body: { error: string; code: string } } {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code }
    };
  }

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
