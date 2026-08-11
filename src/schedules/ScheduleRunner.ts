import { Logger } from "../utils/Logger";
import { ScheduleService } from "./ScheduleService";

export class ScheduleRunner {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly getScheduleService: () => ScheduleService,
    private readonly logger: Logger,
    private readonly intervalMs = 30_000
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(now = new Date()): Promise<void> {
    if (this.ticking) {
      return;
    }

    this.ticking = true;

    try {
      const results = await this.getScheduleService().runDue(now);

      for (const result of results) {
        if (result.error) {
          this.logger.warn("Scheduled task run failed", {
            scheduleId: result.scheduleId,
            taskId: result.taskId,
            error: result.error
          });
        } else if (result.taskId) {
          this.logger.info("Scheduled task run completed", {
            scheduleId: result.scheduleId,
            taskId: result.taskId,
            runId: result.runId
          });
        }
      }
    } catch (error) {
      this.logger.error("Schedule runner tick failed", {
        error: error instanceof Error ? error.message : "unknown_error"
      });
    } finally {
      this.ticking = false;
    }
  }
}
