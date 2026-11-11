import { availableParallelism, loadavg } from "node:os";

/** Processor cores nothing is asking for. Windows has no load average, which is not evidence of any. */
export const idleCores = () => (process.platform === "win32" ? 0 : availableParallelism() - (loadavg()[0] ?? Number.POSITIVE_INFINITY));
