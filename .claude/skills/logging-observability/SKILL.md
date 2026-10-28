---
name: logging-observability
description: Non-negotiable standards for logging, metrics, tracing, and health checks across all stacks — frontend, backend, and database/storage layers. Use this skill whenever writing a log statement, adding a metric or trace, creating or modifying a health check endpoint, setting up an alert, or integrating a logging/monitoring tool (Sentry, Datadog, CloudWatch, etc.) — even if the request doesn't mention "logging" or "observability" explicitly.
---

# Logging & Observability

These rules are mandatory, not suggestions. Logs and metrics are what make a production incident solvable in minutes instead of hours — but logging done carelessly is also one of the most common ways secrets and PII leak, so this skill is as much about *what never gets logged* as it is about what should.

## Core rules (always apply, every stack)

1. **All logs are structured** (JSON or an equivalent key-value format), never free-text string concatenation. Structured logs can be queried, filtered, and aggregated; string-concatenated logs can only be grepped and guessed at.
2. **Every log line includes a minimum standard set of fields:** timestamp (ISO 8601, UTC), log level, service/component name, and the correlation/request ID when one is available for that operation (see the Error Handling & Resilience skill for where correlation IDs originate).
3. **Log levels are used consistently and meaningfully:** DEBUG (verbose detail, dev/troubleshooting only), INFO (normal operational events), WARN (unexpected but recoverable), ERROR (an operation failed and needs attention), FATAL/CRITICAL (the system itself is compromised). Never log a routine success at WARN/ERROR, and never bury a genuine failure at DEBUG/INFO where no one will see it.
4. **Never log secrets, credentials, tokens, or full PII** — this applies at every log level, in every environment including local/dev, and even "temporarily, just to debug this one issue." There is no exception to this rule.
5. **Redact or mask sensitive fields at the logging layer itself** (a shared logger wrapper or middleware with a known list of sensitive field names), not by trusting every call site to remember to omit them individually.
6. **Production logging does not default to DEBUG level.** DEBUG-level logging is opted into deliberately and temporarily for active troubleshooting — it is not the standing default for a running production service.
7. **Never log inside a tight loop without rate-limiting or sampling.** Unbounded per-iteration logging floods storage, obscures the actual signal, and can itself become a resource-exhaustion problem.
8. **Every service exposes a health check that distinguishes "alive" from "ready."** Liveness (the process is running and responsive) and readiness (the instance can currently serve traffic — its critical dependencies are reachable) are different questions; collapsing them into one check causes false positives/negatives in whatever's orchestrating the service.
9. **Metric labels/tags must have bounded cardinality.** Never use a user ID, raw email, IP address, or a URL with unreplaced dynamic segments as a metric label — this silently breaks metrics backends at scale. High-cardinality detail belongs in logs or traces, not metric labels.
10. **Alerts are actionable and tied to a defined threshold, not raw noise.** An alert with no clear next action, or one that fires constantly for non-issues, trains people to ignore alerts — which defeats the point of having them.

## Secure defaults — include even if the request doesn't mention them

- **Never leave `console.log`/debug logging of sensitive data reachable in a production frontend build.** Anything logged to the browser console is visible to anyone with dev tools open — gate debug logging behind an environment check, and route real errors to a server-side/observability tool instead of leaving them in console output.
- **Don't log entire request/response objects wholesale "just in case."** They frequently contain auth headers, cookies, or PII. Log the specific fields actually needed for debugging, not the raw object.
- **New services get a health check endpoint from day one**, not bolted on reactively after an orchestration system already needed one.
- **Default log level in production is INFO or WARN, never DEBUG**, even if a framework's out-of-the-box default is more verbose — check and override it explicitly when scaffolding a new service.
- **Wire up correlation ID propagation by default for every new service/route**, not added reactively after the first incident that was hard to trace.
- **When integrating a new third-party logging/monitoring tool** (Sentry, Datadog, CloudWatch, etc.), configure PII/secret scrubbing *before* enabling it — not after data has already started flowing to a third party.
- **Don't surface raw stack traces to the end user's console or network tab.** Client-side error reporting should ship the detail to a server-side/observability endpoint, not leave it visible in the browser.

## What to do next

Match the task to a reference file and read it before writing the code:

| Task involves... | Read |
|---|---|
| Log format, levels, required fields, redaction of sensitive fields, frontend vs. backend logging specifics | `references/log-format-and-levels.md` |
| Metrics, distributed tracing, correlation ID propagation across services, cardinality | `references/metrics-and-tracing.md` |
| Health check endpoints, alert thresholds, avoiding alert fatigue, dashboards | `references/health-checks-and-alerting.md` |

If a task touches more than one row, read all that apply.

## When rules can't be followed

If a legacy system, third-party tool, or existing architecture makes one of these rules genuinely hard to follow, don't silently work around it — stop, tell the user which rule is in conflict and why, and let them decide how to proceed.

## Scope boundary

This skill covers how things get logged, measured, traced, and alerted on. It does NOT cover:
- Deciding whether a given error should be caught, retried, or degraded → **Error Handling & Resilience** skill (this skill covers what gets logged *once* that decision is made)
- What counts as PII/sensitive data in your domain, encryption, and retention → **Data Privacy & Compliance** skill (this skill restates the operational "don't log it" side, not the classification itself)
- Where secrets are stored and how they're rotated → **Secrets & Config Management** skill
- CI/CD pipeline logs and build monitoring → **CI/CD Conventions** skill

If a task spans into those areas, this skill's rules still apply — consult the relevant skill above for the rest.
