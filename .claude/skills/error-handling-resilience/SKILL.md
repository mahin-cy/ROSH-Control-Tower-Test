---
name: error-handling-resilience
description: Non-negotiable standards for how errors are caught, reported, and recovered from across all stacks — frontend, backend, and database/storage layers. Use this skill whenever writing code that calls an external service, database, or API; writing a try/catch or equivalent error-handling block; implementing a retry, timeout, or fallback; returning an error response from an endpoint; or handling a failure state in a UI component — even if the request doesn't mention "error handling" explicitly.
---

# Error Handling & Resilience

These rules are mandatory, not suggestions. An error that's silently swallowed is worse than one that crashes loudly — a crash gets noticed and fixed; a swallowed error hides a real problem until it causes damage somewhere else, later, in a way that's much harder to trace back.

## Core rules (always apply, every stack)

1. **Every error is handled deliberately** — either caught and acted on, or explicitly allowed to propagate. Never use an empty catch block, or a catch that only logs and continues as if nothing happened, unless that's a genuinely considered decision for a non-critical path (see Secure Defaults below).
2. **Distinguish operational errors from programmer errors.** Operational errors (network timeout, invalid input, a third-party outage) are expected and should be handled, retried, or reported gracefully. Programmer errors (null reference, invalid internal state, a broken invariant) indicate a bug — these should generally fail loudly (crash, alert) rather than being caught and quietly worked around.
3. **Never expose internal error details externally** — stack traces, database error messages, file paths, internal exception text, library-specific errors. Log the full detail server-side; return a generic, safe message to the end user or external API caller. (This restates Security's general principle specifically for error paths — see that skill's Secure Defaults.)
4. **Every external call has an explicit timeout** — third-party API, database query, another internal service, filesystem operation, network request. No unbounded waits, ever, even in a quick prototype.
5. **Retries use exponential backoff with jitter and a hard maximum attempt count.** Never retry indefinitely. Never retry a non-idempotent operation (e.g. "charge the card") without idempotency protection in place first.
6. **Use a circuit breaker (or equivalent) for calls to dependencies that can degrade or fail.** This prevents one struggling dependency from causing cascading failures or a retry storm across the rest of the system.
7. **Every logged error includes enough context to be actionable** — the operation attempted, relevant (non-sensitive) inputs, and a correlation/request ID — but never secrets or full PII in the error payload or log line. (See Secrets & Config Management and Logging & Observability skills.)
8. **Resource cleanup happens in a `finally` block or equivalent (context manager, `using`, `defer`), never only on the happy path.** DB connections, file handles, locks, and open network sockets must be released regardless of whether the operation succeeded or failed.
9. **Multi-step writes that must be atomic use a real transaction, and the transaction rolls back completely on any failure.** Partial writes left in place after an error are not acceptable.
10. **Define graceful degradation for non-critical dependencies.** A failure on the critical path (e.g. payment processing) should fail loudly and stop the operation. A failure on a non-critical path (e.g. a recommendations widget) should degrade gracefully with a fallback, not take down the whole request.

## Secure defaults — include even if the request doesn't mention them

- **No "catch everything and log it" as a blanket pattern.** A generic catch that logs and continues is sometimes the right call for a genuinely non-critical operation, but it should be a deliberate, visible decision per call site — not the default shape every error handler takes because it's the easiest way to stop a crash.
- **Use a consistent error response shape across the whole API** (error code, safe message, correlation ID) rather than each endpoint inventing its own — ad hoc shapes are what leak internal details, because there's no single reviewed template being reused.
- **Frontend: use error boundaries (or the framework equivalent)** so a failure in one component doesn't blank the entire page. Show a user-friendly fallback message, never the raw error object or exception text.
- **Every retry loop is bounded with backoff by default** — an unbounded `while (true) { try again }` loop is a common scaffolding shortcut that becomes a production incident.
- **Set explicit timeouts on every HTTP client / DB client by default.** Many client libraries default to "no timeout" — that default must be overridden explicitly every time a client is instantiated, not left as-is.
- **A single failing non-critical dependency should not turn into a 500 for the whole request** — wrap it so its failure degrades that one piece of the response, not the entire response.
- **Generate and propagate a correlation/request ID across service calls by default**, so an error can be traced end-to-end without manually correlating timestamps across logs later.
- **Unhandled/programmer errors trigger an alert, not just a log line** — if nothing is watching for these, they get discovered by a user complaint instead of by the team.

## What to do next

Match the task to a reference file and read it before writing the code:

| Task involves... | Read |
|---|---|
| Deciding what to catch vs. let propagate, exception/error types, try/catch scope, error boundaries | `references/error-classification-and-handling.md` |
| Timeouts, retries, backoff, circuit breakers, graceful degradation, resource cleanup, transactions | `references/resilience-patterns.md` |
| What an error response looks like to a user or API caller, correlation IDs, tying errors back to logs/alerts | `references/user-facing-errors-and-observability.md` |

If a task touches more than one row, read all that apply.

## When rules can't be followed

If a legacy system, third-party library, or existing architecture makes one of these rules genuinely hard to follow, don't silently work around it — stop, tell the user which rule is in conflict and why, and let them decide how to proceed.

## Scope boundary

This skill covers how errors are caught, classified, recovered from, and surfaced. It does NOT cover:
- What gets logged and in what format → **Logging & Observability** skill
- Why internal error details are dangerous to expose (the security rationale) → **Security** skill
- Testing error paths and failure scenarios → **Testing Standards** skill
- API error-response schema conventions beyond the safe-message principle here → **API Design Standards** skill

If a task spans into those areas, this skill's rules still apply — consult the relevant skill above for the rest.
