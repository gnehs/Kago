import type { AuthService } from "../services/auth.service.js";
import type { TaskService } from "../services/task.service.js";
import { logger } from "../lib/logger.js";

export class WorkerManager {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly tasks: TaskService,
    private readonly auth: AuthService
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 1000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const task = this.tasks.claimNext();
      if (!task) return;
      const user = this.auth.getUser(task.created_by);
      await this.tasks.runTask(task, {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        disabled: Boolean(user.disabled)
      });
    } catch (error) {
      logger.error("worker tick failed", error);
    } finally {
      this.running = false;
    }
  }
}
