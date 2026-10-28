# Secret Rotation & Incident Response

Read this whenever a task involves rotating a credential on a schedule, responding to a secret that may have leaked or been exposed, or revoking access when a person or service no longer needs it.

## Rotation as a default, not an exception

- Every secret type should have a rotation expectation, even without a compliance mandate driving it — "rotate never" should not be the default for any credential. Long-lived API keys and database credentials are the ones most often left unrotated indefinitely; call this out explicitly if a new long-lived credential is being introduced with no rotation plan.
- Prefer secret managers with built-in automated rotation over manual rotation runbooks wherever the service supports it — a manual process that depends on someone remembering to run it tends not to happen.

## Rotating without downtime

- Design for a brief window where both the old and new credential are valid, rather than requiring an instantaneous cutover synchronized across every consumer of that secret. Many secret managers and auth providers support this natively (e.g. issuing a new key version while the old one remains valid for a grace period).
- If a service's architecture makes overlapping validity impossible (only one active credential can exist at a time), flag this as an architectural gap — it means every rotation requires a fully coordinated deploy, which increases the temptation to skip rotation entirely.

## Offboarding and decommissioning

- When a team member leaves, or their role changes such that they no longer need an access grant: revoke/rotate every credential they had direct access to (personal API tokens, direct database credentials, cloud console access) — don't rely on account deactivation alone if the credential itself remains valid independently.
- When a service or integration is decommissioned, revoke its credentials as part of the decommissioning steps, not as an afterthought discovered during a later audit.

## Responding to a leaked or exposed secret

If a secret is discovered in a place it shouldn't be (committed to git, printed in a log, shared insecurely, pasted somewhere public), treat it as compromised immediately:

1. **Revoke or rotate the credential right away** — don't wait for a "convenient" deploy window. A live but temporarily-inconvenient outage from rotating immediately is preferable to a known-exposed credential remaining active.
2. **Audit access/usage logs** for the period the secret was exposed, to the extent the service provides them, to check for unexpected use.
3. **Determine blast radius** — what could this specific credential access, and does anything downstream need review as a result (data it could read, actions it could take).
4. **Notify affected stakeholders** per the project's incident process, even if the immediate technical fix (rotation) is already done — visibility matters for anyone else who might be affected or need to take follow-up action.

## Git history leaks specifically

- A secret committed to git is not remediated by removing it in a later commit — it remains recoverable from history (including in forks, local clones, and CI caches that may have pulled it) for as long as that history exists.
- Once a secret has touched git history at any point, treat it as compromised and rotate it, regardless of whether history was later rewritten/scrubbed. History-rewriting can reduce future exposure but does not un-expose a secret that was already committed and potentially pulled elsewhere.

## Quick checklist before marking this done

- [ ] New long-lived credentials have an explicit rotation expectation, not "rotate never" by default
- [ ] Rotation approach supports an overlap window where feasible, to avoid forced synchronized deploys
- [ ] Offboarding steps include revoking/rotating credentials the departing person/service had access to
- [ ] Any secret found exposed is rotated immediately, not scheduled for later
- [ ] A secret that ever touched git history is treated as compromised and rotated, even if later removed
