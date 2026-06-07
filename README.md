# newsletter-rss

A single Cloudflare Worker that:

1. Receives email forwarded to an address on your domain (via Email Routing).
2. Parses it and stores the HTML in a D1 database.
3. Serves an RSS feed of those emails at a hard-to-guess URL, so you can
   read forwarded newsletters in any RSS client.

Everything here runs on Cloudflare's free tier.

## Prerequisites

- A domain whose nameservers point at Cloudflare.
- `npm install -g wrangler` (or use `npx wrangler`), then `wrangler login`.

## Setup

1. Install deps:

   ```
   npm install
   ```

2. Create the D1 database and copy the returned `database_id` into
   `wrangler.toml`:

   ```
   npx wrangler d1 create newsletters
   ```

3. Apply the schema (run locally and remotely):

   ```
   npx wrangler d1 execute newsletters --file=./schema.sql           # local
   npx wrangler d1 execute newsletters --file=./schema.sql --remote  # production
   ```

4. Set your secret feed token and feed title in `wrangler.toml`
   (`FEED_TOKEN`, `FEED_TITLE`). Generate a long random token, e.g.:

   ```
   openssl rand -hex 24
   ```

5. Deploy:

   ```
   npx wrangler deploy
   ```

## Connect email

In the Cloudflare dashboard for your domain:

1. **Email → Email Routing** → enable it (this provisions the MX/DNS records).
2. Add and verify a destination address if prompted.
3. Under **Email Workers**, bind a route (a specific address like
   `news@yourdomain.com`, or a catch-all) to the `newsletter-rss` Worker.

Then forward newsletters to that address. Subscribe your RSS client to:

```
https://newsletter-rss.<your-subdomain>.workers.dev/feed/<FEED_TOKEN>.xml
```

(or your custom route if you map one).

## Web pages

All of these sit under the same secret token prefix — no separate login:

- `/feed/<FEED_TOKEN>/` — dashboard with counts and links
- `/feed/<FEED_TOKEN>/emails` — stored email list
- `/feed/<FEED_TOKEN>/email/<id>` — a single email, HTML rendered in a
  sandboxed iframe
- `/feed/<FEED_TOKEN>/errors` — list of unparseable / no-HTML emails
- `/feed/<FEED_TOKEN>/error/<id>` — error detail plus the raw message

## Notes

- The feed returns the 100 most recent emails. Adjust the `LIMIT` in
  `src/index.js` if you want more/fewer.
- Cloudflare rejects email messages larger than ~25 MB.
- Dedup is by `Message-ID`; forwarding the same newsletter twice is ignored.
- Emails that can't be parsed, or that have no HTML and no plaintext, are not
  dropped — they're written to the `errors` table (with the raw message) so you
  can inspect or reprocess them. Check it with:
  `npx wrangler d1 execute newsletters --remote --command "SELECT id, reason, subject FROM errors"`.
- There is no auth — anyone with the URL can read the feed. That's fine for
  public newsletters; don't forward anything private to it.

## Local testing

`npx wrangler dev` exposes a local endpoint you can POST a raw email to:

```
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=news@yourdomain.com' \
  --header 'Content-Type: application/json' \
  --data-binary @sample-email.eml
```

Then fetch `http://localhost:8787/feed/<FEED_TOKEN>.xml`.
