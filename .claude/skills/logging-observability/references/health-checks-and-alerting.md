# Health Checks & Alerting

Read this whenever code creates or modifies a health check endpoint, or defines an alert/threshold for monitoring a service.

## Liveness vs. readiness — two different questions

- **Liveness** answers: "is this process running and responsive at all?" It should be a minimal, fast check — confirm the process can respond, nothing more. If liveness fails, the orchestrator's usual response is to restart the process, so this check should only fail for conditions a restart would actually fix.
- **Readiness** answers: "can this specific instance currently serve traffic?" This check can verify critical dependencies are reachable (e.g. the database connection is up) — if readiness fails, the orchestrator stops routing traffic to this instance but doesn't necessarily restart it.
- Expose these as separate endpoints. Collapsing them into one check causes two different failure modes: a transient dependency hiccup gets treated as "the process is broken" (unnecessary restarts), or a genuinely dead process keeps receiving traffic because the check never verified true liveness.

## What a health check should (and shouldn't) verify

- Liveness: keep it minimal. Don't check downstream dependencies here — a slow/unavailable dependency shouldn't make the orchestrator think the process itself is dead.
- Readiness: check the dependencies this instance genuinely can't function without (primary database, required cache). Avoid making readiness fail because of a *non-critical* dependency being unavailable — that turns one struggling non-critical dependency into a full outage of an otherwise-healthy service (ties to the graceful-degradation principle in the Error Handling & Resilience skill).
- Keep the check itself fast and lightweight — a health check that's expensive to compute can become a bottleneck or, under load, can itself cause the cascading failure it was meant to help detect.

## Alerting

- Define alerts against thresholds tied to actual user impact — error rate over a time window, latency at a meaningful percentile (e.g. p95/p99, not just average), saturation of a critical resource — rather than alerting on any single raw occurrence of an error.
- Every alert should have a clear answer to "what does the person receiving this alert actually do next?" An alert with no defined next action, or one that just says "something happened" without indicating severity or a starting point for investigation, trains people to skim past it.
- Reserve alerting for genuine anomalies or SLO breaches. Routine, expected operational errors (a validation failure from bad user input, a rate limit correctly rejecting excess traffic) generally shouldn't page anyone — see the Error Handling & Resilience skill's distinction between operational and programmer errors for the same logic applied to alerting: alert on the unexpected, not the routine.

## Avoiding alert fatigue

- Prefer rate/threshold-based alerts ("error rate exceeded 5% over 5 minutes") over alerting on any single failure, except for the small set of events that genuinely warrant an immediate page on their own (e.g. the service is completely down, a security-relevant single event).
- Periodically review which alerts have fired and whether each firing led to real action — an alert that consistently fires without anyone needing to do anything is a signal to raise its threshold or remove it, not a signal to keep it as-is "just in case."
- A system with too many alerts is often functionally worse than one with too few, because real signals get lost in the noise. When adding a new alert, ask whether an existing one already covers the same underlying condition before adding another.

## Dashboards

- Each service should have a baseline dashboard surfacing its RED/USE metrics (see `metrics-and-tracing.md`) so its health can be assessed at a glance, without needing to query raw logs as a first step.
- Dashboards and alerts should be built from the same underlying metrics where possible — if a dashboard shows a problem that no alert would have caught, that's a gap worth closing.

## Quick checklist before marking this done

- [ ] Liveness and readiness are separate endpoints, not one combined check
- [ ] Liveness stays minimal; readiness checks only genuinely critical dependencies
- [ ] The health check itself is fast and won't become a bottleneck under load
- [ ] New alerts are threshold/rate-based, not firing on every single occurrence, unless the event genuinely warrants an immediate page
- [ ] Every alert has a clear "what happens next" for whoever receives it
- [ ] A new service has a baseline dashboard showing its core metrics
