# Authentication & Authorization

Read this whenever code touches login, sessions, tokens (JWT/OAuth/API keys), password handling, role/permission checks, or object-level access control.

Authentication answers "who is this?" Authorization answers "what are they allowed to do?" A codebase can get the first right and still be badly broken on the second — most of the checklist below is authorization, because that's where mistakes concentrate.

---

## Authentication

### Password handling
- Hash with a vetted, purpose-built algorithm (e.g. bcrypt, scrypt, argon2) — never a fast general-purpose hash (MD5, SHA-1, SHA-256 alone) and never plaintext.
- Enforce a minimum length (prefer length over forced complexity rules) even if the request doesn't specify a policy.
- Never include the password (or its hash) in logs, error messages, or API responses under any circumstance, including debug/dev modes.

### Login flow
- Rate-limit or lock out after repeated failed attempts, per account and per IP.
- Return a generic error ("invalid email or password") for both "user doesn't exist" and "wrong password" — distinguishing them enables account enumeration.
- Regenerate the session ID / issue a new token on successful login. Reusing a pre-login session ID after authentication enables session fixation.

### Session management
- Sessions need an expiration and an idle timeout, not just a hard expiry.
- Store session state server-side (or in a signed/encrypted token) — never trust a client-editable value (e.g. a plain cookie holding `user_id=123`) as proof of identity.
- Logout must actually invalidate the session/token server-side, not just delete the client-side copy — an intercepted token should stop working after logout.

### Token-based auth (JWT / API tokens)
- Validate the signature and algorithm explicitly on every request — reject tokens whose `alg` is `none` or that use a different algorithm than the one the server issues (algorithm-confusion attacks).
- Keep expiry short on access tokens; use a separate refresh token with its own rotation/revocation strategy rather than issuing long-lived access tokens for convenience.
- A JWT payload is base64-encoded, not encrypted — never put secrets, passwords, or sensitive PII in the payload.
- Prefer `HttpOnly` cookies over `localStorage`/`sessionStorage` for storing tokens on the frontend when XSS is a realistic risk — a token in `localStorage` is readable by any injected script.

### OAuth / SSO flows
- Validate the `state` parameter on the callback to prevent CSRF on the login flow.
- Validate `redirect_uri` against an exact allowlist server-side — don't accept a partial match or a client-supplied redirect target at face value.
- Use PKCE for any public client (SPA, mobile) that can't securely hold a client secret.

### Account recovery
- Password-reset and email-verification tokens must be single-use, expiring, and unguessable (generated via a CSPRNG, not a sequential or predictable value).
- Don't reveal whether an email/account exists in the recovery flow's response or timing.
- Invalidate all existing sessions when a password is changed or reset.

### Multi-factor authentication
- If MFA is implemented, the second factor must be enforced server-side as a required step in the auth flow — not just checked and skippable on the client.

---

## Authorization

### Object-level access control (the most commonly missed check)
- Authentication ("is this a valid logged-in user?") is not authorization ("can *this* user access *this specific* resource?"). Every endpoint that reads or mutates a specific object by ID must check that the requesting user owns it or has an explicit grant — otherwise it's an IDOR (insecure direct object reference).
- This check belongs on the server for every request, even if the UI never exposes a way to reach another user's ID — IDs are guessable/enumerable and the API is reachable directly.

### Centralize permission logic
- Prefer a single, centralized authorization layer (middleware, policy module, or framework guard) over scattering ad hoc `if user.role == 'admin'` checks across handlers — scattered checks are the ones that get forgotten on a new endpoint.
- When adding a new endpoint, the default should be "no access" until a permission check is explicitly added — not "accessible" until someone remembers to lock it down.

### Role/permission design
- Follow least privilege: grant the narrowest role/scope that lets the feature work, not the broadest convenient one.
- For any RBAC/ABAC system, validate role/permission checks against data the server controls (session, DB record) — never trust a role or permission claim sent from the client in a request body or header.

### Multi-tenancy
- Every query in a multi-tenant system must be scoped by tenant/organization ID from the authenticated session — never from a client-supplied tenant ID alone. Cross-check the client-supplied value against the session's tenant if both are present.

### Privileged / high-risk actions
- Actions with outsized impact (deleting an account, changing billing, granting admin, exporting bulk data) should require a fresh/step-up authentication check even within an already-authenticated session, and should be logged for audit (see Logging & Observability skill).

### Service-to-service authorization
- Internal services should authenticate to each other (mTLS, signed requests, or scoped API keys) rather than trusting network location alone ("it's inside the VPC" is not an authorization control).
- Scope API keys/service credentials to the minimum set of operations they need — avoid a single all-access internal key shared across services.

---

## Quick checklist before marking this done

- [ ] Passwords hashed with a vetted algorithm, never logged
- [ ] Login errors don't reveal whether the account exists
- [ ] Session ID/token regenerated on login; invalidated on logout
- [ ] Tokens validated for signature + algorithm; short-lived access tokens
- [ ] OAuth `state` validated; `redirect_uri` allowlisted; PKCE used for public clients
- [ ] Password reset tokens are single-use, expiring, and unguessable
- [ ] Every object-level read/write checks ownership or explicit grant, server-side
- [ ] New endpoints default to "no access" until a permission check is added
- [ ] No role/permission/tenant ID trusted from client input alone
- [ ] High-impact actions have step-up checks and are logged
