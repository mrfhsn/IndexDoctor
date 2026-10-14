export interface SingleFlightResult<T> {
  result: T;
  shared: boolean;
}

/**
 * Coalesces identical concurrent executions into a single shared execution.
 * When multiple callers invoke do() with the same key while an operation is
 * in flight, only one underlying function executes, and all callers receive
 * the identical result.
 */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  public async do(key: string, fn: () => Promise<T>): Promise<SingleFlightResult<T>> {
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      const result = await existing;
      return { result, shared: true };
    }

    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);

    const result = await promise;
    return { result, shared: false };
  }

  public get inFlightCount(): number {
    return this.inFlight.size;
  }
}
