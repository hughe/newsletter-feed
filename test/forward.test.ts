// Tests for inline-forward unwrapping. Run with `make test` (Node strips the
// TypeScript types natively — no build step, no extra dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ingest, unwrapForwardedHtml } from "../index.ts";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

// ---- Unit: unwrapForwardedHtml on the raw client markup -------------------

test("Apple Mail forward: recovers sender/subject and strips the preamble", () => {
  const html =
    '<body><blockquote type="cite"><div>Begin forwarded message:</div>' +
    '<br class="Apple-interchange-newline">' +
    '<div><span><b>From: </b></span><span>This Week in Rust &lt;twir@rust-lang.org&gt;<br></span></div>' +
    '<div><span><b>Subject: </b></span><span><b>This Week in Rust #657</b><br></span></div>' +
    '<div><span><b>Date: </b></span><span>June 26, 2026 at 03:02:52 GMT+2<br></span></div>' +
    '<br><div><table class="body"><tr><td>REAL CONTENT</td></tr></table></div>' +
    "</blockquote></body>";
  const fwd = unwrapForwardedHtml(html);
  assert.ok(fwd, "expected a wrapper to be detected");
  assert.equal(fwd.subject, "This Week in Rust #657");
  assert.equal(fwd.fromAddr, "twir@rust-lang.org");
  assert.equal(fwd.fromName, "This Week in Rust");
  assert.match(fwd.html, /REAL CONTENT/);
  assert.doesNotMatch(fwd.html, /Begin forwarded message/);
  assert.doesNotMatch(fwd.html, /Subject:/);
});

test("Gmail forward: recovers sender/subject and strips the preamble", () => {
  const html =
    '<div dir="ltr"><div class="gmail_quote">' +
    '<div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>' +
    'From: <strong class="gmail_sendername">This Week in Rust</strong> <span>&lt;twir@rust-lang.org&gt;</span><br>' +
    "Date: Fri, Jun 26, 2026 at 3:02 AM<br>" +
    "Subject: This Week in Rust #657<br>" +
    "To: &lt;hugh.emberson@gmail.com&gt;<br></div>" +
    '<br><div><table class="body"><tr><td>REAL CONTENT</td></tr></table></div>' +
    "</div></div>";
  const fwd = unwrapForwardedHtml(html);
  assert.ok(fwd, "expected a wrapper to be detected");
  assert.equal(fwd.subject, "This Week in Rust #657");
  assert.equal(fwd.fromAddr, "twir@rust-lang.org");
  assert.equal(fwd.fromName, "This Week in Rust");
  assert.match(fwd.html, /REAL CONTENT/);
  assert.doesNotMatch(fwd.html, /Forwarded message/);
});

test("plain newsletter (not a forward) is left untouched", () => {
  const html =
    '<!DOCTYPE html><html><body><table class="body"><tr><td>Hello</td></tr></table></body></html>';
  assert.equal(unwrapForwardedHtml(html), null);
});

// ---- Integration: full ingest() over real .eml fixtures -------------------

test("ingest() unwraps an Apple Mail forwarded .eml end to end", async () => {
  const r = await ingest(fixture("apple-forward.eml"), "hugh.emberson@gmail.com");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.subject, "This Week in Rust #657"); // not "Fwd: ..."
  assert.equal(r.from_addr, "twir@rust-lang.org"); // not the forwarder
  assert.equal(r.from_name, "This Week in Rust");
  assert.match(r.html, /APPLE-CONTENT-MARKER/);
  assert.doesNotMatch(r.html, /Begin forwarded message/);
});

test("ingest() unwraps a Gmail forwarded .eml end to end", async () => {
  const r = await ingest(fixture("gmail-forward.eml"), "hugh.emberson@gmail.com");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.subject, "This Week in Rust #657");
  assert.equal(r.from_addr, "twir@rust-lang.org");
  assert.equal(r.from_name, "This Week in Rust");
  assert.match(r.html, /GMAIL-CONTENT-MARKER/);
  assert.doesNotMatch(r.html, /Forwarded message/);
});
