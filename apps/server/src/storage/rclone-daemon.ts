import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger.js";
import { RcloneClient, rcloneSocketPath } from "./rclone-client.js";

const START_TIMEOUT_MS = 15_000;

/**
 * Keeps one `rclone rcd` running beside the server. It listens on a socket only this user can open,
 * and its configuration is written afresh from the database each time it starts.
 */
export class RcloneDaemon {
  private readonly binary = process.env.RCLONE_PATH ?? "rclone";
  private readonly socketPath: string;
  private readonly configPath: string;
  private child: ChildProcess | null = null;
  private starting: Promise<boolean> | null = null;
  private stopping = false;
  private missing = false;

  constructor(
    private readonly appDataDir: string,
    /** Called each time the daemon comes up with nothing configured. */
    private readonly onReady: () => Promise<void>
  ) {
    this.socketPath = rcloneSocketPath(appDataDir);
    this.configPath = path.join(appDataDir, "rclone", "rclone.conf");
  }

  /** True once the daemon answers; false when rclone is not installed or would not start. */
  ensure(): Promise<boolean> {
    if (this.missing || this.stopping) return Promise.resolve(false);
    this.starting ??= this.start().then(
      (ok) => {
        if (!ok) this.starting = null;
        return ok;
      },
      () => {
        this.starting = null;
        return false;
      }
    );
    return this.starting;
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
  }

  private async start(): Promise<boolean> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
    fs.rmSync(this.socketPath, { force: true });
    fs.writeFileSync(this.configPath, "", { mode: 0o600 });
    const child = spawn(
      this.binary,
      ["rcd", "--rc-addr", `unix://${this.socketPath}`, "--rc-no-auth", "--rc-serve", "--config", this.configPath, "--cache-dir", path.join(this.appDataDir, "temp", "rclone"), "--ask-password=false", "--log-level", "NOTICE"],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => {
      // A player that seeks, or ffmpeg done with a file, hangs up in the middle of a read; rclone calls each one an error.
      const lines = chunk.toString("utf8").split("\n").filter((line) => line.trim() && !line.includes("Didn't finish writing GET request"));
      if (lines.length > 0) logger.warn("rclone", lines.join("\n"));
    });
    const exited = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        if ("code" in error && error.code === "ENOENT") {
          this.missing = true;
          logger.warn("rclone not found; remote locations are disabled");
        } else logger.warn("rclone could not be started", error.message);
        resolve();
      });
      child.once("exit", () => resolve());
    });
    void exited.then(() => {
      if (this.child !== child) return;
      this.child = null;
      this.starting = null;
    });

    const client = new RcloneClient(this.socketPath);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (this.child === child && Date.now() < deadline) {
      if (fs.existsSync(this.socketPath) && (await client.call("rc/noop").then(() => true, () => false))) {
        await this.onReady();
        return true;
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
    if (this.child === child) child.kill();
    return false;
  }
}
