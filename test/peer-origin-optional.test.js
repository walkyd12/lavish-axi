import "./isolate-hooks.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Older hub tabs and API callers send no peer_origin; they must keep working (only a SENT, changed origin is refused).
test("peer lifecycle routes accept requests without peer_origin", () => {
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const guards =
    src.match(/req\.body\?\.peer_origin !== undefined && req\.body\?\.peer_origin !== target\.peer\.origin/g) || [];
  assert.equal(guards.length, 3);
});
