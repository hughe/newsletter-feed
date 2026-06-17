# Plan: Newsletter-to-RSS via Cloudflare

## Goal

Read email newsletters in an RSS client instead of an inbox. Forward a
newsletter to a dedicated email address; it gets stored and republished as
an item in a private-ish RSS feed.

The entire system runs as a single Cloudflare Worker on the free tier:

1. **Ingest** — Cloudflare Email Routing receives mail sent to an address on
   the domain and invokes the Worker's `email()` handler.
2. **Store** — the Worker parses the message and writes the HTML body (plus
   sender, subject, timestamp) to a D1 database.
3. **Publish** — the Worker's `fetch()` handler serves an RSS feed of the
   stored emails at a hard-to-guess URL, which any RSS client can subscribe to.

## Why this design

- **No raw SMTP, no always-on server.** Cloudflare handles all inbound mail
  (TLS, MX, spam). We only deal with already-parsed messages.
- **One Worker, one binding.** Both the `email()` and `fetch()` handlers live
  in the same Worker and share the same D1 database.
- **Free tier is sufficient.** A few tens of emails/day is far below D1 and
  Workers free limits.

## Non-goals / accepted tradeoffs

- **No authentication.** The feed URL is the only barrier. Acceptable because
  the content is public newsletters; nothing private gets forwarded here.
- **No HTML sanitization.** Newsletters already contain tracking pixels and
  remote assets; rendering them in an RSS client is equivalent to opening them
  in a mail client. We accept that.
- **~25 MB message size limit** imposed by Cloudflare Email Workers. Fine for
  newsletters; very large emails will be rejected upstream.

## Components

| File            | Role                                                        |
|-----------------|-------------------------------------------------------------|
| `src/index.js`  | Worker: `email()` ingest + parse + D1 insert; `fetch()` router serving the RSS feed and admin pages |
| `schema.sql`    | D1 tables `emails` and `errors`, with indexes                |
| `wrangler.toml` | Worker config: D1 binding, `FEED_TOKEN`, `FEED_TITLE`       |
| `package.json`  | Deps: `postal-mime` (parsing), `wrangler` (tooling)         |

## URLs

Everything is gated by the single secret `FEED_TOKEN` in the path prefix. No
other auth; anyone with the token URL can read all pages and the feed.

| Path                          | Page                                            |
|-------------------------------|-------------------------------------------------|
| `/feed/<token>.xml`           | RSS feed (unchanged; keeps existing subscribers)|
| `/feed/<token>/`              | Dashboard: counts + links                       |
| `/feed/<token>/emails`        | List of stored emails (newest 200)              |
| `/feed/<token>/email/<id>`    | Single email; HTML rendered in a sandboxed iframe |
| `/feed/<token>/errors`        | List of error rows (newest 200)                 |
| `/feed/<token>/error/<id>`    | Single error: reason, detail, and raw message   |
| `/feed/<token>/error/<id>/replay` (POST) | Re-ingest the stored raw message; on success it moves to `emails` and the error row is deleted |

The single-email view renders the stored newsletter HTML inside an iframe with
a restrictive `sandbox` (no scripts, no same-origin), so opening a stored email
can't run code against the Worker's origin.

## Data model

Table `emails`:

- `id` — autoincrement primary key
- `message_id` — RFC Message-ID, `UNIQUE`, used to dedupe re-forwards
- `from_addr`, `from_name` — best-effort original sender
- `subject`
- `html` — body served in the feed
- `text` — plaintext fallback
- `received_at` — unix epoch seconds (indexed, descending)

Table `errors` (messages we couldn't parse or had no usable body):

- `id` — autoincrement primary key
- `from_addr`, `subject` — best-effort; may be null if the parse itself failed
- `reason` — `parse_failed` (postal-mime threw) or `no_html` (parsed but no
  HTML and no text to fall back on)
- `error` — exception message, when there is one
- `raw` — the raw RFC822 message, decoded as UTF-8, for inspection/reprocessing
- `received_at` — unix epoch seconds (indexed, descending)

A failed message is never silently dropped: it lands in `errors` with enough
context (and the raw source) to debug or reprocess later. The error insert is
itself wrapped so it can't throw and trigger a Cloudflare retry/bounce.

## Concrete steps

### Prerequisites
- [ ] Domain with nameservers pointed at Cloudflare.
- [ ] `wrangler` installed and authenticated (`wrangler login`).

### Build & deploy
- [ ] `npm install`
- [ ] `npx wrangler d1 create newsletters`, copy `database_id` into
      `wrangler.toml`.
- [ ] Apply schema locally and remotely:
      `npx wrangler d1 execute newsletters --file=./schema.sql`
      then the same with `--remote`.
- [ ] Generate a feed token (`openssl rand -hex 24`) and set `FEED_TOKEN` and
      `FEED_TITLE` in `wrangler.toml`.
- [ ] `npx wrangler deploy`

### Connect email (Cloudflare dashboard)
- [ ] Email → Email Routing → enable (provisions MX/DNS records).
- [ ] Add and verify a destination address if prompted.
- [ ] Email Workers → bind an address (specific, e.g. `news@domain`, or
      catch-all) to the `newsletter-rss` Worker.

### Verify
- [ ] Forward a newsletter to the address.
- [ ] Confirm a row lands in D1
      (`npx wrangler d1 execute newsletters --remote --command "SELECT id, subject FROM emails"`).
- [ ] Subscribe RSS client to
      `https://newsletter-rss.<subdomain>.workers.dev/feed/<FEED_TOKEN>.xml`
      and confirm the item renders.
- [ ] Check the error table is empty (or inspect any rows):
      `npx wrangler d1 execute newsletters --remote --command "SELECT id, reason, subject FROM errors"`.

## Possible later enhancements

- Move `FEED_TOKEN` to `wrangler secret put` if access ever starts to matter.
- Offload large inline images/attachments to R2, keep only HTML in D1.
- Per-sender feeds (filter by `from_addr` via a path or query param).
- Retention/cleanup job to cap stored history.
