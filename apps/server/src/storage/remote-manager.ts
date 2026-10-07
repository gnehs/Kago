import { id } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { ensureSshKey } from "../lib/ssh-key.js";
import type { RootService } from "../services/root.service.js";
import type { Root } from "../services/types.js";
import type { RemoteConfig } from "./providers.js";
import { RcloneError, type RcloneClient } from "./rclone-client.js";
import { RcloneDaemon } from "./rclone-daemon.js";
import { remoteName } from "./remote-storage.js";

/**
 * Keeps rclone knowing every remote location the database has. Only the server's main thread does this:
 * the task worker talks to the same daemon and finds the remotes already there.
 */
export class RemoteManager {
  private readonly daemon: RcloneDaemon;

  constructor(
    private readonly client: RcloneClient,
    private readonly roots: RootService,
    private readonly appDataDir: string
  ) {
    this.daemon = new RcloneDaemon(appDataDir, async () => {
      for (const root of this.roots.listRemote()) {
        await this.push(remoteName(root), this.roots.remoteConfig(root)).catch((error: unknown) => logger.warn(`remote location ${root.slug} could not be set up`, error instanceof Error ? error.message : error));
      }
    });
  }

  /** Whether remote locations can be used at all: rclone is installed and answering. */
  available(): Promise<boolean> {
    return this.daemon.ensure();
  }

  /** Starts rclone when there is something for it to reach. */
  async start(): Promise<void> {
    if (this.roots.listRemote().length > 0) await this.daemon.ensure();
  }

  stop(): void {
    this.daemon.stop();
  }

  async configure(root: Root): Promise<void> {
    if (await this.daemon.ensure()) await this.push(remoteName(root), this.roots.remoteConfig(root));
  }

  async forget(root: Root): Promise<void> {
    if (await this.daemon.ensure()) await this.client.call("config/delete", { name: remoteName(root) }).catch(() => undefined);
  }

  /** Tries a configuration out by listing the folder it points at. The reason it failed is rclone's own, for the administrator. */
  async test(config: RemoteConfig): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.daemon.ensure())) return { ok: false, error: "rclone is not installed on this server" };
    const name = `kago_test_${id("t")}`;
    try {
      await this.push(name, config);
      await this.client.list(`${name}:${config.base}`, "");
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof RcloneError || error instanceof Error ? error.message : String(error) };
    } finally {
      await this.client.call("config/delete", { name }).catch(() => undefined);
    }
  }

  private async push(name: string, config: RemoteConfig): Promise<void> {
    const parameters: Record<string, string> = { ...config.params };
    // The box that says to use Kago's key stands for the key's place on this server.
    if (config.type === "sftp") {
      if (parameters.key_file) parameters.key_file = (await ensureSshKey(this.appDataDir)).keyPath;
      else delete parameters.key_file;
    }
    await this.client.call("config/create", { name, type: config.type, parameters, opt: { obscure: true, nonInteractive: true } });
  }
}
