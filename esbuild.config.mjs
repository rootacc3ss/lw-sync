import esbuild from "esbuild";
import process from "node:process";

const banner = `/*
Little Wooly Sync — bundled output. Do not edit directly; edit src/ and rebuild.
*/`;

const prod = process.argv[2] === "production";

// platform: "browser" is load-bearing — it keeps the bundle free of Node built-ins
// (fs/path/crypto/stream) so the identical main.js runs on desktop (Electron) AND mobile
// (Capacitor/WKWebView). Anything that reintroduces a Node dependency will fail the
// `verify-bundle` guard.
const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  format: "cjs",
  platform: "browser",
  mainFields: ["browser", "module", "main"],
  conditions: ["browser"],
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
