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

  return {
    statusCode: 500,
    body: { error: "Internal server error", code: "INTERNAL_SERVER_ERROR" }
  };
}
