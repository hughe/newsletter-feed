# Setup notes

Working notes on testing, configuring, deploying, and the Cloudflare/DNS
decision for this project. Not part of the deployed Worker.

---

## Testing, prefix, Cloudflare setup, and the CLI

### The Cloudflare CLI — Wrangler

Cloudflare's official CLI is **Wrangler**; it drives local dev, D1, and deploy.

```
npm install -g wrangler   # or use npx wrangler
wrangler login            # opens a browser to authorize your account
```

Deploy is one command once configured: `npx wrangler deploy`. That's the
automation hook — it also slots into CI (GitHub Actions has
`cloudflare/wrangler-action`).

### Setting it up in Cloudflare

Two halves — the Worker, then email routing.

**Worker + database**
```
npx wrangler d1 create newsletters          # prints a database_id -> paste into wrangler.toml
npx wrangler d1 execute newsletters --file=./schema.sql --remote   # create tables in prod
npx wrangler deploy
```

**Email routing** (Cloudflare dashboard, your domain):
1. Email -> Email Routing -> enable (provisions MX/DNS records). Requires the
   domain's nameservers to point at Cloudflare.
2. Verify a destination address if prompted.
3. Email Workers -> bind an address (e.g. `news@yourdomain.com`, or a
   catch-all) to the `newsletter-rss` Worker.

Then forward a newsletter to that address; it flows into `index.ts`'s
`email()` handler.

### Setting the prefix

Three different "prefixes" — keep them separate:

- **Secret URL token** (`/feed/<TOKEN>/...`) — the `FEED_TOKEN` env var, the
  only thing gating access. Set it in `wrangler.toml` under `[vars]`, or more
  securely as `npx wrangler secret put FEED_TOKEN`. Generate with
  `openssl rand -hex 24`. Feed URL becomes
  `https://newsletter-rss.<subdomain>.workers.dev/feed/<TOKEN>.xml`.
- **Literal `/feed/` segment** — hardcoded in `index.ts` (`/feed/${token}.xml`
  at line 97 and ``const base = `/feed/${token}` `` at line 113). Only edit
  those to change the word in the path.
- **Email address prefix** (the `news@` part) — not in code; whatever address
  you bind in Cloudflare Email Routing.

### How to test

**Locally**, without real mail — `wrangler dev` exposes the email handler at a
special endpoint you can POST a raw `.eml` to:
```
npx wrangler dev
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' --url-query 'to=news@yourdomain.com' \
  --header 'Content-Type: application/json' --data-binary @sample-email.eml
```
Then open `http://localhost:8787/feed/<TOKEN>.xml` and the admin pages at
`/feed/<TOKEN>/`. Local dev uses a local SQLite copy of D1, so apply the schema
locally too (`wrangler d1 execute newsletters --file=./schema.sql`, no
`--remote`).

**In production**, forward a real newsletter, then check rows landed:
```
npx wrangler d1 execute newsletters --remote --command "SELECT id, subject FROM emails"
npx wrangler d1 execute newsletters --remote --command "SELECT id, reason, subject FROM errors"
```

No automated test suite — verification is manual via these paths.

---

## Can I point `newsletter-feed.emberson.net` at Cloudflare and keep `emberson.net` on Route53?

Short answer: **not for that specific subdomain while keeping `emberson.net`
on Route53 — not on any non-Enterprise plan.**

### The constraint

Both things the Worker needs require the domain to be a **zone on Cloudflare**:

- **Email Routing** is a zone-level feature. Cloudflare auto-creates the
  MX/TXT records, so it must be authoritative for the domain — i.e. **full
  setup** (nameservers delegated to Cloudflare). It does *not* work by just
  pointing MX records at Cloudflare from Route53.
- **A Worker custom domain** also requires the zone on Cloudflare. Keeping DNS
  at Route53 and CNAME-ing in specific records ("partial setup") is a
  **Business plan** feature (~$200/mo).

The only way to onboard *just* the subdomain while `emberson.net` stays on
Route53 is **subdomain setup via NS delegation** — and per the docs,
*"Subdomain setup is only available for Enterprise accounts."*

Email Routing *does* support subdomains (`news@mail.example.com`), but only as
subdomains **of a zone already on Cloudflare** — it can't onboard a lone
subdomain whose parent lives elsewhere.

### Options

1. **Use a separate, dedicated domain on Cloudflare (recommended).** Keep
   `emberson.net` 100% on Route53. Put some other cheap domain fully on
   Cloudflare's free plan and use it for both the email address and the feed
   URL. Everything works as written, free beyond the domain cost.
2. **Move `emberson.net` fully to Cloudflare.** Then
   `news@newsletter-feed.emberson.net` and a `newsletter-feed.emberson.net`
   custom domain both work — but that delegates the whole zone's nameservers
   to Cloudflare, which is what we're trying to avoid.
3. **Skip the custom domain entirely (CHOSEN).** The feed already lives at a
   hard-to-guess token URL, so the default
   `newsletter-rss.<subdomain>.workers.dev/feed/<token>.xml` is fine for an
   RSS subscription. This solves the HTTP half only — you **still need a
   Cloudflare-hosted domain to receive the email**, since there's no way into
   the `email()` handler without Email Routing on a Cloudflare zone.

### Decision: option 3

- **HTTP / feed URL:** use the default `*.workers.dev` URL. No custom domain,
  no DNS changes, `emberson.net` untouched on Route53.
- **Email:** still requires a domain on Cloudflare (full setup). Pick/register
  a dedicated domain for that — anything other than `emberson.net`.

### What's the email address?

It's `<local-part>@<your-cloudflare-domain>`, where:
- **`<your-cloudflare-domain>`** is whatever domain you put on Cloudflare for
  the email half (NOT `emberson.net`). Option 3 only removes the *custom HTTP
  domain* — it does not remove the need for a Cloudflare-hosted domain to
  receive mail.
- **`<local-part>`** (the bit before the `@`) is arbitrary — you choose it when
  you bind the route in Email Routing. Use a specific address like `news` or
  `newsletters`, or set up a catch-all (`*@domain`) so any address works.

So a concrete example, if you dedicate `hughmail.dev` to Cloudflare:
`news@hughmail.dev`. Forward newsletters there; read them at
`https://newsletter-rss.<subdomain>.workers.dev/feed/<TOKEN>.xml`.

### Sources

- https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/setup/
- https://developers.cloudflare.com/email-routing/setup/subdomains/
- https://developers.cloudflare.com/dns/zone-setups/
- https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/

---

## Is there a free Cloudflare domain (like workers.dev) I could use instead of registering one?

**No.** There's no email equivalent of `workers.dev`.

- `workers.dev` works for **HTTP** because Cloudflare hosts and serves it for
  you.
- **Email Routing requires Cloudflare to be the authoritative nameserver for
  the domain** — i.e. you must control its DNS records. You don't control
  `workers.dev`'s DNS (Cloudflare does), so you can't enable Email Routing or
  add MX records on a `*.workers.dev` subdomain.

Confusing bit: when you set up Email *Workers*, Cloudflare may spin up a
`workers.dev` subdomain — but that's for the Worker that *processes* mail, not
an address that can *receive* mail. Receiving still needs a domain you own.

### So you need a domain — but it can be cheap

- **Cloudflare Registrar sells domains at wholesale cost** (no markup) — a
  `.com` is roughly ~$10/yr, some TLDs cheaper. Buying it *through* Cloudflare
  makes it a zone on your account with full setup automatically, so Email
  Routing works immediately with zero DNS fiddling. `emberson.net` stays
  untouched on Route53.
- Cheapest legitimate path: ~$10/yr for a dedicated domain, and the option-3
  setup (workers.dev for the feed URL + Email Routing on the new domain) works
  end to end.
- Free-but-not-what-you-wanted alternative: **option 2** — move `emberson.net`'s
  nameservers to Cloudflare.

### Sources

- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/
- https://developers.cloudflare.com/email-routing/setup/subdomains/
