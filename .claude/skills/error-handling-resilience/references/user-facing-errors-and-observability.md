# User-Facing Errors & Observability

Read this whenever code returns an error to a user or API caller, or needs to make a failure traceable after the fact.

## Safe, consistent error responses

- Define one error response shape for the whole API (e.g. a code, a safe human-readable message, and a correlation ID) and reuse it everywhere, rather than letting each endpoint invent its own — a single reviewed shape is what actually keeps internal details from leaking, because there's only one place to get it right instead of many.
- The message returned to the caller should be safe and generic enough to not reveal internals (see Core Rule 3 in the main skill and the Security skill's Secure Defaults) but specific enough to be useful — "invalid request" is often too vague; "the 'email' field is required" is safe and helpful. The line is: describe what's wrong with the *request*, never describe what's wrong *inside the system*.
- Map error types to appropriate status codes/response codes consistently (e.g. validation issues vs. not-found vs. permission-denied vs. unexpected-server-error should each map predictably) so API consumers can build reliable handling logic against your API rather than parsing message text.

## Correlation IDs

- Generate a correlation/request ID at the start of each request (or accept one passed in from an upstream caller) and propagate it through every downstream call and log line for that request.
- Return the correlation ID to the caller in the error response. This turns "a user reports something went wrong" into "here's the exact ID to search the logs for," instead of trying to reconstruct what happened from a timestamp and a vague description.
- In a multi-service architecture, the same correlation ID must be passed along in outgoing requests to other internal services so a single failure can be traced across service boundaries, not just within the service where it surfaced.

## Tying errors to logs and alerts

- Every error response returned to a caller should have a corresponding log entry, server-side, with full detail (safe to log — see Secrets & Config Management skill for what's never allowed in a log line) and the same correlation ID, so the safe external message and the detailed internal record can be joined by that ID.
- Unhandled/unexpected errors (the "programmer error, fail loud" category from `error-classification-and-handling.md`) should trigger an alert, not just a log line nobody's watching — the goal is to find out about a bug from monitoring, not from a user complaint days later.
- Expected/operational errors that are working as designed (e.g. a validation error from bad user input) generally don't need to alert — reserve alerting for signals that something the system relies on is actually broken, or alert fatigue will cause real signals to get ignored.

## Frontend-specific: what the user actually sees

- Never show a raw exception, stack trace, or technical error code as the primary message to an end user — translate it to what the user can actually act on ("we couldn't save your changes, try again" rather than the raw fetch error).
- Where it helps, surface the correlation ID in a small, unobtrusive way (e.g. "if this keeps happening, reference code: <id>") so a support conversation has something concrete to search for, without cluttering the primary message.
- Distinguish between errors the user can retry themselves (transient network issue — offer a retry action) and errors that need different input or outside help (validation error — explain what to fix; permission error — explain what's needed) rather than giving every failure the same generic "something went wrong, try again" treatment.

## Quick checklist before marking this done

- [ ] Error responses follow the project's single defined shape, not an ad hoc one for this endpoint
- [ ] The message describes what's wrong with the request/input, never internal system detail
- [ ] A correlation ID is generated (or propagated), returned to the caller, and present in the server-side log for the same event
- [ ] Unhandled/unexpected errors trigger an alert, not just a log entry
- [ ] Frontend error messages are user-actionable, not raw technical text
- [ ] Retryable vs. non-retryable failures are presented differently to the user, where relevant
