import { boardSearchText } from "./board-metadata.js";

// Use the same bounded 64 KiB slice already read for cards. Never execute page code.
export function hubArtifactSummary(html) {
  const visible = String(html)
    .slice(0, 65536)
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const text = (value, max) => {
    if (!value) return "";
    const plain = /[<&]/.test(value) ? boardSearchText(value) : value.replace(/\s+/g, " ").trim();
    return plain.slice(0, max);
  };
  const heading = visible.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  const title = visible.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const explicit = visible.match(
    /<([\w-]+)\b[^>]*\bdata-lavish-next-step(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/\1\s*>/i,
  );
  const label =
    /<(h[1-6]|p|div|span|strong)\b[^>]*>[^<>]{0,80}\bnext steps?\s*:?\s*<\/\1\s*>\s*<(h[1-6]|p|div)\b[^>]*>([\s\S]*?)<\/\2\s*>/i.exec(
      visible,
    );
  return { title: text(heading?.[1] || title?.[1], 200), nextStep: text(explicit?.[2] || label?.[3], 240) };
}
