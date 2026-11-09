import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOwnerStatus,
  OWNER_DETAIL_MAX,
  OWNER_LABEL_MAX,
  OwnerStatusError,
  serializeOwnerStatus,
} from "../src/owner-status.js";

const NOW = Date.parse("2026-11-09T21:00:00.000Z");

test("a status write keeps the four states and rejects anything else", () => {
  for (const state of ["live", "working", "finished", "gone"]) {
    assert.equal(normalizeOwnerStatus({ state }, { now: NOW })?.state, state);
  }
  for (const state of ["", "online", undefined, null, 3]) {
    assert.throws(() => normalizeOwnerStatus({ state }, { now: NOW }), OwnerStatusError);
  }
  assert.equal(normalizeOwnerStatus({ clear: true, state: "nonsense" }), null, "a clear needs no state");
});

test("labels and details are one bounded line of text", () => {
  const record = normalizeOwnerStatus(
    { state: "live", label: "  task\n\t42\u0000  ", detail: "x".repeat(OWNER_DETAIL_MAX + 50) },
    { now: NOW },
  );
  assert.equal(record?.label, "task 42");
  assert.equal(record?.detail.length, OWNER_DETAIL_MAX);
  assert.ok(record?.detail.endsWith("…"));
  assert.equal(normalizeOwnerStatus({ state: "live", label: "y".repeat(500) })?.label.length, OWNER_LABEL_MAX);
});

test("a ttl makes the status lapse; without one it holds until replaced", () => {
  const record = normalizeOwnerStatus({ state: "live", ttl_seconds: 90 }, { now: NOW });
  assert.equal(record?.expires_at, "2026-11-09T21:01:30.000Z");
  assert.deepEqual(serializeOwnerStatus(record, { now: NOW + 30_000 }), {
    state: "live",
    label: "",
    detail: "",
    updated_at: "2026-11-09T21:00:00.000Z",
    stale: false,
    expires_in_ms: 60_000,
  });
  const lapsed = serializeOwnerStatus(record, { now: NOW + 91_000 });
  assert.equal(lapsed?.stale, true);
  assert.equal(lapsed?.expires_in_ms, 0);

  const standing = serializeOwnerStatus(normalizeOwnerStatus({ state: "finished" }, { now: NOW }), {
    now: NOW + 10 * 24 * 3600 * 1000,
  });
  assert.equal(standing?.stale, false);
  assert.equal(standing?.expires_in_ms, null);

  for (const ttl of [0, -1, Number.NaN, "soon", 10 * 24 * 3600]) {
    assert.throws(() => normalizeOwnerStatus({ state: "live", ttl_seconds: ttl }), OwnerStatusError);
  }
});

test("a stored record that is not a status serializes as none", () => {
  assert.equal(serializeOwnerStatus(null), null);
  assert.equal(serializeOwnerStatus({ state: "asleep" }), null);
  assert.equal(serializeOwnerStatus("live"), null);
});
