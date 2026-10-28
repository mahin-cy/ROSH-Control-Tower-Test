# Resilience Patterns

Read this whenever code calls an external service, database, or API, or needs to keep working (fully or partially) when a dependency is slow or unavailable.

## Timeouts

- Every network call, database query, and filesystem operation on a potentially slow medium (network filesystem, large file) needs an explicit timeout. An unbounded wait on one slow dependency can exhaust a thread pool or connection pool and take down unrelated requests.
- Set timeouts at multiple levels where they apply: the individual client call, and an overall budget for the request/operation as a whole if it involves multiple sequential calls — a request that makes five calls each with a generous individual timeout can still take far too long in aggregate.
- Choose timeout values based on the dependency's actual expected latency, not a copy-pasted default — a timeout that's too generous defeats the purpose; one that's too tight causes unnecessary failures under normal load variance.

## Retries

- Retry only operations that are safe to retry: idempotent operations (the same effect whether run once or multiple times), or operations with explicit idempotency protection (e.g. an idempotency key on a payment request) if they're not naturally idempotent.
- Use exponential backoff with jitter between attempts — fixed-interval retries from many clients at once (e.g. after a shared dependency recovers) create a synchronized retry storm that can re-trigger the same outage.
- Always cap the maximum number of attempts and the maximum total time spent retrying. Retrying forever is never the right default.
- Distinguish retryable failures (timeout, connection reset, 5xx/server error, rate limit with backoff) from non-retryable ones (validation error, 4xx/client error, permission denied) — retrying a request that will deterministically fail again wastes time and can mask the real problem.

## Circuit breakers

- For any dependency that can degrade (increased latency, intermittent errors) rather than fail cleanly, use a circuit breaker (or equivalent) that stops sending requests to a struggling dependency for a cooldown period after it crosses a failure threshold, instead of letting every caller keep retrying against it.
- This protects two things at once: it gives the struggling dependency room to recover instead of being hit with continued load, and it fails fast for callers instead of making them each wait out their own timeout against a dependency that's clearly down.
- Pair the circuit breaker with a fallback (see below) — "fail fast" is only a full solution if there's something reasonable to do once the circuit is open.

## Graceful degradation and fallbacks

- Classify each dependency a feature relies on as critical-path or non-critical-path. Critical-path failures should fail the operation clearly (Core Rule 2 — fail loud for anything the user needs to know didn't work). Non-critical-path failures should degrade: skip the feature, show a reduced/cached version, or omit that section of the response, while the rest of the operation still succeeds.
- Concretely: a checkout flow failing because the payment processor is down is a critical-path failure — fail loudly and tell the user. A checkout page failing because the "customers also bought" widget's service is down is non-critical — drop the widget, complete the checkout.
- Have an explicit fallback value or behavior for non-critical dependencies (a cached last-known-good value, a sensible default, or simply omitting that piece of the UI/response) rather than letting the exception propagate up and take down the whole request by accident.

## Resource cleanup

- Any resource that's explicitly acquired (DB connection, file handle, lock, network socket) must be released in a `finally` block or the language's equivalent (context manager, `using`, `defer`) — never only on the success path. An error between acquiring and releasing a resource is exactly the scenario cleanup code exists for.
- Watch for resource leaks specifically in retry loops — if a resource is acquired inside a loop that retries on failure, make sure each failed attempt still releases what it acquired before the next attempt runs.
- Connection pools need bounded size and their own timeout for acquiring a connection from the pool — an unbounded pool, or a pool with no acquire-timeout, can hang the whole application when a downstream dependency is slow rather than failing that one operation.

## Transactions and data consistency

- Any multi-step write that must be all-or-nothing (e.g. debit one record, credit another) belongs inside a real database transaction, not a sequence of independent writes with manual error-checking between them.
- On any error inside a transaction, roll back completely — don't attempt to manually "undo" partial writes with follow-up write statements, which introduces its own failure window.
- For operations that must stay consistent across multiple services (no single database transaction can span them), use an explicit pattern designed for this (e.g. a saga with compensating actions) rather than an ad hoc sequence of calls with no defined recovery if a later step fails. If the codebase doesn't yet have a pattern for this, flag it rather than quietly hoping the operations don't fail out of order.

## Quick checklist before marking this done

- [ ] Every external call has an explicit timeout, chosen deliberately rather than copy-pasted
- [ ] Retries are limited to idempotent (or idempotency-protected) operations
- [ ] Retries use exponential backoff with jitter and a hard cap
- [ ] A circuit breaker (or equivalent) is used for dependencies that can degrade, with a defined fallback
- [ ] Non-critical dependencies degrade gracefully rather than failing the whole operation
- [ ] All acquired resources are released in a `finally`/equivalent, including inside retry loops
- [ ] Multi-step atomic writes use a real transaction with full rollback on error
- [ ] Cross-service consistency uses an explicit pattern, not an unmanaged sequence of calls
