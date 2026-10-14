/**
 * Simple in-memory async semaphore to limit concurrent operations.
 * Used for outbound LLM concurrency limiting (LLM_MAX_CONCURRENCY).
 */
export class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  public constructor(private readonly max: number) {}

  public async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.release();
        }
      };
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.release();
          }
        });
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.current -= 1;
    }
  }

  public get activeCount(): number {
    return this.current;
  }

  public get queueLength(): number {
    return this.queue.length;
  }
}
