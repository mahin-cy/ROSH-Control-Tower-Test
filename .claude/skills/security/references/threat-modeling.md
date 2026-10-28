# Threat Modeling

Read this whenever a task introduces a new feature, endpoint, integration, user role, or data flow — not every code change needs a threat model, but the triggers below should not be skipped just because the request didn't ask for one.

## When a threat model is required

Treat any of the following as a trigger, regardless of how the task was phrased:

- A new externally-reachable endpoint or API (including internal-facing APIs reachable from a browser or third party)
- A new user role or permission tier, or a change to an existing one
- A new integration with a third-party service that receives or sends data (webhooks, external APIs, SSO providers)
- A new data flow that stores, transmits, or logs PII, credentials, or other sensitive data
- Any change to the authentication or authorization mechanism itself (not just a new endpoint using the existing mechanism)
- A file upload/processing pipeline, especially one that parses untrusted file formats
- A feature that exposes previously-internal data to external clients (new export, new public API, new admin-to-user data path)
- Any payment or financial data flow
- Any change to the encryption/crypto approach in use

If none of these apply, a full threat model isn't needed — the Core rules and Secure Defaults in the main Security skill, plus the relevant reference file, are sufficient.

## Lightweight process (STRIDE-lite)

This doesn't need to be a heavyweight document. For most features, working through this in a few minutes and capturing the output in the PR description or a short doc is enough:

1. **Describe the data flow.** What data moves, from where to where, and what stores it along the way? A short bullet list is fine — it doesn't need a diagram unless the flow is genuinely complex.
2. **Mark the trust boundaries.** Where does the data cross from one trust level to another — client to server, service to service, your system to a third party, user to admin?
3. **Walk each boundary crossing through STRIDE** and note anything that applies (skip categories that clearly don't apply rather than forcing an answer):
   - **S**poofing — can someone impersonate a legitimate user/service at this boundary?
   - **T**ampering — can data be modified in transit or at rest without detection?
   - **R**epudiation — can an action happen without an auditable record of who did it?
   - **I**nformation disclosure — can data leak to someone who shouldn't see it?
   - **D**enial of service — can this flow be abused to exhaust resources?
   - **E**levation of privilege — can this flow be used to gain access beyond what was granted?
4. **Note mitigations** for anything identified — a mitigation can be "already covered by [existing control]" if the Core Rules or reference files already handle it; it doesn't need to be novel.
5. **Flag residual risk explicitly** if something is identified but not mitigated (e.g. deferred to a later iteration) — an unmitigated risk that's silently dropped is worse than one that's written down and accepted knowingly by the user.

## Minimal template

```
## Threat model: <feature name>

**Data flow:**
- <what moves, from where to where>

**Trust boundaries crossed:**
- <boundary 1>
- <boundary 2>

**STRIDE notes:**
| Category | Applies? | Notes / mitigation |
|---|---|---|
| Spoofing | | |
| Tampering | | |
| Repudiation | | |
| Info disclosure | | |
| Denial of service | | |
| Elevation of privilege | | |

**Residual risk accepted:** <anything left unmitigated, and by whom>
```

## When to escalate beyond this lightweight process

Bring in a full/formal security review (not just this lightweight pass) when the feature involves:
- Payment card data or other regulated financial data
- Health data or other data under a specific regulatory regime (see Data Privacy & Compliance skill)
- A fundamental change to the authentication architecture itself (e.g. switching session strategy, introducing a new identity provider)
- Any custom cryptographic design (which, per Core Rule 4, should be avoided in favor of vetted libraries in the first place — this case should be rare)

For everything else, the lightweight process above is sufficient — don't let "this needs a threat model" become a reason to skip doing one at all because it feels too heavyweight for the task at hand.

## Quick checklist before marking this done

- [ ] Checked this change against the trigger list above
- [ ] Data flow and trust boundaries identified
- [ ] STRIDE walked for each boundary, even briefly
- [ ] Mitigations noted, or existing controls referenced
- [ ] Any residual risk written down and surfaced to the user, not silently dropped
