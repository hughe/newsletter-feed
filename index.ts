import PostalMime from "postal-mime";

// ---- Configuration bound from wrangler.toml -------------------------------
interface Env {
  DB: D1Database;
  FEED_TOKEN: string;
  FEED_TITLE: string;
}

// ---- Row shapes returned by D1 --------------------------------------------
interface EmailRow {
  id: number;
  message_id: string;
  from_addr: string;
  from_name: string | null;
  subject: string;
  html: string;
  text: string | null;
  received_at: number;
}

interface ErrorRow {
  id: number;
  from_addr: string | null;
  subject: string | null;
  reason: string;
  error: string | null;
  raw: string | null;
  received_at: number;
}

interface RecordErrorInput {
  from_addr: string | null;
  subject: string | null;
  reason: "parse_failed" | "no_html";
  error: string | null;
  rawBytes: Uint8Array;
  receivedAt: number;
}

export default {
  // ---- 1. Inbound email: parse, then store in D1 ----
  async email(message, env, ctx) {
    const receivedAt = Math.floor(Date.now() / 1000);

    // Read the raw stream once into memory. A ReadableStream can only be
    // consumed once, so we buffer it up front: that way, if parsing throws,
    // we still have the raw bytes to record in the errors table.
    const rawBytes = new Uint8Array(
      await new Response(message.raw).arrayBuffer()
    );

    let parsed;
    try {
      parsed = await PostalMime.parse(rawBytes);
    } catch (e) {
      await recordError(env, {
        from_addr: message.from || null,
        subject: null,
        reason: "parse_failed",
        error: String(e && (e as Error).message ? (e as Error).message : e),
        rawBytes,
        receivedAt,
      });
      return;
    }

    // When you forward a newsletter, your mail client usually keeps the
    // original HTML as the main body. But some clients nest the original
    // as a message/rfc822 attachment. Prefer a nested original if present.
    let html = parsed.html || "";
    let text = parsed.text || "";
    let subject = parsed.subject || "(no subject)";
    let fromAddr = parsed.from?.address || message.from || "unknown";
    let fromName = parsed.from?.name || "";

    const nested = (parsed.attachments || []).find(
      (a) => a.mimeType === "message/rfc822"
    );
    if (nested && nested.content) {
      try {
        const inner = await PostalMime.parse(nested.content);
        if (inner.html) html = inner.html;
        if (inner.text) text = inner.text;
        if (inner.subject) subject = inner.subject;
        if (inner.from?.address) {
          fromAddr = inner.from.address;
          fromName = inner.from.name || fromName;
        }
      } catch (e) {
        // fall back to the outer message; not fatal
      }
    }

    // If there's truly no HTML, wrap the plaintext so the feed still renders.
    if (!html && text) {
      html = `<pre style="white-space:pre-wrap">${escapeHtml(text)}</pre>`;
    }

    // No HTML and no text at all: nothing usable to put in the feed.
    if (!html) {
      await recordError(env, {
        from_addr: fromAddr,
        subject,
        reason: "no_html",
        error: null,
        rawBytes,
        receivedAt,
      });
      return;
    }

    const messageId =
      parsed.messageId || `${fromAddr}-${subject}-${Date.now()}`;

    await env.DB.prepare(
      `INSERT OR IGNORE INTO emails
         (message_id, from_addr, from_name, subject, html, text, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(messageId, fromAddr, fromName, subject, html, text, receivedAt)
      .run();
  },

  // ---- 2. HTTP: feed + admin pages, all under the secret token prefix ----
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const token = env.FEED_TOKEN;
    const path = url.pathname;

    // RSS feed keeps its original URL so existing subscriptions don't break.
    if (path === `/feed/${token}.xml`) {
      const { results } = await env.DB.prepare(
        `SELECT message_id, from_addr, from_name, subject, html, received_at
           FROM emails
          ORDER BY received_at DESC
          LIMIT 100`
      ).all<EmailRow>();
      return new Response(buildRss(results || [], url, env.FEED_TITLE), {
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": "max-age=60",
        },
      });
    }

    // Everything else lives under /feed/<token>/...
    const base = `/feed/${token}`;
    if (path === base || path === `${base}/`) {
      return html(await renderDashboard(env, base));
    }
    if (path === `${base}/emails`) {
      return html(await renderEmailList(env, base));
    }
    if (path === `${base}/errors`) {
      return html(await renderErrorList(env, base));
    }

    const emailMatch = path.match(new RegExp(`^${escapeRegex(base)}/email/(\\d+)$`));
    if (emailMatch) {
      return renderEmailView(env, base, Number(emailMatch[1]));
    }
    const errorMatch = path.match(new RegExp(`^${escapeRegex(base)}/error/(\\d+)$`));
    if (errorMatch) {
      return html(await renderErrorView(env, base, Number(errorMatch[1])));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRss(rows: EmailRow[], url: URL, title: string): string {
  const feedTitle = title || "Forwarded Newsletters";
  const self = url.href;
  const home = `${url.protocol}//${url.host}`;

  const items = rows
    .map((r) => {
      const date = new Date(r.received_at * 1000).toUTCString();
      const author = r.from_name
        ? `${r.from_name} <${r.from_addr}>`
        : r.from_addr;
      // Each item carries the full HTML in content:encoded.
      return `    <item>
      <title>${escapeXml(r.subject)}</title>
      <guid isPermaLink="false">${escapeXml(r.message_id)}</guid>
      <pubDate>${date}</pubDate>
      <dc:creator>${escapeXml(author)}</dc:creator>
      <content:encoded><![CDATA[${r.html}]]></content:encoded>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(feedTitle)}</title>
    <link>${escapeXml(home)}</link>
    <atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml"/>
    <description>Newsletters forwarded by email, rendered as a feed.</description>
${items}
  </channel>
</rss>`;
}

// ---- Admin pages ----------------------------------------------------------

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0;
         background: Canvas; color: CanvasText; }
  header { padding: 16px 20px; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  header a { margin-right: 16px; text-decoration: none; }
  header a:hover { text-decoration: underline; }
  main { padding: 20px; max-width: 1000px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { opacity: 0.65; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 10px; vertical-align: top;
           border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; }
  td.when { white-space: nowrap; opacity: 0.7; font-size: 13px; }
  td.from { white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  a.subject { text-decoration: none; }
  a.subject:hover { text-decoration: underline; }
  .empty { opacity: 0.6; margin-top: 24px; }
  .badge { display: inline-block; font-size: 12px; padding: 1px 7px; border-radius: 10px;
           background: color-mix(in srgb, CanvasText 12%, transparent); }
  .badge.parse_failed { background: color-mix(in srgb, #d33 30%, transparent); }
  .badge.no_html { background: color-mix(in srgb, #d90 30%, transparent); }
  iframe.render { width: 100%; height: 78vh; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
                  border-radius: 6px; background: #fff; }
  pre.raw { white-space: pre-wrap; word-break: break-word; font-size: 12px;
            background: color-mix(in srgb, CanvasText 6%, transparent); padding: 14px;
            border-radius: 6px; overflow-x: auto; }
  .meta { margin: 8px 0 16px; }
  .meta div { margin: 2px 0; }
  .meta .k { opacity: 0.55; display: inline-block; min-width: 70px; }
`;

function layout(base: string, title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeXml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <a href="${base}/">Dashboard</a>
  <a href="${base}/emails">Emails</a>
  <a href="${base}/errors">Errors</a>
  <a href="${base}.xml">RSS</a>
</header>
<main>
${inner}
</main>
</body>
</html>`;
}

function fmtDate(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "";
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").slice(0, 16);
}

async function renderDashboard(env: Env, base: string): Promise<string> {
  const emails = await env.DB.prepare(`SELECT COUNT(*) AS n FROM emails`).first<{ n: number }>();
  const errors = await env.DB.prepare(`SELECT COUNT(*) AS n FROM errors`).first<{ n: number }>();
  const latest = await env.DB.prepare(
    `SELECT received_at FROM emails ORDER BY received_at DESC LIMIT 1`
  ).first<{ received_at: number }>();

  const inner = `
  <h1>Newsletter feed</h1>
  <p class="sub">Forwarded newsletters, stored and republished as RSS.</p>
  <table>
    <tr><th>What</th><th>Count</th></tr>
    <tr><td><a class="subject" href="${base}/emails">Stored emails</a></td>
        <td>${emails?.n ?? 0}</td></tr>
    <tr><td><a class="subject" href="${base}/errors">Errors</a></td>
        <td>${errors?.n ?? 0}</td></tr>
    <tr><td>Last received</td><td>${latest ? fmtDate(latest.received_at) : "—"}</td></tr>
  </table>`;
  return layout(base, "Dashboard", inner);
}

async function renderEmailList(env: Env, base: string): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT id, from_addr, from_name, subject, received_at
       FROM emails ORDER BY received_at DESC LIMIT 200`
  ).all<Pick<EmailRow, "id" | "from_addr" | "from_name" | "subject" | "received_at">>();

  if (!results || results.length === 0) {
    return layout(base, "Emails", `<h1>Emails</h1><p class="empty">No emails stored yet.</p>`);
  }

  const rows = results
    .map((r) => {
      const from = r.from_name ? `${r.from_name} <${r.from_addr}>` : r.from_addr;
      return `    <tr>
      <td class="when">${fmtDate(r.received_at)}</td>
      <td class="from" title="${escapeXml(from)}">${escapeXml(from)}</td>
      <td><a class="subject" href="${base}/email/${r.id}">${escapeXml(r.subject)}</a></td>
    </tr>`;
    })
    .join("\n");

  const inner = `
  <h1>Emails</h1>
  <p class="sub">${results.length} most recent.</p>
  <table>
    <tr><th>Received</th><th>From</th><th>Subject</th></tr>
${rows}
  </table>`;
  return layout(base, "Emails", inner);
}

async function renderEmailView(env: Env, base: string, id: number): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT from_addr, from_name, subject, html, received_at FROM emails WHERE id = ?`
  )
    .bind(id)
    .first<Pick<EmailRow, "from_addr" | "from_name" | "subject" | "html" | "received_at">>();

  if (!r) return html(layout(base, "Not found", `<h1>Email not found</h1>`), 404);

  const from = r.from_name ? `${r.from_name} <${r.from_addr}>` : r.from_addr;
  // The stored HTML is third-party content. Render it in a sandboxed iframe:
  // no scripts, no same-origin access. allow-popups lets links open if clicked.
  const inner = `
  <h1>${escapeXml(r.subject)}</h1>
  <div class="meta">
    <div><span class="k">From</span> ${escapeXml(from)}</div>
    <div><span class="k">Received</span> ${fmtDate(r.received_at)}</div>
  </div>
  <iframe class="render" sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcdoc="${escapeAttr(r.html)}"></iframe>`;
  return html(layout(base, r.subject || "Email", inner));
}

async function renderErrorList(env: Env, base: string): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT id, from_addr, subject, reason, received_at
       FROM errors ORDER BY received_at DESC LIMIT 200`
  ).all<Pick<ErrorRow, "id" | "from_addr" | "subject" | "reason" | "received_at">>();

  if (!results || results.length === 0) {
    return layout(base, "Errors", `<h1>Errors</h1><p class="empty">No errors. 🎉</p>`);
  }

  const rows = results
    .map(
      (r) => `    <tr>
      <td class="when">${fmtDate(r.received_at)}</td>
      <td><span class="badge ${escapeXml(r.reason)}">${escapeXml(r.reason)}</span></td>
      <td class="from" title="${escapeXml(r.from_addr || "")}">${escapeXml(r.from_addr || "—")}</td>
      <td><a class="subject" href="${base}/error/${r.id}">${escapeXml(r.subject || "(no subject)")}</a></td>
    </tr>`
    )
    .join("\n");

  const inner = `
  <h1>Errors</h1>
  <p class="sub">${results.length} most recent.</p>
  <table>
    <tr><th>Received</th><th>Reason</th><th>From</th><th>Subject</th></tr>
${rows}
  </table>`;
  return layout(base, "Errors", inner);
}

async function renderErrorView(env: Env, base: string, id: number): Promise<string> {
  const r = await env.DB.prepare(
    `SELECT from_addr, subject, reason, error, raw, received_at FROM errors WHERE id = ?`
  )
    .bind(id)
    .first<Pick<ErrorRow, "from_addr" | "subject" | "reason" | "error" | "raw" | "received_at">>();

  if (!r) return layout(base, "Not found", `<h1>Error not found</h1>`);

  const inner = `
  <h1>${escapeXml(r.subject || "(no subject)")}</h1>
  <div class="meta">
    <div><span class="k">Reason</span> <span class="badge ${escapeXml(r.reason)}">${escapeXml(r.reason)}</span></div>
    <div><span class="k">From</span> ${escapeXml(r.from_addr || "—")}</div>
    <div><span class="k">Received</span> ${fmtDate(r.received_at)}</div>
    ${r.error ? `<div><span class="k">Detail</span> ${escapeXml(r.error)}</div>` : ""}
  </div>
  <h1 style="font-size:15px">Raw message</h1>
  <pre class="raw">${escapeXml(r.raw || "(raw message not stored)")}</pre>`;
  return layout(base, "Error", inner);
}

async function recordError(
  env: Env,
  { from_addr, subject, reason, error, rawBytes, receivedAt }: RecordErrorInput
): Promise<void> {
  let raw: string | null = null;
  try {
    raw = new TextDecoder("utf-8").decode(rawBytes);
  } catch (_) {
    raw = null; // non-text or undecodable; store nothing rather than fail
  }
  try {
    await env.DB.prepare(
      `INSERT INTO errors
         (from_addr, subject, reason, error, raw, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(from_addr ?? null, subject ?? null, reason, error ?? null, raw, receivedAt)
      .run();
  } catch (e) {
    // Last resort: if even the error insert fails, log it. Don't rethrow —
    // throwing here could cause Cloudflare to retry/bounce the message.
    console.error("failed to record error row:", e, "original reason:", reason);
  }
}

function escapeXml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// For embedding a full HTML document inside a double-quoted srcdoc attribute.
// Only & and " strictly need escaping for attribute safety; we also escape
// < and > defensively so the markup can't break out of the attribute.
function escapeAttr(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
