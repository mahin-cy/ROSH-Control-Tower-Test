# Error Classification & Handling

Read this whenever code needs to decide what to catch, what to let propagate, what kind of error/exception type to raise, or how to handle a failure in a UI component.

## Operational vs. programmer errors

This is the single most useful distinction for deciding how to handle a given failure:

- **Operational errors** are expected failures in a working system: a network timeout, a third-party API returning an error, invalid user input, a file that doesn't exist, a database connection dropping. These are not bugs — they're normal conditions a resilient system needs to handle. Catch these, and respond appropriately (retry, fallback, user-facing message).
- **Programmer errors** indicate the code itself is wrong: a null/undefined reference where a value was assumed to exist, a broken invariant, a type mismatch that shouldn't be possible given the code's own logic. These are bugs. Catching and quietly working around them hides the bug instead of surfacing it — prefer to let these fail loudly (crash the request/process, alert) so they get fixed, rather than silently continuing in a possibly-corrupted state.

When in doubt about which category an error falls into, treat it as a programmer error (fail loud) rather than assuming it's operational (handle and continue) — silently continuing past an unknown-cause error risks operating on bad state.

## What "handled deliberately" means

Every catch block should be able to answer: *why is this being caught here, and what happens next?* Concretely:
- Catch as close to the point where you can actually do something useful about the error (retry, fallback, user message) — not at the outermost boundary "just in case," which usually means logging without enough context to act.
- If a catch block's only content is a log statement, ask whether the error should instead propagate to a boundary that can respond meaningfully (an API error handler, a top-level process handler) — logging without any recovery action is often better handled centrally than at every call site.
- Never catch a broader exception type than you're actually prepared to handle. Catching a generic `Exception`/`Error` to handle one specific expected failure (e.g. a parse error) will also silently swallow unrelated bugs that happen to occur in the same block.

## Custom error/exception types

- Define specific error types for the failure categories your domain actually has (e.g. `ValidationError`, `NotFoundError`, `ExternalServiceError`, `RateLimitError`) rather than raising/throwing generic errors or strings everywhere. Specific types let calling code handle different failures differently, and let a central error handler map each type to the right response.
- Include a machine-readable code/type on custom errors, separate from the human-readable message — the message can change wording without breaking code that branches on the error type.
- Don't create a new custom error type for every single call site — group by how callers actually need to react, not by every distinct failure reason.

## Try/catch scope

- Keep the scope of a try block as narrow as reasonably possible — wrapping an entire function body in one try/catch makes it unclear which specific line the error came from, and increases the chance of catching something unrelated to what was intended.
- For a sequence of operations where any one might fail, prefer handling each fallible step's error explicitly (or using a result/either-style pattern where the language supports it) over one broad catch around the whole sequence.

## Frontend-specific: error boundaries and UI failure states

- Wrap independent sections of the UI in error boundaries (or the framework's equivalent) so a failure in one component (e.g. a widget failing to render because of bad data) doesn't blank the entire page for the user.
- Every async operation that can fail (data fetch, form submission) needs an explicit UI failure state — a spinner that never resolves on error is a common miss. The user needs to see *something* changed, even if it's just "something went wrong, try again."
- Never render a raw error object, exception message, or stack trace directly in the UI — map it to a user-friendly message (see `user-facing-errors-and-observability.md` for the full pattern).

## Backend-specific: centralizing error-to-response mapping

- Use one central error-handling layer (middleware, global exception handler) that maps known error types to HTTP status codes and safe response bodies, rather than having every route handler build its own error response inline. This is what keeps the "safe error response" rule (Core Rule 3 in the main skill) consistently applied instead of relying on every developer remembering it at every call site.
- Anything that reaches the central handler as an *unrecognized* error type should be treated as a programmer error: return a generic 500-equivalent response, log full detail server-side, and alert — don't try to guess a more specific response for an error type the handler wasn't built to expect.

## Quick checklist before marking this done

- [ ] Each catch block has a clear reason for existing and a clear next action
- [ ] Operational errors are handled/recovered; programmer errors fail loud rather than being silently caught
- [ ] No catch block is broader than what it's actually prepared to handle
- [ ] Custom error types used for the domain's real failure categories, not generic throws everywhere
- [ ] Try/catch scope is as narrow as reasonably possible
- [ ] Frontend failure states are explicit — no infinite spinners, no raw error objects rendered
- [ ] Backend errors flow through a central handler that maps to safe, consistent responses
