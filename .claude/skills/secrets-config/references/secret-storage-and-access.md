# Secret Storage & Access

Read this whenever code needs to know *where* a secret actually lives — local development, CI/CD, staging, or production — or whenever a new service, developer, or pipeline needs access to an existing secret.

## Local development

- Local secrets live in a gitignored file (e.g. `.env.local`) populated from a team-shared source of truth (a secret manager entry, a password manager shared vault) — never copy-pasted through chat, email, or shared documents.
- Prefer scoped-down, dev-only credentials for local work wherever the third-party service supports it, rather than reusing a broader production-capable credential locally "for convenience."
- If a local `.env` file is ever accidentally staged for commit, treat the secret as compromised once it touches git history — see the rotation reference file, "Git history leaks" section — a local `git reset` before push does not fully mitigate this if it was ever committed at any point, including in a branch.

## Staging and production

- Use a dedicated secret manager appropriate to the hosting platform (cloud-provider secret manager, HashiCorp Vault, or a Kubernetes-native approach like sealed-secrets/external-secrets-operator) rather than manually set plaintext env vars on a server — manual env vars are acceptable for a genuine throwaway prototype only, and should be called out as such if used.
- Prefer short-lived, dynamically-issued credentials (e.g. cloud IAM roles assumed at runtime) over long-lived static keys wherever the platform supports it — a credential that expires on its own limits the damage of an undetected leak.
- Secrets should be injected into the running process at deploy/start time (env var injection from the secret manager, or a mounted secret volume), not baked into the deployed artifact itself.

## CI/CD

- Use the CI/CD platform's built-in encrypted/masked secret storage (e.g. platform-native pipeline secrets/variables marked protected and masked) — never plaintext secrets committed in pipeline YAML, shell scripts, or Dockerfiles used by the pipeline.
- Confirm the platform masks the secret in logs/output by default for the variable type used; if it doesn't, explicitly avoid echoing or printing the value anywhere in pipeline steps, including in error messages or debug output.
- Scope pipeline secrets to the specific job/stage that needs them where the platform allows it, rather than exposing every secret to every step by default.

## Access control

- Apply least privilege to secret access itself: a service or CI job should be able to read only the specific secrets it needs, not the entire secret store.
- Avoid a single shared "god" credential used by multiple services — if one service is compromised, a shared credential extends the blast radius to everything else using it. Prefer per-service credentials even if it's more setup effort.
- Audit who/what has access to each secret periodically, not just at creation time — access tends to accumulate (a service that no longer needs a credential often keeps it).

## Frontend/browser exposure

- Restating this because it's the most common miss: any value present in client-side JavaScript is fully public and extractable by anyone, regardless of minification, obfuscation, or "it's not linked from the UI." There is no safe way to ship a secret to the browser.
- If a frontend genuinely needs to call a third-party service directly, use a public-safe credential type designed for client exposure (e.g. a publishable/public key with restricted scope, not the corresponding secret key), or proxy the call through your own backend, which holds the real credential server-side.

## File-based secrets

- Private keys, TLS certificates, and service-account credential files get the same treatment as string secrets: excluded from git, stored in the secret manager or a mounted volume at deploy time, never committed "temporarily."
- Treat a full database/service connection string as a single secret unit, even though it's structured — the presence of a password inside a URL string is easy to overlook in a review if only the obviously-named fields are checked.

## Quick checklist before marking this done

- [ ] No secret value is present anywhere in the git history, including old commits/branches
- [ ] Local dev uses scoped-down credentials where the service supports it
- [ ] Staging/prod secrets come from a secret manager, not manually set plaintext env vars (or the throwaway-prototype exception is explicitly flagged)
- [ ] CI/CD secrets use the platform's masked secret storage, never plaintext in pipeline files
- [ ] No shared "god" credential where per-service credentials are feasible
- [ ] No secret, of any kind, present in frontend/client-side code
- [ ] File-based secrets (keys, certs, service-account JSON) excluded from git and stored like any other secret
