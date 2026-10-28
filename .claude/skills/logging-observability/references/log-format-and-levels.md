# Log Format & Levels

Read this whenever code writes a log statement, decides what to include in it, or needs to handle logging on the frontend versus the backend differently.

## Structured logging

- Every log line is a structured record (JSON or the platform's structured-logging equivalent), not a formatted string. `logger.info({ event: "user_login", user_id: id, correlation_id: cid })` is queryable later; `logger.info("User " + id + " logged in")` is not.
- Use consistent field names across every service in the codebase — `correlation_id` everywhere, not `correlation_id` in one service and `requestId`/`trace_id` in another. Inconsistent naming defeats cross-service querying, which is often exactly when you need it most (tracing one request through several services).

## Required fields on every log line

- `timestamp` — ISO 8601, UTC, not local time and not a bare epoch integer without documentation of its unit.
- `level` — one of the standard levels below.
- `service` (or `component`) — which part of the system emitted this.
- `correlation_id` / `request_id` — whenever the log is tied to a specific operation or request; omit only for genuinely global, request-independent events (e.g. a scheduled job with no single triggering request).
- `message` — a short, human-readable summary; put variable detail in structured fields alongside it, not interpolated into the message string.

## Log levels — what belongs where

| Level | Use for | Example |
|---|---|---|
| DEBUG | Verbose detail useful only when actively troubleshooting | Full parameters of an internal function call |
| INFO | Normal operational events worth recording | "user logged in," "order created," "job completed" |
| WARN | Something unexpected happened but the system recovered or degraded gracefully | A retry succeeded on the second attempt; a non-critical dependency was skipped |
| ERROR | An operation failed and needs attention | A request failed after all retries were exhausted |
| FATAL/CRITICAL | The system itself is compromised, not just one operation | The process cannot start because a required dependency is unreachable |

When genuinely unsure which level fits, prefer the lower of the two candidates for routine conditions and the higher of the two for anything that indicates real impact — but don't default everything to INFO out of uncertainty; that's how real failures end up buried in noise.

## What must never appear in a log line

Applies at every level, in every environment, without exception:
- Passwords, password hashes, or anything password-adjacent
- API keys, tokens (session, JWT, OAuth, API), and connection strings
- Full credit card numbers, bank account/routing numbers
- Government ID numbers (SSN, passport, etc.)
- Full raw request/response bodies that could contain any of the above
- Auth headers or cookies, in full or in part

For fields that are useful for support/debugging but sensitive (email, phone), consider partial masking (e.g. last 4 digits, domain-only for email) rather than either full exposure or full omission, depending on what the support workflow actually needs — check with the Data Privacy & Compliance skill for what your domain classifies as sensitive here.

## Centralized redaction

- Implement redaction in one shared logger wrapper or middleware with a maintained list of sensitive field names (`password`, `token`, `secret`, `ssn`, `creditCard`, `authorization`, etc.) that gets auto-scrubbed regardless of where the log call happens — don't rely on every developer remembering to manually omit these at each call site.
- When logging an object that might contain sensitive fields (e.g. a user record, a request body), pass it through the redaction layer rather than logging it directly, even if you believe the specific fields present are safe this time — objects grow new fields over time, and the redaction layer is what catches that safely by default.

## Frontend logging specifics

- Anything logged to the browser console in a production build is visible to anyone with dev tools open. Gate verbose/debug logging behind a build-time or runtime environment check so it's stripped or silenced in production.
- Real errors that need investigation should be sent to a server-side error-reporting/observability tool (not just left in console output), so they're actually visible to the team rather than only to whichever user happened to have dev tools open when it happened.
- Never log full request/response objects from client-side network calls — they can include auth headers or tokens attached by an HTTP client's interceptor/default config.

## Backend logging specifics

- Avoid logging full request or response bodies wholesale by default; log the specific fields relevant to the event being recorded.
- Structure contextual data as nested fields in the log record rather than serializing an entire object to a string and appending it to the message.

## Log volume control

- Inside loops or high-frequency code paths, rate-limit or sample logging (e.g. log every Nth iteration, or only log a summary after the loop completes) rather than logging on every iteration — unbounded per-iteration logging both floods storage and obscures the actual signal in a sea of repetition.

## Quick checklist before marking this done

- [ ] Log statements are structured, not string-concatenated
- [ ] Required fields (timestamp, level, service, correlation ID) are present
- [ ] The log level chosen matches the actual severity/nature of the event
- [ ] No secrets, tokens, full PII, or raw auth headers appear in the log line
- [ ] Sensitive fields pass through the centralized redaction layer, not manual per-call-site omission
- [ ] Production log level defaults to INFO/WARN, not DEBUG
- [ ] Frontend debug logging is gated out of production builds
- [ ] Logging inside loops is rate-limited or sampled, not unconditional per-iteration
