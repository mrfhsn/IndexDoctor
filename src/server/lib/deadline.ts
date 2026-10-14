import { AppError } from '../errors.js';

export interface Deadline {
  readonly budgetMs: number;
  readonly deadlineTimeMs: number;
  readonly remainingMs: number;
  readonly isExpired: boolean;
  readonly signal: AbortSignal;
  throwIfExpired(stageName?: string): void;
  child(childBudgetMs: number): Deadline;
  dispose(): void;
}

class DeadlineImpl implements Deadline {
  public readonly budgetMs: number;
  public readonly deadlineTimeMs: number;
  private readonly abortController: AbortController;
  private readonly timeoutTimer: NodeJS.Timeout | null = null;
  private isDisposed = false;

  public constructor(budgetMs: number, parentDeadlineTimeMs?: number) {
    this.budgetMs = Math.max(0, budgetMs);
    const now = Date.now();
    const naturalDeadline = now + this.budgetMs;

    this.deadlineTimeMs =
      parentDeadlineTimeMs !== undefined
        ? Math.min(naturalDeadline, parentDeadlineTimeMs)
        : naturalDeadline;

    this.abortController = new AbortController();

    const msUntilExpiry = Math.max(0, this.deadlineTimeMs - now);
    if (msUntilExpiry <= 0) {
      this.abortController.abort();
    } else {
      this.timeoutTimer = setTimeout(() => {
        if (!this.isDisposed) {
          this.abortController.abort();
        }
      }, msUntilExpiry);
      // Don't hold the Node process open for deadline timers
      this.timeoutTimer.unref();
    }
  }

  public get remainingMs(): number {
    return Math.max(0, this.deadlineTimeMs - Date.now());
  }

  public get isExpired(): boolean {
    return this.remainingMs <= 0 || this.abortController.signal.aborted;
  }

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public throwIfExpired(stageName?: string): void {
    if (this.isExpired) {
      const stageText = stageName ? ` during ${stageName}` : '';
      throw new AppError('BUSY', `Request deadline exceeded${stageText}.`, {
        status: 503,
        hint: 'The request took longer than the configured deadline. Please retry.',
      });
    }
  }

  public child(childBudgetMs: number): Deadline {
    return new DeadlineImpl(childBudgetMs, this.deadlineTimeMs);
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
    }
  }
}

export function createDeadline(budgetMs: number): Deadline {
  return new DeadlineImpl(budgetMs);
}
