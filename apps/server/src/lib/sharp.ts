import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loaderExecArgv } from "./fork-args.js";
import { logger } from "./logger.js";

/** A picture to write as an AVIF: a file sharp reads by itself, or what ffmpeg made of one. */
export type PictureJob = {
  input: string | Buffer;
  target: string;
  quality: number;
  /** Turned the way the camera was held and scaled down to fit a square of this many pixels; written as large as it is otherwise. */
  edge?: number;
  /** What is transparent in it is laid on white. */
  opaque?: boolean;
};

/** Without a job, only whether there is a sharp to write with is asked. */
export type SharpRequest = { id: number; job?: PictureJob };
export type SharpResponse = { id: number; ok: boolean; message?: string };

/** The process gives up on a picture by itself well before this; one that no longer answers at all is replaced. */
const UNANSWERED_MS = 45_000;

const workerPath = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./sharp-worker.ts" : "./sharp-worker.js", import.meta.url));

type Running = { child: ChildProcess; jobs: Map<number, (response: SharpResponse) => void> };

let running: Running | null = null;
let nextId = 0;
let available: Promise<boolean> | undefined;

/**
 * sharp, which writes the AVIFs Kago makes, in a process of its own. Each picture it writes holds a thread of the
 * pool every file read and write of a process goes through, worker threads included, for as long as the writing
 * takes: a folder of pictures drawn in the server itself would leave it waiting to read anything else.
 */
function start(): Running {
  const child = fork(workerPath, [], { execArgv: loaderExecArgv(), serialization: "advanced", stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const started: Running = { child, jobs: new Map() };
  // Idle between folders; it must not keep the server from shutting down.
  child.unref();
  child.channel?.unref();
  child.on("message", (response: SharpResponse) => {
    started.jobs.get(response.id)?.(response);
    started.jobs.delete(response.id);
  });
  child.on("error", (error) => logger.warn("picture process failed", error.message));
  child.once("exit", () => {
    if (running === started) running = null;
    for (const [id, settle] of started.jobs) settle({ id, ok: false, message: "the picture process exited" });
    started.jobs.clear();
  });
  return started;
}

/** Hands a request to the process, which is started on first use and replaced when it dies or stops answering. */
function ask(job?: PictureJob): Promise<SharpResponse> {
  const { child, jobs } = (running ??= start());
  const id = (nextId += 1);
  return new Promise<SharpResponse>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), UNANSWERED_MS);
    jobs.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    child.send({ id, job } satisfies SharpRequest, (error) => {
      if (!error) return;
      jobs.get(id)?.({ id, ok: false, message: error.message });
      jobs.delete(id);
    });
  });
}

/**
 * Whether there is a sharp to write pictures with, found out once. It carries a library built for one kind of
 * machine, and there may be none for this one.
 */
export function sharpAvailable(): Promise<boolean> {
  return (available ??= ask().then((response) => {
    if (!response.ok) logger.warn("sharp could not be loaded; no pictures are drawn with it", response.message);
    return response.ok;
  }));
}

/** Writes a picture as an AVIF. What is transparent in it stays so, unless it is to be `opaque`. */
export async function writeAvif(job: PictureJob): Promise<void> {
  const response = await ask(job);
  if (!response.ok) throw new Error(response.message ?? "the picture could not be written");
}
