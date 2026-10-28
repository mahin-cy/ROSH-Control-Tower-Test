import type { Logger } from 'pino';

// Logs the first occurrence of a repeating event immediately, then a
// periodic "still failing, N times in last <window>" summary instead of
// one line per occurrence — per CLAUDE.md's flapping-connection guidance.
export function createRateLimitedLogger(logger: Logger, windowMs: number) {
  const counts = new Map<string, number>();

  setInterval(() => {
    for (const [key, count] of counts) {
      if (count > 0) {
        logger.warn(
          { key, count, windowMs },
          `still failing, ${count} times in last ${windowMs}ms`
        );
        counts.set(key, 0);
      }
    }
  }, windowMs).unref();

  return function log(
    level: 'warn' | 'error',
    message: string,
    context: Record<string, unknown> = {}
  ): void {
    const key = message;
    const count = counts.get(key) ?? 0;
    if (count === 0) {
      logger[level](context, message);
    }
    counts.set(key, count + 1);
  };
}
