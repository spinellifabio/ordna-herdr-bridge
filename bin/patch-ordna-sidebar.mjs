#!/usr/bin/env node
// Re-apply after every `npm i -g @frehilm/ordna-cli`: removes the 20-tag cap in the TUI sidebar.
// The sidebar already windows/scrolls its lines, so large terminals just show every tag.
// Safe to re-run: no-op when already patched.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const target = process.env.ORDNA_SIDEBAR ||
  join(process.env.APPDATA ?? "", "npm/node_modules/@frehilm/ordna-cli/dist/tui/Sidebar.js");
if (!existsSync(target)) { console.error(`not found: ${target}`); process.exit(1); }
const src = readFileSync(target, "utf8");
const anchor = /(\.sort\(\(a, b\) => b\[1\] - a\[1\]\)\s*)\.slice\(0, 20\)(\s*\.map\(\(\[tag, count\]\))/;
if (!anchor.test(src)) {
  console.log(src.includes("ordnaHerdrNoTagCap") ? "already patched" : "anchor not found: ordna-cli changed, patch needs an update");
  process.exit(src.includes("ordnaHerdrNoTagCap") ? 0 : 1);
}
if (!existsSync(target + ".orig")) copyFileSync(target, target + ".orig");
writeFileSync(target, src.replace(anchor, "$1/* ordnaHerdrNoTagCap */$2"));
console.log(`patched ${target} (backup: .orig)`);
