# Metrics & Tracing

Read this whenever code emits a metric, participates in a distributed trace, or needs to propagate a correlation ID across service calls.

## Baseline metrics — the RED method

For any service handling requests (API, worker consuming a queue, etc.), emit at minimum:
- **R**ate — how many requests/operations per unit time
- **E**rrors — how many of those failed
- **D**uration — how long they took (track as a distribution/percentiles, not just an average — averages hide the slow-tail requests that actually hurt users)

This baseline set, consistently emitted across every service, is what makes a system's overall health assessable from a dashboard without needing to grep logs first.

## Baseline metrics — the USE method (for underlying resources)

For infrastructure-level resources (a connection pool, a queue, a cache, a worker pool), track:
- **U**tilization — how busy/full it currently is
- **S**aturation — how much work is queued/waiting beyond current capacity
- **E**rrors — resource-level errors (connection failures, eviction due to memory pressure, etc.)

## Cardinality — the most common metrics mistake

- Metric labels/tags must be **bounded** — a fixed, small set of possible values. Good label examples: HTTP method, status code, a route *template* (`/users/:id`, not `/users/12345`), environment name, service name.
- Never use as a label: user ID, email, raw IP address, a full URL with unreplaced dynamic segments, or any other value with effectively unbounded distinct values. Each distinct label-value combination creates a new time series in most metrics backends — an unbounded label can silently create millions of series and degrade or break the metrics system entirely.
- If you need to correlate a metric spike with a specific user or request, that's what logs and traces (with their own correlation ID) are for — not metric labels, which have a fundamentally different scaling model.

## Distributed tracing

- Propagate a trace/correlation ID across every service call involved in handling a single request or operation — this is the same ID introduced in the Error Handling & Resilience skill, generated at the entry point and carried through every downstream call.
- Prefer a standard tracing context format (e.g. W3C Trace Context, or whatever your tracing tool's SDK provides) over a custom ad hoc header, so tracing works automatically across libraries and services that already understand the standard format, rather than needing custom glue code at every boundary.
- Name spans consistently (e.g. `service.operation`, like `orders-api.create_order`) and attach attributes that help identify what happened (route, status, key non-sensitive parameters) — but the "never log secrets/PII" rule from the main skill applies to span attributes exactly as it applies to log lines.

## Sampling

- Capturing full trace detail for 100% of traffic isn't always feasible or cost-effective at scale. A common approach: sample a percentage of successful requests, but always capture full trace detail for errors and for anything above a latency threshold worth investigating.
- Whatever sampling strategy is used, make sure the correlation ID itself is still generated and logged for every request even when the full trace isn't sampled — losing the ability to search logs by correlation ID for an unsampled request removes your only way to investigate it after the fact.

## Frontend-specific: real user monitoring

- If client-side performance/error monitoring is in use, the same rules apply: no PII or secrets in captured events, bounded-cardinality tags/labels, and correlation IDs propagated to backend calls so a frontend issue can be traced into the backend logs handling the same request.

## Quick checklist before marking this done

- [ ] New services emit at least Rate, Errors, and Duration (as a distribution, not just an average)
- [ ] No metric label/tag has unbounded cardinality (no raw user ID, email, IP, or un-templated URL)
- [ ] Correlation/trace ID is generated at the entry point and propagated to every downstream call
- [ ] Trace context uses a standard format where the tooling supports it, not a custom ad hoc header
- [ ] Span/trace attributes follow the same no-secrets/no-PII rule as logs
- [ ] Sampling strategy (if used) still logs a correlation ID for every request, sampled or not
