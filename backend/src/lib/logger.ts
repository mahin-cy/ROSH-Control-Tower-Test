import pino from 'pino';

// Defense-in-depth, not a statement that secrets are logged today (they
// aren't, at any current call site) — closes the gap where a future
// `logger.error({ err })` from a library that embeds a credential in its
// error object would otherwise go out in plaintext with no safety net.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', '*.password'],
    censor: '[REDACTED]'
  }
});
