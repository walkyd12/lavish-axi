import assert from "node:assert/strict";
import test from "node:test";

import {
  bindHost,
  clientHost,
  extraAllowedHosts,
  hostForUrl,
  LOOPBACK_HOST,
  linkHost,
  publicBaseUrl,
} from "../src/paths.js";

test("bindHost defaults to loopback and honors LAVISH_AXI_HOST", () => {
  assert.equal(bindHost({}), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "" }), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "  " }), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(bindHost({ LAVISH_AXI_HOST: " 0.0.0.0 " }), "0.0.0.0");
});

test("clientHost dials the concrete primary listener for wildcard binds", () => {
  assert.equal(clientHost({}), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(clientHost({ LAVISH_AXI_HOST: "0.0.0.0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "::" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "[::]" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "0:0:0:0:0:0:0:0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "[0:0:0:0:0:0:0:0]" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "::ffff:0.0.0.0" }), LOOPBACK_HOST);
});

test("extraAllowedHosts parses the whitespace-separated opt-in list", () => {
  assert.deepEqual(extraAllowedHosts({}), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "" }), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "  " }), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "proxy.example" }), ["proxy.example"]);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "  a.example   b.example\tc.example  " }), [
    "a.example",
    "b.example",
    "c.example",
  ]);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "*" }), ["*"]);
});

test("linkHost prefers LAVISH_AXI_LINK_HOST, then falls back to the dial host", () => {
  assert.equal(linkHost({}), LOOPBACK_HOST);
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "host.example" }), "host.example");
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "  " }), LOOPBACK_HOST);
  // Non-wildcard bind with no explicit link host -> links reuse the bind address.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  // Wildcard bind with an explicit link host -> links use the hostname, not 0.0.0.0.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "0.0.0.0", LAVISH_AXI_LINK_HOST: "host.example" }), "host.example");
  // IPv6 wildcard bind with no explicit link host -> links use the concrete loopback listener.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "::" }), LOOPBACK_HOST);
});

test("hostForUrl brackets IPv6 literals but leaves IPv4 and hostnames alone", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("host.example"), "host.example");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("[::1]"), "[::1]");
});

test("publicBaseUrl normalizes LAVISH_AXI_PUBLIC_URL to a bare origin", () => {
  assert.equal(publicBaseUrl({}), "");
  assert.equal(publicBaseUrl({ LAVISH_AXI_PUBLIC_URL: "   " }), "");
  assert.equal(publicBaseUrl({ LAVISH_AXI_PUBLIC_URL: "https://boards.schip.as" }), "https://boards.schip.as");
  assert.equal(publicBaseUrl({ LAVISH_AXI_PUBLIC_URL: " https://boards.schip.as/ " }), "https://boards.schip.as");
  assert.equal(publicBaseUrl({ LAVISH_AXI_PUBLIC_URL: "https://boards.schip.as//" }), "https://boards.schip.as");
  assert.equal(
    publicBaseUrl({ LAVISH_AXI_PUBLIC_URL: "HTTPS://Boards.Schip.AS:8443" }),
    "https://boards.schip.as:8443",
  );
  assert.equal(publicBaseUrl({ LAVISH_AXI_PUBLIC_URL: "http://boards.lan" }), "http://boards.lan");
});

test("publicBaseUrl refuses values that cannot produce working root-relative links", () => {
  for (const value of [
    "boards.schip.as",
    "ftp://boards.schip.as",
    "https://boards.schip.as/lavish",
    "https://boards.schip.as/?x=1",
    "https://boards.schip.as/#top",
    "https://user:pw@boards.schip.as",
    "not a url",
  ]) {
    assert.throws(() => publicBaseUrl({ LAVISH_AXI_PUBLIC_URL: value }), /LAVISH_AXI_PUBLIC_URL/, value);
  }
});
