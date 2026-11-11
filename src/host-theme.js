// The install-wide theme for Lavish's own interface: the hub, the board chrome (top bar, presence
// pill, conversation panel, menus, banners, overlays), and the annotation UI the SDK draws inside an
// artifact. Board content an agent writes is never restyled.
//
// LAVISH_AXI_THEME, read once by the server at startup, selects a preset. Unset, empty, `default`,
// or an unknown value keeps the stock look, so an install that never sets it is unchanged.
//
// The stock look's tokens live in chrome.css and hub.css (and the SDK's shadow stylesheet). A
// preset is nothing but a token set laid over them: the server emits it as one `:root{...}` block
// after the stylesheet, and hands the board set to the SDK for its shadow root. Every interface
// colour therefore has to come from a custom property; a hard-coded colour would ignore the preset.

export const HOST_THEME_ENV = "LAVISH_AXI_THEME";

// night: dark, deep purple and violet accents, no blue. Every text pair holds WCAG AA (4.5:1) on
// the surfaces it sits on; test/host-theme.test.js checks the pairs.
const NIGHT_BOARD = {
  "color-scheme": "dark",
  bg: "#120b1f",
  "bg-panel": "#170e28",
  "bg-bar": "#1e1433",
  "bg-elevated": "#271a3e",
  "bg-hover": "#322349",
  "bg-active": "#3f2d5e",
  fg: "#f4effc",
  "fg-muted": "#e2d8f3",
  "fg-dim": "#d2c5e8",
  "fg-faint": "#bfb1d9",
  "fg-label": "#a998c9",
  "fg-code": "#ecdffb",
  "fg-soft": "rgba(244, 239, 252, 0.85)",
  "fg-strong": "#ffffff",
  border: "#3f2d5e",
  "border-subtle": "#322349",
  "border-strong": "#56417e",
  accent: "#c084fc",
  "accent-hover": "#d6abff",
  "accent-ink": "#1c0b30",
  "accent-line": "rgba(192, 132, 252, 0.4)",
  "accent-line-soft": "rgba(192, 132, 252, 0.35)",
  "accent-line-strong": "rgba(192, 132, 252, 0.6)",
  "accent-wash": "rgba(192, 132, 252, 0.22)",
  "accent-pulse": "rgba(192, 132, 252, 0.55)",
  "accent-pulse-end": "rgba(192, 132, 252, 0)",
  "highlight-bg": "rgba(192, 132, 252, 0.28)",
  "highlight-ring": "rgba(192, 132, 252, 0.45)",
  "notice-bg": "#251838",
  "notice-border": "#5b3d86",
  "notice-button-bg": "rgba(37, 24, 56, 0.72)",
  "notice-button-bg-hover": "rgba(91, 61, 134, 0.5)",
  "wash-hover": "rgba(244, 239, 252, 0.14)",
  ok: "#86e0a8",
  danger: "#ff7d95",
  "danger-line": "rgba(255, 125, 149, 0.4)",
  "danger-wash": "rgba(255, 125, 149, 0.1)",
  alert: "#ffa3b5",
  "alert-line": "#e5577a",
  scrim: "rgba(9, 5, 16, 0.72)",
  "scrim-strong": "rgba(9, 5, 16, 0.86)",
  "scrim-heavy": "rgba(9, 5, 16, 0.92)",
  "shadow-lift": "rgba(0, 0, 0, 0.6)",
  "shadow-tooltip": "0 16px 44px rgba(0, 0, 0, 0.45)",
  "shadow-floating": "0 20px 70px rgba(0, 0, 0, 0.5)",
};

// day: light and blue, a lightened take on the stock hub's paper-and-navy look.
const DAY_BOARD = {
  "color-scheme": "light",
  bg: "#f3f7fc",
  "bg-panel": "#ffffff",
  "bg-bar": "#e9f1fb",
  "bg-elevated": "#eef4fb",
  "bg-hover": "#e7eff9",
  "bg-active": "#cddcf0",
  fg: "#0d1b2e",
  "fg-muted": "#1f2f47",
  "fg-dim": "#2c3d57",
  "fg-faint": "#44556e",
  "fg-label": "#526279",
  "fg-code": "#173a66",
  "fg-soft": "rgba(13, 27, 46, 0.75)",
  "fg-strong": "#0d1b2e",
  border: "#c9d7e8",
  "border-subtle": "#dbe5f1",
  "border-strong": "#a6bad3",
  accent: "#1f5bd8",
  "accent-hover": "#1d4ed8",
  "accent-ink": "#ffffff",
  "accent-line": "rgba(31, 91, 216, 0.4)",
  "accent-line-soft": "rgba(31, 91, 216, 0.35)",
  "accent-line-strong": "rgba(31, 91, 216, 0.6)",
  "accent-wash": "rgba(31, 91, 216, 0.16)",
  "accent-pulse": "rgba(31, 91, 216, 0.5)",
  "accent-pulse-end": "rgba(31, 91, 216, 0)",
  "highlight-bg": "rgba(31, 91, 216, 0.2)",
  "highlight-ring": "rgba(31, 91, 216, 0.45)",
  "notice-bg": "#e8f0fe",
  "notice-border": "#a9c4f5",
  "notice-button-bg": "rgba(31, 91, 216, 0.08)",
  "notice-button-bg-hover": "rgba(31, 91, 216, 0.16)",
  "wash-hover": "rgba(13, 27, 46, 0.08)",
  ok: "#1e8a4c",
  danger: "#c0283b",
  "danger-line": "rgba(192, 40, 59, 0.4)",
  "danger-wash": "rgba(192, 40, 59, 0.08)",
  alert: "#b4380f",
  "alert-line": "#d9622f",
  scrim: "rgba(13, 27, 46, 0.45)",
  "scrim-strong": "rgba(13, 27, 46, 0.6)",
  "scrim-heavy": "rgba(13, 27, 46, 0.7)",
  "shadow-lift": "rgba(13, 27, 46, 0.18)",
  "shadow-tooltip": "0 16px 44px rgba(13, 27, 46, 0.16)",
  "shadow-floating": "0 20px 70px rgba(13, 27, 46, 0.22)",
};

const NIGHT_HUB = {
  "color-scheme": "dark",
  paper: "#120d1d",
  card: "#1b1429",
  line: "#2f2445",
  "line-strong": "#43345f",
  ink: "#f4effc",
  body: "#c6b8de",
  mark: "#e879f9",
  "mark-text": "#f0abfc",
  "link-mark": "#c084fc",
  link: "#d8b4fe",
  good: "#86e0a8",
  bad: "#ff8fa3",
  "warn-ink": "#f5c97a",
  "warn-fill": "#2b2013",
  "warn-line": "#8a6420",
  "you-fill": "#2a1838",
  "you-line": "#4a2d5e",
  well: "#241a36",
  "card-shadow": "rgba(0, 0, 0, 0.4)",
  "hero-bg": "#0b0716",
  "hero-ink": "#ffffff",
  "hero-kicker": "#e6dcf5",
  "hero-lede": "#ece4f8",
  "hero-shadow": "rgba(11, 7, 22, 0.55)",
  "pill-ink": "#e9d5ff",
  "pill-good": "#a7f3c8",
  band: "#0c0818",
  "tab-ink": "#cbbde3",
  "tab-active": "#ffffff",
  backdrop: "rgba(9, 5, 16, 0.6)",
  "sky-0": "#0b0716",
  "sky-1": "#231140",
  "sky-2": "#4a2470",
  "sky-3": "#8c5aae",
  "sun-0": "#fbf6ff",
  "sun-1": "#e2cdfb",
  glow: "#e2cdfb",
  ridge: "#3a2560",
  "peak-lit": "#4a2b72",
  "peak-shade": "#1d1036",
  "peak-lit-2": "#553284",
  "peak-shade-2": "#251444",
  "peak-lit-3": "#4f2e7c",
  "peak-shade-3": "#20113d",
  shore: "#140a26",
  sea: "#3b1f63",
  surf: "#c9a6ef",
  sand: "#4a3a5e",
  "sand-edge": "#7a6390",
};

const DAY_HUB = {
  "color-scheme": "light",
  paper: "#f5f9fe",
  card: "#ffffff",
  line: "#dde7f3",
  "line-strong": "#c7d6e9",
  ink: "#0d1b2e",
  body: "#4d5d74",
  mark: "#2563eb",
  "mark-text": "#1d4ed8",
  "link-mark": "#7cc4f8",
  link: "#1d4ed8",
  good: "#1e7a4d",
  bad: "#b42318",
  "warn-ink": "#8a5300",
  "warn-fill": "#fff3dc",
  "warn-line": "#f2c46d",
  "you-fill": "#e8f0fe",
  "you-line": "#c6d8f8",
  well: "#eaf1fb",
  "card-shadow": "rgba(13, 27, 46, 0.1)",
  "hero-bg": "#1d4a86",
  "hero-ink": "#ffffff",
  "hero-kicker": "#e4effb",
  "hero-lede": "#f2f7fd",
  "hero-shadow": "rgba(13, 37, 77, 0.6)",
  "pill-ink": "#ffffff",
  "pill-good": "#c8f5dd",
  band: "#1d4a86",
  "tab-ink": "#d7e6f7",
  "tab-active": "#ffffff",
  backdrop: "rgba(13, 37, 77, 0.35)",
  "sky-0": "#1d4a86",
  "sky-1": "#2c66ab",
  "sky-2": "#4b8bc8",
  "sky-3": "#bfe3f5",
  "sun-0": "#fffaf0",
  "sun-1": "#ffe7b0",
  glow: "#ffe7b0",
  ridge: "#3d73ad",
  "peak-lit": "#3b74b0",
  "peak-shade": "#24538c",
  "peak-lit-2": "#3d77b3",
  "peak-shade-2": "#275891",
  "peak-lit-3": "#3a72ad",
  "peak-shade-3": "#25558e",
  shore: "#2a5a94",
  sea: "#4fa3cf",
  surf: "#e3f4fb",
  sand: "#f3e6c9",
  "sand-edge": "#fdf7ea",
};

const PRESETS = Object.freeze({
  night: Object.freeze({ board: Object.freeze(NIGHT_BOARD), hub: Object.freeze(NIGHT_HUB) }),
  day: Object.freeze({ board: Object.freeze(DAY_BOARD), hub: Object.freeze(DAY_HUB) }),
});

export const HOST_THEMES = Object.freeze(Object.keys(PRESETS));

/**
 * The preset LAVISH_AXI_THEME names, or "" for the stock look.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"" | "night" | "day"}
 */
export function resolveHostTheme(env = process.env) {
  const raw = String(env[HOST_THEME_ENV] ?? "")
    .trim()
    .toLowerCase();
  return Object.hasOwn(PRESETS, raw) ? /** @type {"night" | "day"} */ (raw) : "";
}

/**
 * A preset's tokens for one surface, or null for the stock look.
 * @param {string} theme
 * @param {"board" | "hub"} surface
 * @returns {Readonly<Record<string, string>> | null}
 */
export function hostThemeTokens(theme, surface) {
  if (!Object.hasOwn(PRESETS, theme)) return null;
  return PRESETS[/** @type {"night" | "day"} */ (theme)][surface] || null;
}

/**
 * The CSS that lays a preset over a stylesheet's stock tokens: `<selector>{color-scheme:..;--token:value;...}`.
 * Empty for the stock look. `color-scheme` is emitted both as the property and as a token, so a
 * stylesheet can use either.
 * @param {string} theme
 * @param {"board" | "hub"} surface
 * @param {string} [selector]
 */
export function hostThemeCss(theme, surface, selector = ":root") {
  const tokens = hostThemeTokens(theme, surface);
  if (!tokens) return "";
  const declarations = Object.entries(tokens).map(([name, value]) => `--${name}:${value}`);
  return `${selector}{color-scheme:${tokens["color-scheme"]};${declarations.join(";")}}`;
}

/**
 * The page-level markup a server-rendered Lavish page needs for a preset: the `<html>` attribute
 * and the `<style>` block that must follow the page's stylesheet link.
 * @param {string} theme
 * @param {"board" | "hub"} surface
 */
export function hostThemeMarkup(theme, surface) {
  const css = hostThemeCss(theme, surface);
  if (!css) return { htmlAttribute: "", style: "" };
  return {
    htmlAttribute: ` data-lavish-theme="${theme}"`,
    style: `<style id="lavish-host-theme">${css}</style>`,
  };
}
