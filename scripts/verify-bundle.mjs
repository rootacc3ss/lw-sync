// Bundle guard: fails if main.js contains Node-only constructs that would break on
// mobile (iOS WKWebView has no Node built-ins). Run as part of `npm run gates`.
import { readFileSync, existsSync } from "node:fs";

const BUNDLE = "main.js";
const BANNED = [
  // Node built-in module references (require/import forms)
  /require\(["']node:[a-z_]+["']\)/g,
  /require\(["'](fs|path|os|crypto|stream|zlib|http|https|net|tls|child_process|util|events|buffer|process)["']\)/g,
  /from\s*["']node:[a-z_]+["']/g,
  // Dependencies that were removed for cross-platform support (require forms only —
  // plain version strings inside the SDK's package metadata are harmless)
  /require\(["']chokidar["']\)/g,
  /require\(["']tar-stream["']\)/g,
  /require\(["']@smithy\/node-http-handler["']\)/g,
];

if (!existsSync(BUNDLE)) {
  console.error(`✗ ${BUNDLE} not found — run a build first.`);
  process.exit(1);
}

const src = readFileSync(BUNDLE, "utf8");
const failures = [];
for (const re of BANNED) {
  re.lastIndex = 0;
  const m = src.match(re);
  if (m) failures.push(`${re.source}  (${m.length} match${m.length > 1 ? "es" : ""})`);
}

// NOTE: the AWS SDK legitimately calls process.env / globalThis.process guards at runtime;
// those are tree-shaken or guarded and are not Node-only on their own. We only flag the
// constructs above (built-in *imports* and removed deps).

if (failures.length) {
  console.error("✗ bundle guard FAILED — Node-only code detected in main.js:");
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}

const kb = (src.length / 1024).toFixed(0);
console.log(`✓ bundle guard passed (${kb} KB, no Node-only constructs)`);
