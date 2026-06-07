# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Cloudflare Worker that turns forwarded email newsletters into a private RSS feed. Mail sent to an address on the user's domain (via Cloudflare Email Routing) invokes the Worker's `email()` handler, which parses the message with `postal-mime` and stores the HTML body in a D1 database. The Worker's `fetch()` handler republishes those emails as an RSS feed and serves admin pages, all gated behind a single secret token in the URL path. Designed to run entirely on Cloudflare's free tier.

## Commands

```
npm install                                                       # deps: postal-mime, wrangler
npx wrangler dev                                                  # local dev server on :8787
npx wrangler deploy                                               # deploy to Cloudflare

npx wrangler d1 create newsletters                                # one-time; copy database_id into wrangler.toml
npx wrangler d1 execute newsletters --file=./schema.sql           # apply schema locally
npx wrangler d1 execute newsletters --file=./schema.sql --remote  # apply schema to production
npx wrangler d1 execute newsletters --remote --command "SELECT id, reason, subject FROM errors"  # inspect failures
```

Exercise the email ingest path locally by POSTing a raw `.eml` to the Worker's email handler endpoint:

```
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' --url-query 'to=news@yourdomain.com' \
  --header 'Content-Type: application/json' --data-binary @sample-email.eml
```

There is no test suite, lint, or build step — `wrangler` bundles directly.

## Architecture

All code is in **`index.js`** — one Worker default export with two handlers:

- **`email(message, env, ctx)`** — ingest. Buffers the raw stream up front (a `ReadableStream` can only be read once, and the raw bytes are needed for the errors table if parsing throws). Parses with `postal-mime`. Forwarded newsletters sometimes nest the original as a `message/rfc822` attachment — when present, the nested original's html/text/subject/from take precedence over the outer (forwarding) wrapper. Plaintext-only mail is wrapped in `<pre>` so the feed still renders.
- **`fetch(request, env, ctx)`** — a hand-rolled path router (no framework). The RSS feed lives at `/feed/<token>.xml`; admin pages live under `/feed/<token>/...`. HTML pages are built by string-templating functions (`layout`, `renderDashboard`, `renderEmailList`, `renderEmailView`, etc.) sharing the `STYLE` constant.

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

- `README.md` and `PLAN.md` refer to the Worker as `src/index.js`, but the file is actually `index.js` at the repo root. `wrangler.toml` and `package.json` are described in those docs but do not yet exist in the repo — they must be created to deploy (see `PLAN.md` "Components" and "Build & deploy" for the expected contents).
- The feed returns the 100 most recent emails (`LIMIT 100` in the feed query); admin lists show 200. Both are hardcoded.
