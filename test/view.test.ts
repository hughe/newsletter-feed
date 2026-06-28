// Tests for the chrome-free /view "fit to screen" injection. Run with `make test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { injectMobileFit } from "../index.ts";

test("injects fit CSS into an existing <head>", () => {
  const out = injectMobileFit(
    '<html><head><meta charset="utf-8"></head><body><table width="600">x</table></body></html>'
  );
  assert.match(out, /max-width:100%!important/);
  // The original head contents are preserved.
  assert.match(out, /<meta charset="utf-8">/);
});

test("adds a viewport meta when the document lacks one", () => {
  const out = injectMobileFit("<html><head></head><body>hi</body></html>");
  assert.match(out, /name="viewport" content="width=device-width/);
});

test("does not add a second viewport when one already exists", () => {
  const html =
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>hi</body></html>';
  const out = injectMobileFit(html);
  assert.equal(out.match(/name="viewport"/g)?.length, 1);
  assert.match(out, /max-width:100%!important/); // fit CSS still injected
});

test("wraps a <head> around a document that has none", () => {
  const out = injectMobileFit("<html><body>no head here</body></html>");
  assert.match(out, /<head>.*max-width:100%!important.*<\/head>/s);
  assert.match(out, /no head here/);
});
