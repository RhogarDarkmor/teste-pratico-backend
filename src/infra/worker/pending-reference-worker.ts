import type { ReprocessPendingReferencesUseCase } from '../../application/reprocess-pending-references.use-case';

export interface WorkerLogger {
  error(message: string): void;
}

// Laço simples: processa o que está vencido e dorme quando não há nada a fazer.
export class PendingReferenceWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly useCase: ReprocessPendingReferencesUseCase,
    private readonly pollIntervalMs = 2_000,
    private readonly logger: WorkerLogger = console,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let idle = true;
      try {
        const summary = await this.useCase.runOnce();
        idle = summary.claimed === 0;
      } catch (error) {
        this.logger.error(`Pending reference worker cycle failed: ${(error as Error).message}`);
      }
      if (this.running && idle) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.pollIntervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    }
  }
}
