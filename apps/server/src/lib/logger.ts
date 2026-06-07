export const logger = {
  info(message: string, data?: unknown) {
    console.log(`[kago] ${message}`, data ?? "");
  },
  warn(message: string, data?: unknown) {
    console.warn(`[kago] ${message}`, data ?? "");
  },
  error(message: string, data?: unknown) {
    console.error(`[kago] ${message}`, data ?? "");
  }
};
