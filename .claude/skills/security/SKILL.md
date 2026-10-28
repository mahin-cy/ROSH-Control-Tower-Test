---
name: security
description: Non-negotiable security standards for all code in this codebase — frontend, backend, and database/storage layers. Use this skill whenever writing, reviewing, or modifying code that handles user input, authentication, authorization, session or token management, database queries, file uploads/downloads, external API calls, redirects, or deserialization, or any data crossing a trust boundary. Also trigger when creating a new API endpoint, form, database query, file handler, or third-party integration, even if the request doesn't mention "security" explicitly.
---

# Security Standards

These rules are mandatory, not suggestions. If a rule below conflicts with a request for speed, convenience, or "just make it work," the rule wins. Flag the conflict to the user instead of silently skipping the rule — see "When rules can't be followed" at the end.

## Core rules (always apply, every stack)

1. **Never trust input.** Every value that originates outside the current process — user input, query params, headers, cookies, file contents, third-party API responses — MUST be validated and/or sanitized before use, at the point of use, not just at the entry boundary.
2. **Never build queries, commands, or markup by string concatenation or interpolation with untrusted data.** Use parameterized queries, prepared statements, ORM query builders, or framework-provided escaping. Applies to SQL, shell commands, HTML/templates, and file paths.
3. **Every endpoint, route, or function that returns or mutates data MUST have an explicit authorization check** — not just an authentication check. "Logged in" is not "allowed to access this resource." Check ownership/role on every object-level operation (no IDOR).
4. **Never write custom crypto, hashing, or token generation.** Use vetted library/framework functions for password hashing and token generation. No home-rolled encryption, no `Math.random()` (or equivalent) for anything security-relevant.
5. **Never log, cache, hardcode, or embed secrets, tokens, passwords, or full PII** in code, logs, error messages, URLs, or client-visible responses. (Full detail lives in the Secrets & Config Management skill — this rule is the security-side restatement of it.)
6. **Fail closed.** If an auth check, validation step, or permission lookup errors or is ambiguous, deny access. Never default to allow on failure.
7. **Every file upload/download path MUST validate file type, size, and destination**, and MUST NOT trust a client-supplied filename or path for filesystem operations (path traversal).
8. **Every redirect or forward built from a user-supplied URL MUST be checked against an allowlist** (open redirect prevention).
9. **Deserialize only trusted, schema-validated data.** Deserializing arbitrary/untrusted payloads into native objects without a schema is banned outright (unsafe pickle, unchecked YAML load, native unserialize, etc.).
10. **New dependencies touching auth, crypto, input parsing, or data storage need a note in the PR description.** Vetting/versioning rules live in the Dependency Management skill.

## Secure defaults — include even if the request doesn't mention them

Junior developers prompting this agent often don't know to ask for these by name. Apply them automatically wherever the corresponding code is being generated — don't wait to be asked, and don't treat their absence from the prompt as permission to skip them.

- **Cookies:** set `HttpOnly`, `Secure`, and `SameSite=Strict` (or `Lax` only if a cross-site flow genuinely requires it) on any session or auth cookie, by default.
- **CORS:** never default to `Access-Control-Allow-Origin: *`, especially combined with credentials. Use an explicit origin allowlist even in scaffolding/demo code.
- **Error handling in production paths:** never return stack traces, DB errors, internal file paths, or raw exception messages to the client. Log detail server-side; return a generic message to the user.
- **TLS:** never generate code that disables certificate validation (`verify=False`, `rejectUnauthorized: false`, etc.) or downgrades to plain HTTP, even "for local testing." If a dev-only exception is genuinely needed, gate it behind an explicit flag and say so out loud rather than leaving it silent.
- **Security headers:** set `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (or CSP `frame-ancestors`), and `Strict-Transport-Security` on HTTP server responses by default.
- **CSRF protection:** any state-changing endpoint (POST/PUT/PATCH/DELETE) reachable from a browser session needs CSRF protection (token or `SameSite` cookie strategy), unless it's a pure token-auth API with no cookie-based session.
- **Rate limiting on auth surfaces:** login, signup, password-reset, and OTP/verification endpoints need basic rate limiting or lockout by default. This is one of the most commonly skipped checks in scaffolded auth code.
- **Client-side validation is never sufficient.** If frontend code validates a form, the same validation MUST be re-implemented server-side. Never treat frontend validation as the security boundary, even in a quick prototype.
- **No default, example, or test credentials** in seed scripts, docker-compose files, `.env.example`, or fixtures that could plausibly get copied into a real environment. If placeholder credentials are generated at all, mark them clearly (`CHANGE_ME`) and call this out to the user.
- **Sensitive files must not be servable.** `.env`, `.git`, config files, and backups must be excluded from the web server's static-file root and added to `.gitignore` by default — a very common miss in scaffolded projects.
- **Passwords:** never store or transmit in plaintext; enforce a minimum length/complexity policy even if the user didn't specify one, and use a vetted hashing function (see Core Rule 4).

## What to do next

Match the task to a reference file and read it before writing the code — these are the areas where mistakes concentrate, so don't rely on memory for the specifics.

| Task involves... | Read |
|---|---|
| User input, forms, query params, file content, template rendering, DB queries, shell/system calls, file paths | `references/injection-and-input-validation.md` |
| Login, sessions, tokens (JWT/OAuth/API keys), password handling, role/permission checks, object-level access control | `references/authn-authz.md` |
| A new feature, endpoint, integration, or any change to how data flows across a trust boundary (new user role, new external API, new data export) | `references/threat-modeling.md` |

If a task touches more than one row, read all that apply — don't stop at the first match.

## When rules can't be followed

If following a rule above would break the task as requested (e.g. a legacy system that can't support parameterized queries), do not silently work around it. Stop, tell the user which rule is in conflict and why, and let them decide how to proceed. Never weaken a rule to "make it work" without that conversation happening first.

## Scope boundary

This skill covers injection/input handling, authn/authz, and threat-modeling triggers. It does NOT cover:
- Secrets and credential storage → **Secrets & Config Management** skill
- PII classification, encryption-at-rest, data retention → **Data Privacy & Compliance** skill
- Dependency vetting/versioning → **Dependency Management** skill
- What gets logged and how → **Logging & Observability** skill

If a task spans into those areas, this skill's rules still apply — consult the relevant skill above for the rest.
