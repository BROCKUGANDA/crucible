import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What the edge does to the response headers, asserted on the statements Caddy parses.
 *
 * The 2026-10-29 browser audit found `Via: 1.1 Caddy` and `X-Powered-By: Next.js` on the public
 * origin. The comment block above `(secure_defaults)` now *explains* both deletions and contains
 * both strings — which is precisely the trap AGENTS.md records for `--strict`: a gate written
 * against the file's prose stays green after the executed line is deleted. So every assertion
 * here runs against `code()`, comment lines removed, and against the parsed body of the `header`
 * block rather than the file as a whole.
 */

const here = dirname(fileURLToPath(import.meta.url));
// LF-normalised on read: the working tree of a Windows checkout is CRLF while the blobs are LF.
const read = (rel) => readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");

/** Non-comment lines, joined — the directives Caddy actually reads. */
function code(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** The body of the named snippet, from comments stripped, as directive lines. */
function snippetBody(caddy, name) {
  const open = caddy.indexOf(`(${name}) {`);
  assert.ok(open !== -1, `the (${name}) snippet is gone — nothing defines these headers any more`);
  const close = caddy.indexOf("\n}", open);
  assert.ok(close !== -1, `the (${name}) snippet is not closed`);
  return caddy
    .slice(open, close)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("the edge deletes its own Via and the app's X-Powered-By", () => {
  const caddy = code(read("./Caddyfile"));
  const directives = snippetBody(caddy, "secure_defaults");
  // Exact-line equality, not `includes`: the snippet's own comments name these headers, and a
  // substring test would be satisfied by prose. Only the executed statement counts.
  assert.ok(directives.includes("-Via"), "Via is no longer deleted — the edge again advertises Caddy");
  assert.ok(
    directives.includes("-X-Powered-By"),
    "X-Powered-By is no longer deleted at the edge (the app also disables it; this is the belt)",
  );
  // The deletion that was already there must survive the edit, or the snippet has changed more
  // than the finding asked for.
  assert.ok(directives.includes("-Server"), "-Server was dropped along the way");
});

test("the site that answers the public hostname imports those defaults", () => {
  const caddy = code(read("./Caddyfile"));
  const open = caddy.indexOf("crucible.svalley.tech {");
  assert.ok(open !== -1, "the public hostname block is gone");
  // The import must precede the first route, or the header directives never apply to it.
  const handleAt = caddy.indexOf("handle", open);
  const importAt = caddy.indexOf("import secure_defaults", open);
  assert.ok(importAt !== -1, "the public site does not import the header snippet");
  assert.ok(handleAt !== -1 && importAt < handleAt, "secure_defaults is imported after the routes begin");
});

test("the CSP is not set here, so next.config.mjs is the header the browser sees", () => {
  // The audit's CSP findings can only be fixed in one place. If a second CSP ever appears at the
  // edge, two sources of truth exist and the one that wins depends on directive ordering — so
  // this asserts the absence, and the file it lives in is apps/web/next.config.mjs.
  const caddy = code(read("./Caddyfile"));
  assert.doesNotMatch(caddy, /Content-Security-Policy/, "the edge now sets a CSP too — two sources of truth");
});
