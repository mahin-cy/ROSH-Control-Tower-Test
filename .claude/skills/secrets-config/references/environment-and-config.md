# Environment Variables & Configuration

Read this whenever code reads environment variables, loads config files, sets up a new environment, or needs to distinguish what's safe to expose to the frontend versus what must stay server-side.

## Naming conventions

- Namespace variables consistently per service/app (e.g. a shared prefix) so config from different services doesn't collide when multiple apps share an environment.
- Use consistent casing (`UPPER_SNAKE_CASE` is the near-universal convention for env vars) — don't mix styles within the same project.
- Name the variable after what it *is*, not where it's used once — `DATABASE_URL` not `USER_SERVICE_DB_CONN_STRING_V2`, unless multiple distinct databases genuinely require disambiguation.

## Loading and precedence

- Establish one clear precedence order and document it — for example: explicit shell-exported env vars override `.env.local`, which overrides `.env.<environment>`, which overrides `.env` defaults. Whatever the order, it should be consistent and predictable, not accidental based on file load order in code.
- Load and validate config in one place at startup (a single config module), not scattered `process.env.X` / `os.environ.get(...)` calls throughout the codebase. Scattered access makes it impossible to validate everything up front and makes typos silently return `undefined`/`None` instead of failing.

## Fail-fast validation

At startup, validate:
- **Presence** — every required variable is set
- **Type/format** — a URL looks like a URL, a port is numeric and in range, a boolean-ish value is actually `true`/`false` not an arbitrary string
- **Referential sanity where cheap** — e.g. a URL's scheme matches what's expected (https vs http) before any network call is attempted

Prefer a schema-validation approach (a config schema checked once at boot) over ad hoc `if` checks scattered through the code. If validation fails, the app should exit with a clear message naming the missing/invalid variable — not proceed and fail confusingly three requests later.

## Per-environment strategy

- Keep environment-specific values in separate files or a separate secret-manager namespace per environment (dev/staging/prod), rather than one file with runtime branching logic like `if (env === 'prod') { ... } else { ... }` scattered through config loading — that pattern is fragile and easy to get wrong under time pressure.
- Shared, non-sensitive defaults can live in a common config file; environment-specific overrides layer on top per the precedence order above.
- Never let a "convenience" default silently point at a production resource. If a variable is unset, fail rather than falling back to a guessed value for anything that touches a real environment.

## Frontend build-time vs. backend runtime config — the most common leak point

This is where Core Rule 6 and the Secure Defaults in the main skill matter most in practice:

- **Backend/server-side config is never bundled into client code** — it's read at runtime, server-side only, and the browser never sees it.
- **Frontend build tools bake certain variables directly into the shipped JS bundle** at build time. Most frameworks require an explicit prefix (project-specific — check the framework in use) to mark a variable as safe for client exposure. Anything with that prefix is effectively **public**, extractable by anyone who opens dev tools, regardless of minification.
- Before adding any new frontend-exposed config value, ask: "would I be comfortable with this being visible in the page source?" If not, it doesn't get the client-exposure prefix — it stays server-side, and the frontend fetches whatever it needs through an authenticated API call instead.
- A common mistake: a developer needs a value client-side "just for now" during prototyping, gives it the public prefix to unblock themselves, and the secret ships to production. Treat any new client-exposed variable as a deliberate, reviewed decision, not a default.

## Config file organization

- Group config loading in a dedicated module/folder (e.g. `config/`) rather than spreading raw env var reads across business logic.
- For container/orchestration setups: use the platform's distinction between non-secret config (e.g. ConfigMaps) and secret values (e.g. Secrets objects) rather than putting everything in one undifferentiated bucket — see `secret-storage-and-access.md` for the secret side of this.
- Feature flags are config, not secrets — but avoid naming flags in a way that leaks internal roadmap/business logic if the flag list is ever exposed to the frontend (e.g. a flag literally named after an unannounced competitor-response feature).

## Quick checklist before marking this done

- [ ] New env vars follow the project's naming/casing convention
- [ ] Config is loaded and validated in one place, not scattered across the codebase
- [ ] Missing or malformed required config causes a fail-fast startup error, not a later runtime failure
- [ ] Environment-specific values are separated by environment, not branched inline
- [ ] No new frontend-exposed config value without a deliberate check that it's safe to be public
- [ ] Config loading module doesn't log the full resolved config (see Secure Defaults in main skill)
