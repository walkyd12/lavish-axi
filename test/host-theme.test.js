import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { HOST_THEMES, hostThemeCss, hostThemeMarkup, hostThemeTokens, resolveHostTheme } from "../src/host-theme.js";
import { createChromeHtml, createDeniedHtml, createSdkJs, serve } from "../src/server.js";
import { createHubHtml } from "../src/hub.js";

const chromeCss = await readFile(new URL("../src/chrome.css", import.meta.url), "utf8");
const hubCss = await readFile(new URL("../src/hub.css", import.meta.url), "utf8");

const COLOR_LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?<![-\w])(?:white|black)(?![-\w])/i;

// The first `:root { ... }` block of a stylesheet: the stock token declarations.
function rootBlock(css) {
  const start = css.indexOf(":root {");
  return css.slice(start, css.indexOf("\n}", start) + 2);
}

function declaredTokens(block) {
  return new Map([...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)].map((match) => [match[1], match[2].trim()]));
}

function usedTokens(css) {
  return new Set([...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]));
}

// A token a preset leaves alone still follows the preset when every colour it carries comes from
// tokens the preset sets (`--hairline: 1px solid var(--border)`). One with its own colour literal
// would keep the stock colour under every preset.
function followsPreset(name, stock, preset, seen = new Set()) {
  if (Object.hasOwn(preset, name)) return true;
  const value = stock.get(name);
  if (value === undefined || seen.has(name)) return true;
  seen.add(name);
  if (COLOR_LITERAL.test(value)) return false;
  return [...value.matchAll(/var\(--([a-z0-9-]+)/gi)].every((match) => followsPreset(match[1], stock, preset, seen));
}

function hexToRgb(hex) {
  let value = hex.replace("#", "");
  if (value.length === 3) value = [...value].map((char) => char + char).join("");
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hueSaturation(hex) {
  const [r, g, b] = hexToRgb(hex).map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta + 6) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  return { hue, saturation };
}

function colorsIn(value) {
  const hexes = [...value.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0].slice(0, 7));
  const rgbas = [...value.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/gi)].map(
    (match) =>
      "#" +
      match
        .slice(1, 4)
        .map((n) => Number(n).toString(16).padStart(2, "0"))
        .join(""),
  );
  return [...hexes, ...rgbas];
}

test("LAVISH_AXI_THEME selects a preset and anything else keeps the stock look", () => {
  assert.deepEqual([...HOST_THEMES], ["night", "day"]);
  assert.equal(resolveHostTheme({}), "");
  assert.equal(resolveHostTheme({ LAVISH_AXI_THEME: "" }), "");
  assert.equal(resolveHostTheme({ LAVISH_AXI_THEME: "default" }), "");
  assert.equal(resolveHostTheme({ LAVISH_AXI_THEME: "solarized" }), "");
  assert.equal(resolveHostTheme({ LAVISH_AXI_THEME: "constructor" }), "");
  assert.equal(resolveHostTheme({ LAVISH_AXI_THEME: "night" }), "night");
  assert.equal(resolveHostTheme({ LAVISH_AXI_THEME: " Night " }), "night");
  assert.equal(resolveHostTheme({ LAVISH_AXI_THEME: "DAY" }), "day");
});

test("the stock look emits no theme markup", () => {
  assert.equal(hostThemeCss("", "board"), "");
  assert.deepEqual(hostThemeMarkup("", "hub"), { htmlAttribute: "", style: "" });
  assert.equal(hostThemeTokens("", "board"), null);
  assert.equal(hostThemeTokens("toString", "board"), null);

  const chrome = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  assert.match(chrome, /<html>\n<head>/);
  assert.doesNotMatch(chrome, /data-lavish-theme|lavish-host-theme/);
  const hub = createHubHtml({ boards: [], hostname: "schlab" });
  assert.match(hub, /<html lang="en">/);
  assert.doesNotMatch(hub, /data-lavish-theme|lavish-host-theme/);
  const sdk = createSdkJs("abc");
  assert.match(sdk, /"themeCss":""/);
  assert.match(sdk, /"themeAccent":""/);
});

test("a preset is a token block laid after each page's stylesheet", () => {
  for (const theme of HOST_THEMES) {
    const chrome = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" }, { theme });
    assert.match(chrome, new RegExp(`<html data-lavish-theme="${theme}">`));
    assert.match(
      chrome,
      /<link rel="stylesheet" href="\/chrome\.css">\n<style id="lavish-host-theme">:root\{color-scheme:(dark|light);--color-scheme:/,
    );
    assert.ok(chrome.includes(hostThemeCss(theme, "board")));

    const hub = createHubHtml({ boards: [], hostname: "schlab", theme });
    assert.match(hub, new RegExp(`<html lang="en" data-lavish-theme="${theme}">`));
    assert.match(hub, /<link rel="stylesheet" href="\/hub\.css">\n<style id="lavish-host-theme">:root\{/);
    assert.ok(hub.includes(hostThemeCss(theme, "hub")));

    const denied = createDeniedHtml({ title: "Session not found", message: "m", workingUrl: "http://x/", theme });
    assert.ok(denied.includes(hostThemeCss(theme, "hub")));
    assert.ok(
      denied.indexOf("lavish-host-theme") > denied.indexOf("--well:#f0ebe4"),
      "preset follows the stock tokens",
    );
  }
});

test("the SDK gets the board preset for its shadow root and its outline accent", () => {
  const sdk = createSdkJs("abc", 0, "", { theme: "night" });
  const options = JSON.parse(sdk.match(/, key, (\{.*\})\);\n\}\)\(\);$/)[1]);
  assert.equal(options.themeCss, hostThemeCss("night", "board", ":host"));
  assert.match(options.themeCss, /^:host\{color-scheme:dark;/);
  assert.equal(options.themeAccent, hostThemeTokens("night", "board").accent);
  // The preset is appended after the stock shadow tokens, so it wins at equal specificity.
  assert.match(sdk, /@keyframes lavish-reveal-pulse\{[^`]*\}\$\{themeCss\}`/);
});

test("night and day define the same token names", () => {
  for (const surface of /** @type {const} */ (["board", "hub"])) {
    assert.deepEqual(
      Object.keys(hostThemeTokens("night", surface)).sort(),
      Object.keys(hostThemeTokens("day", surface)).sort(),
      surface,
    );
  }
});

test("chrome.css keeps every interface colour in its :root tokens", () => {
  const root = rootBlock(chromeCss);
  const rest = chromeCss.replace(root, "");
  for (const line of rest.split("\n")) {
    assert.doesNotMatch(line, COLOR_LITERAL, `hard-coded colour outside :root: ${line.trim()}`);
  }
});

test("hub.css keeps every colour in its :root tokens", () => {
  const root = rootBlock(hubCss);
  const rest = hubCss.replace(root, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const line of rest.split("\n")) {
    assert.doesNotMatch(line, COLOR_LITERAL, `hard-coded colour outside :root: ${line.trim()}`);
  }
});

test("the hub header landscape draws from tokens", async () => {
  const hub = createHubHtml({ boards: [], hostname: "schlab" });
  const svg = hub.match(/<svg class="scape"[\s\S]*?<\/svg>/)[0];
  const outsideMask = svg.replace(/<mask[\s\S]*?<\/mask>/, "");
  assert.doesNotMatch(outsideMask, /(?:fill|stroke|stop-color)="#/);
  const stock = declaredTokens(rootBlock(hubCss));
  for (const name of usedTokens(svg)) assert.ok(stock.has(name), `hub.css declares --${name}`);
});

test("every colour token the chrome and SDK use follows each preset", () => {
  const stock = declaredTokens(rootBlock(chromeCss));
  const sdk = createSdkJs("abc");
  const shadowCss = sdk.slice(sdk.indexOf(":host{all:initial;"), sdk.indexOf("${themeCss}"));
  const shadowStock = declaredTokens(shadowCss.slice(0, shadowCss.indexOf("}")).replace(/;/g, ";\n"));
  // Behind the artifact iframe: board content owns its own look, so no preset changes it.
  const exempt = new Set(["frame-bg"]);
  for (const theme of HOST_THEMES) {
    const preset = hostThemeTokens(theme, "board");
    for (const name of usedTokens(chromeCss.replace(rootBlock(chromeCss), ""))) {
      if (exempt.has(name)) continue;
      assert.ok(followsPreset(name, stock, preset), `${theme}: chrome.css --${name}`);
    }
    for (const name of usedTokens(shadowCss.slice(shadowCss.indexOf("}")))) {
      assert.ok(followsPreset(name, shadowStock, preset), `${theme}: SDK --${name}`);
    }
  }
});

test("every colour token the hub uses follows each preset", () => {
  const stock = declaredTokens(rootBlock(hubCss));
  const hub = createHubHtml({ boards: [], hostname: "schlab" });
  const used = new Set([...usedTokens(hubCss.replace(rootBlock(hubCss), "")), ...usedTokens(hub)]);
  for (const theme of HOST_THEMES) {
    const preset = hostThemeTokens(theme, "hub");
    for (const name of used) assert.ok(followsPreset(name, stock, preset), `${theme}: hub --${name}`);
  }
});

test("the denied page's colour tokens all come from the hub preset", () => {
  const denied = createDeniedHtml({ title: "t", message: "m", workingUrl: "http://x/" });
  const stockBlock = denied.match(/<style>:root\{([^}]*)\}/)[1];
  const names = [...stockBlock.matchAll(/--([a-z-]+):/g)].map((match) => match[1]);
  for (const theme of HOST_THEMES) {
    const preset = hostThemeTokens(theme, "hub");
    for (const name of names) assert.ok(Object.hasOwn(preset, name), `${theme}: --${name}`);
  }
});

test("preset text colours meet WCAG AA on the surfaces they sit on", () => {
  const pairs = {
    board: [
      [
        ["fg", "fg-muted", "fg-dim", "fg-faint", "fg-label", "fg-code", "accent", "accent-hover", "danger", "alert"],
        ["bg", "bg-panel", "bg-bar", "bg-elevated", "bg-hover"],
      ],
      [["accent-ink"], ["accent", "accent-hover"]],
      [["accent-hover", "fg"], ["notice-bg"]],
    ],
    hub: [
      [
        ["ink", "body", "link", "mark-text", "good", "bad", "warn-ink"],
        ["paper", "card"],
      ],
      [
        ["hero-ink", "hero-kicker", "hero-lede", "pill-ink", "pill-good"],
        ["hero-bg", "sky-0", "sky-1"],
      ],
      [["tab-ink", "tab-active"], ["band"]],
      [["warn-ink"], ["warn-fill"]],
      [
        ["ink", "body"],
        ["you-fill", "well"],
      ],
    ],
  };
  for (const theme of HOST_THEMES) {
    for (const [surface, groups] of Object.entries(pairs)) {
      const tokens = hostThemeTokens(theme, /** @type {"board" | "hub"} */ (surface));
      for (const [fgs, bgs] of groups) {
        for (const fg of fgs) {
          for (const bg of bgs) {
            const ratio = contrast(tokens[fg], tokens[bg]);
            assert.ok(ratio >= 4.5, `${theme} ${surface}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1`);
          }
        }
      }
    }
  }
});

test("night carries no blue: every saturated colour is violet, purple, or a status hue", () => {
  for (const surface of /** @type {const} */ (["board", "hub"])) {
    for (const [name, value] of Object.entries(hostThemeTokens("night", surface))) {
      for (const color of colorsIn(value)) {
        const { hue, saturation } = hueSaturation(color);
        if (saturation < 0.2) continue;
        assert.ok(hue < 170 || hue >= 255, `night ${surface} --${name} ${color} has hue ${hue.toFixed(0)}`);
      }
    }
  }
});

test("day is light and blue", () => {
  const board = hostThemeTokens("day", "board");
  const hub = hostThemeTokens("day", "hub");
  assert.equal(board["color-scheme"], "light");
  assert.equal(hub["color-scheme"], "light");
  assert.ok(luminance(board.bg) > 0.85 && luminance(hub.paper) > 0.85);
  for (const color of [board.accent, hub.mark, hub.link]) {
    const { hue } = hueSaturation(color);
    assert.ok(hue >= 200 && hue < 240, `${color} is blue (hue ${hue.toFixed(0)})`);
  }
});

test("night is dark with a purple accent", () => {
  const board = hostThemeTokens("night", "board");
  const hub = hostThemeTokens("night", "hub");
  assert.equal(board["color-scheme"], "dark");
  assert.ok(luminance(board.bg) < 0.02 && luminance(hub.paper) < 0.02);
  for (const color of [board.accent, hub["link-mark"], hub.link]) {
    const { hue } = hueSaturation(color);
    assert.ok(hue >= 260 && hue < 300, `${color} is purple (hue ${hue.toFixed(0)})`);
  }
});

test("serve reads LAVISH_AXI_THEME from its environment for every interface page", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-theme-"));
  const file = path.join(dir, "board.html");
  await writeFile(file, "<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>");
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    env: { ...process.env, LAVISH_AXI_HOST: "127.0.0.1", LAVISH_AXI_THEME: "night" },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const { key } = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
    }).then((response) => response.json());
    const hub = await fetch(`${base}/`).then((response) => response.text());
    assert.ok(hub.includes(hostThemeCss("night", "hub")));
    const chrome = await fetch(`${base}/session/${key}`).then((response) => response.text());
    assert.ok(chrome.includes(hostThemeCss("night", "board")));
    const missing = await fetch(`${base}/session/0000000000000000`, { headers: { accept: "text/html" } });
    assert.equal(missing.status, 404);
    assert.ok((await missing.text()).includes(hostThemeCss("night", "hub")));
  } finally {
    await server.close();
  }
});
