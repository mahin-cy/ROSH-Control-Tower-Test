---
name: secrets-config
description: Non-negotiable standards for handling secrets, credentials, and configuration across all stacks — frontend, backend, database, CI/CD, and infrastructure. Use this skill whenever writing or modifying code that reads environment variables, connects to a database or third-party service, creates or edits a config/.env file, adds a new API key or credential, sets up a new environment (dev/staging/prod), writes CI/CD pipeline config, or builds a Docker/deployment configuration — even if the request doesn't mention "secrets" or "security" explicitly.
---

# Secrets & Config Management

These rules are mandatory, not suggestions. A "just to get it working" hardcoded key or committed `.env` file is the single most common way secrets leak — treat shortcuts here as incidents waiting to happen, not minor style issues.

## Core rules (always apply, every stack)

1. **Never hardcode secrets** — API keys, tokens, passwords, connection strings, certificates, private keys — directly in source code, committed config files, or comments. Always load them from environment variables or a dedicated secret manager.
2. **Every repo MUST exclude real secret files from version control** (`.env`, `.env.local`, `*.pem`, `*.key`, service-account JSON, etc.) via `.gitignore` or equivalent, verified before the first commit of any new project or service.
3. **Provide a placeholder example file** (`.env.example` or equivalent) listing every required config/secret name with a dummy value — never a real one. This is how teammates discover what's needed without exposing anything.
4. **Validate config at startup and fail fast.** The app should refuse to start with a clear error if a required secret or config value is missing or malformed — not fail later with a cryptic runtime error somewhere downstream.
5. **Config and secrets are not the same thing.** Non-sensitive config (feature flags, timeouts, public URLs) can live in version-controlled files. Secrets (credentials, keys, tokens) never can, even in a private repo.
6. **Frontend/client-side bundles must never contain secrets.** Anything shipped to the browser is public. Build-time env var inlining (e.g. framework-specific "public" variable prefixes) is a leak vector that needs explicit review, not a default convenience.
7. **Different environments use different secrets.** Never reuse a production credential in dev/staging, and never let a lower-environment credential have access to production resources.
8. **Secrets must be rotatable without a code deployment.** If rotating a credential requires a code change and redeploy, the architecture needs fixing — flag this rather than accepting it as normal.
9. **Access to secrets follows least privilege.** A service or role should be able to read only the secrets it actually needs, never every secret in the store by default.
10. **CI/CD pipelines use the platform's secret injection mechanism** (masked/encrypted pipeline secrets), never plaintext secrets committed in pipeline YAML or shell scripts.

## Secure defaults — include even if the request doesn't mention them

- **`.env` goes into `.gitignore` the moment it's created** — don't wait to be asked, and don't generate a `.env` without also checking `.gitignore` covers it.
- **Generate `.env.example` alongside any new `.env`**, with placeholder values, so the pattern from Core Rule 3 is never skipped.
- **Never write a "temporary" hardcoded key "just to test it."** If a task seems to need this, say so and provide the env-var-based alternative instead.
- **Know your framework's public-variable prefix** (e.g. variables prefixed for client-bundle exposure) and never place a secret behind one — anything with that prefix ships to the browser regardless of how it's used.
- **Don't bake secrets into Docker image layers.** `ARG`/`ENV` values in a Dockerfile persist in image history even if unset later. Use runtime injection or mounted secrets instead.
- **Never log a full config/env object at startup** — it likely includes secrets. Redact sensitive keys before any startup or debug log.
- **Flag default credentials from scaffolding tools** (default DB passwords, default admin accounts) as must-change-before-real-use, don't leave them silently in place.
- **Treat an entire connection string as a secret**, not just the password portion — `postgres://user:pass@host` needs the same handling as a raw API key.

## What to do next

Match the task to a reference file and read it before writing the code:

| Task involves... | Read |
|---|---|
| Env var conventions, config loading/validation, per-environment (dev/staging/prod) setup, frontend build-time vs. backend runtime config | `references/environment-and-config.md` |
| Where secrets actually live (vault/secret manager), local dev secrets, CI/CD secret injection, frontend exposure prevention | `references/secret-storage-and-access.md` |
| Rotating a credential, responding to a leaked/exposed secret, revoking access on offboarding or service decommission | `references/secret-rotation-and-incident-response.md` |

If a task touches more than one row, read all that apply.

## When rules can't be followed

If a legacy system, third-party tool, or existing architecture makes one of these rules genuinely hard to follow, don't silently work around it — stop and tell the user which rule is in conflict and why, and let them decide how to proceed.

## Scope boundary

This skill covers how secrets and config are handled operationally — storage, access, rotation, environment separation. It does NOT cover:
- The general "never expose secrets in logs/errors/responses" security principle → **Security** skill (Core Rule 5 there points back here for detail)
- PII classification, encryption-at-rest, data retention → **Data Privacy & Compliance** skill
- Vetting/pinning the third-party packages that might handle secrets → **Dependency Management** skill

If a task spans into those areas, this skill's rules still apply — consult the relevant skill above for the rest.
