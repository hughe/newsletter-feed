# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Cloudflare Worker that turns forwarded email newsletters into a private RSS feed. Mail sent to an address on the user's domain (via Cloudflare Email Routing) invokes the Worker's `email()` handler, which parses the message with `postal-mime` and stores the HTML body in a D1 database. The Worker's `fetch()` handler republishes those emails as an RSS feed and serves admin pages, all gated behind a single secret token in the URL path. Designed to run entirely on Cloudflare's free tier.

## Commands

A `Makefile` wraps the common tasks (`make install`, `make dev`, `make typecheck`, `make deploy`, `make schema-local`, `make schema-remote`, `make errors`). `make deploy` runs `typecheck` first, so a type error aborts the deploy.

```
make install        # npm install — deps: postal-mime; dev deps: typescript, @cloudflare/workers-types, wrangler
make dev            # local dev server on :8787 (npx wrangler dev)
make typecheck      # npx tsc --noEmit (wrangler does NOT type-check at deploy; this is the only gate)
make deploy         # typecheck, then npx wrangler deploy

npx wrangler d1 create newsletters                                # one-time; copy database_id into wrangler.toml
make schema-local                                                 # apply schema locally
make schema-remote                                                # apply schema to production
make errors                                                       # inspect failures (SELECT id, reason, subject FROM errors)
```

Exercise the email ingest path locally by POSTing a raw `.eml` to the Worker's email handler endpoint:

```
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' --url-query 'to=news@yourdomain.com' \
  --header 'Content-Type: application/json' --data-binary @sample-email.eml
```

There is no test suite or lint step. `wrangler` bundles `index.ts` directly via esbuild, which **strips types without checking them** — so `tsc --noEmit` (run by `make typecheck`, and as the first step of `make deploy`) is the only thing that enforces type safety.

## Architecture

All code is in **`index.ts`** — one Worker default export, typed with `satisfies ExportedHandler<Env>`, with two handlers:

- **`email(message, env, ctx)`** — ingest. Buffers the raw stream up front (a `ReadableStream` can only be read once, and the raw bytes are needed for the errors table if parsing throws). Parses with `postal-mime`. Forwarded newsletters sometimes nest the original as a `message/rfc822` attachment — when present, the nested original's html/text/subject/from take precedence over the outer (forwarding) wrapper. Plaintext-only mail is wrapped in `<pre>` so the feed still renders.
- **`fetch(request, env, ctx)`** — a hand-rolled path router (no framework). The RSS feed lives at `/feed/<token>.xml`; admin pages live under `/feed/<token>/...`. HTML pages are built by string-templating functions (`layout`, `renderDashboard`, `renderEmailList`, `renderEmailView`, etc.) sharing the `STYLE` constant. `POST /feed/<token>/error/<id>/replay` (and a button on the error view) re-runs a stored failure through the parser — see replay below.

The parse-and-extract logic lives in a shared **`ingest(rawBytes, fallbackFrom)`** that returns a discriminated `IngestResult` (`{ok:true,...}` | `{ok:false, reason, ...}`) instead of touching the DB. Both `email()` (live mail) and `replayError()` (reprocessing) call it, so a parser fix applies identically to both. `email()` writes the result to `emails`/`errors`; `replayError()` reads `errors.raw`, re-ingests, and on success stores the email and **deletes** the error row (on failure the row is kept). Note `errors.raw` is the UTF-8-decoded source, so replay re-encodes it with `TextEncoder` — lossless for typical newsletters, but raw 8-bit/binary MIME could differ slightly from the bytes Cloudflare originally delivered.

Data model (`schema.sql`): two tables. **`emails`** holds successfully stored newsletters, deduped by `message_id` (`UNIQUE` + `INSERT OR IGNORE`). **`errors`** holds messages that couldn't be parsed (`reason = 'parse_failed'`) or had no usable HTML/text (`reason = 'no_html'`), with the raw RFC822 source retained for inspection/reprocessing. Both indexed on `received_at DESC`.

### Key invariants — preserve these when editing

- **`email()` must never throw.** A thrown exception causes Cloudflare to retry or bounce the message. Failures are written to the `errors` table instead, and even `recordError`'s own insert is wrapped in try/catch so it can't propagate.
- **No message is silently dropped.** Anything that fails parsing or has no body goes to `errors` with enough context (and raw source) to debug later.
- **Stored HTML is untrusted third-party content.** The single-email admin view renders it in an `<iframe sandbox>` (no scripts, no same-origin). Don't loosen the sandbox. In the RSS feed it goes in `content:encoded` CDATA — the RSS client is responsible for its own rendering safety. HTML is intentionally **not** sanitized (newsletters already carry tracking pixels/remote assets; this matches opening them in a mail client).
- **Output escaping is context-specific** — `escapeXml` (RSS/HTML text), `escapeHtml` (plaintext→`<pre>`), `escapeAttr` (the iframe `srcdoc` attribute). Use the matching one; they are not interchangeable.

### Configuration (env bindings)

The Worker reads three things from `env`, configured in `wrangler.toml`:

- `DB` — the D1 database binding
- `FEED_TOKEN` — the single secret that gates **all** URLs (feed and admin). There is no other auth; anyone with the token URL can read everything. Generate with `openssl rand -hex 24`.
- `FEED_TITLE` — RSS channel title

## Notes for working here

- `README.md` and `PLAN.md` refer to the Worker as `src/index.js`, but the file is actually `index.ts` at the repo root. Those docs predate both the TypeScript conversion and the creation of `wrangler.toml`/`package.json`/`tsconfig.json` — the config files now exist, but `wrangler.toml` ships with placeholder `database_id` and `FEED_TOKEN` values that must be filled in before a real deploy (see `PLAN.md` "Build & deploy").
- **TypeScript types live in `index.ts` itself.** `Env` (the bindings) plus `EmailRow`/`ErrorRow` row shapes are declared at the top; D1 reads are typed via `.all<T>()`/`.first<T>()`, and the escaping helpers take `unknown`. There's no separate `.d.ts`. Worker globals (`D1Database`, `ExportedHandler`, etc.) come from `@cloudflare/workers-types` via `tsconfig.json`'s `types` array.
- The feed returns the 100 most recent emails (`LIMIT 100` in the feed query); admin lists show 200. Both are hardcoded.
