export type WaitForOptions = {
  /**
   * Number of milliseconds to wait before retrying the condition.
   *
   * @default 20
   */
  interval?: number;

  /**
   * Number of milliseconds to wait before timing out.
   *
   * @default Infinity
   */
  timeout?: number;
};

export class TimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Wait for a condition to be true.
 *
 * @param condition - A function that returns a boolean or a Promise that resolves to a boolean.
 * @param options - Options for the wait operation.
 * @returns A Promise that resolves when the condition is true.
 * @throws {TimeoutError} When the timeout is exceeded.
 */
const waitFor = (
  condition: () => Promise<boolean> | boolean,
  options: WaitForOptions = {},
): Promise<void> => {
  const { interval = 20, timeout = Number.POSITIVE_INFINITY } = options;

  const startTime = Date.now();

  return new Promise<void>((resolve, reject) => {
    const check = async (): Promise<void> => {
      try {
        const result = await condition();

        if (result) {
          resolve();
          return;
        }

        if (
          timeout !== Number.POSITIVE_INFINITY &&
          Date.now() - startTime >= timeout
        ) {
          reject(new TimeoutError(`Timed out after ${timeout}ms`));
          return;
        }

        setTimeout(() => {
          void check();
        }, interval);
      } catch (error) {
        reject(error);
      }
    };

    void check();
  });
};

export default waitFor;
