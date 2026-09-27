// Serialize the custom-request-header map as "Header: value" lines for a textarea.

export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function formatHeaderLines(rec?: Record<string, string>): string {
  if (!rec) return "";
  return Object.entries(rec)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
