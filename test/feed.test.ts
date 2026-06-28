// Tests for RSS feed construction. Run with `make test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRss } from "../index.ts";

const row = {
  id: 42,
  message_id: "<abc@example.com>",
  from_addr: "twir@rust-lang.org",
  from_name: "This Week in Rust",
  subject: "This Week in Rust #657",
  html: "<p>hello</p>",
  text: "hello",
  received_at: 1782657088,
};

test("each item gets an open-in-browser <link> to the Worker's email view", () => {
  const url = new URL("https://newsletter-rss.example.workers.dev/feed/TOKEN.xml");
  const xml = buildRss([row], url, "Forwarded Newsletters", "TOKEN");
  assert.match(
    xml,
    /<link>https:\/\/newsletter-rss\.example\.workers\.dev\/feed\/TOKEN\/email\/42<\/link>/
  );
  // The stable guid stays the message-id, not the link.
  assert.match(xml, /<guid isPermaLink="false">&lt;abc@example\.com&gt;<\/guid>/);
});

test("buildRss tolerates an empty feed", () => {
  const url = new URL("https://example.workers.dev/feed/TOKEN.xml");
  const xml = buildRss([], url, "Forwarded Newsletters", "TOKEN");
  assert.match(xml, /<channel>/);
  assert.doesNotMatch(xml, /<item>/);
});
