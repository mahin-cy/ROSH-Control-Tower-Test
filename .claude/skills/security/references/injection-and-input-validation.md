# Injection & Input Validation

Read this whenever code touches user input, query params, file content, template rendering, database queries, shell/system calls, file paths, or outbound HTTP requests built from user-supplied values.

## General principle

Every trust boundary crossing needs a check at the point of use, not just at entry:
- **Allowlist over denylist.** Define what's valid (format, type, length, range, character set) rather than trying to block what's bad — denylists are always incomplete.
- **Validate on the way in, encode on the way out.** Validation confirms the data is well-formed; output encoding is a *separate* step applied based on where the data lands (HTML body, HTML attribute, JS string, SQL, shell, URL, filesystem path). The same string may need different encoding in different destinations.
- **Never assume the frontend's validation ran.** Every check below applies server-side regardless of what the client already checked.

---

## SQL / query injection (backend, database layer)

- Use parameterized queries or prepared statements for every query with a dynamic value. Never build a query by concatenating or f-string/template-interpolating user input into SQL text.
- ORM query builders are safe by default for values, but **raw query escape hatches (`.raw()`, `.exec_raw()`, string-built `WHERE` clauses) are not** — treat any raw SQL string in the codebase as a red flag requiring the same parameterization rules.
- Dynamic table names, column names, or `ORDER BY` clauses can't be parameterized the normal way — validate them against a hardcoded allowlist of known-safe identifiers, never pass the user's string straight through.
- NoSQL stores (Mongo-style) are not immune: never pass a raw request body/object directly into a query filter — an attacker can inject operators (e.g. `$where`, `$gt`) instead of a plain value. Validate the shape and types of query filters explicitly.

## Cross-site scripting — XSS (frontend, and any backend that renders HTML)

- Encode output based on context: HTML body encoding, HTML attribute encoding, JS string encoding, and URL encoding are different operations — use the framework's context-aware encoding rather than a single generic "escape" function.
- Avoid `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, or equivalent raw-HTML-injection APIs for anything derived from user input. If rich text must be rendered, sanitize it through a vetted library (e.g. DOMPurify) with an explicit allowlist of tags/attributes — never a homemade regex stripper.
- Treat data coming back from your own backend/API as untrusted too if it originated from another user's input (stored XSS) — the encoding rule applies at render time, not just at the point of storage.
- Set a `Content-Security-Policy` as defense in depth (see Secure Defaults in the main skill) — it doesn't replace output encoding, it limits blast radius if encoding is missed somewhere.

## Command injection (backend)

- Never build a shell command by concatenating user input into a string. Use APIs that accept an argument array and do not invoke a shell (avoid `shell=True` / `exec("... " + input)` patterns).
- If a shell is unavoidable, allowlist the specific command and validate every argument against a strict pattern before passing it.
- Treat `eval`, `exec`, `Function()` constructors, and dynamic code-loading from user input as banned outright — there's no safe way to sanitize into these.

## Path traversal (backend, file storage)

- Never build a filesystem path by directly joining user input onto a base directory without normalization.
- Resolve the final path and verify it still falls inside the intended base directory before any read/write/delete — reject anything that resolves outside it (catches `../`, encoded traversal, symlink tricks).
- Reject null bytes and unexpected path separators in filenames outright.

## Server-side request forgery — SSRF (backend)

- Any feature that fetches a URL supplied or influenced by the user (webhooks, "import from URL," link previews, image proxies) needs an outbound allowlist or, at minimum, a blocklist of internal/private IP ranges (loopback, link-local, RFC1918, cloud metadata endpoints like `169.254.169.254`).
- Don't blindly follow redirects on server-initiated requests — a validated URL can redirect to an internal address. Either disable redirect-following or re-validate the destination after each hop.
- Resolve DNS and validate the resolved IP, not just the hostname string — DNS rebinding can point a validated hostname at an internal IP after the check.

## Insecure deserialization (backend)

- Never deserialize an untrusted payload directly into native objects without a schema. This includes unsafe `pickle` loads, default (non-safe) YAML loaders, and native object-unserialize functions in any language — these are banned outright per Core Rule 9 in the main skill.
- Prefer data formats that deserialize into plain data structures (JSON) over ones that can deserialize into arbitrary objects/executable state.
- If a schema-based deserializer is used, validate against the schema before the object is used anywhere — a schema check that only logs a warning is not a validation.

## Server-side template injection (backend, SSR frontend)

- Never pass user input as the *template source itself* (e.g. rendering a user-supplied string through the templating engine). User input belongs in template *variables*, not in the template definition.
- Use the templating engine's default auto-escaping; don't disable auto-escape for a route "just this once" without explicit review.

## Header / response-splitting injection (backend)

- Never place raw user input into a response header (including `Location` on a redirect) without stripping CR/LF characters — unsanitized input here can inject additional headers or split the response.
- Combine with Core Rule 8 (redirect allowlisting) for any redirect target derived from user input.

## File upload input validation

- Validate file type by inspecting content (magic bytes), not just the extension or client-supplied MIME type — both are trivially spoofable.
- Enforce a size limit before reading the full file into memory.
- Store uploads outside the web root, or behind an access-controlled handler, and generate the storage filename server-side — never use the client-supplied filename directly (path traversal + overwrite risk).

---

## Quick checklist before marking this done

- [ ] No string-built SQL/NoSQL queries with user input
- [ ] No raw-HTML-injection APIs used on unsanitized input
- [ ] No shell command built via string concatenation
- [ ] All file paths resolved and bounds-checked against a base directory
- [ ] Any user-influenced outbound request checked against an SSRF allow/blocklist
- [ ] No unsafe deserialization of untrusted payloads
- [ ] User input never used as template source
- [ ] Redirect/response headers built from user input are sanitized or allowlisted
- [ ] Uploaded files validated by content, size-limited, and stored with a server-generated name
