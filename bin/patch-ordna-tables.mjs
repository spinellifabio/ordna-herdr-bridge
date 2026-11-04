#!/usr/bin/env node
// Re-apply after every `npm i -g @frehilm/ordna-cli`: patches the TUI task detail with markdown rendering.
// Safe to re-run: when already patched it restarts from the .orig backup, so snippet updates are picked up.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.env.ORDNA_TASKDETAIL ||
  join(process.env.APPDATA ?? "", "npm/node_modules/@frehilm/ordna-cli/dist/tui/TaskDetail.js");
if (!existsSync(target)) { console.error(`not found: ${target}`); process.exit(1); }
let src = readFileSync(target, "utf8");
if (src.includes("ordnaHerdrTables")) {
  if (!existsSync(target + ".orig")) { console.error("patched but no .orig backup: reinstall ordna-cli first"); process.exit(1); }
  src = readFileSync(target + ".orig", "utf8");
} else copyFileSync(target, target + ".orig");

const hook = "function wrapText(text, width) {";
const render = 'return (_jsx(Text, { color: theme.text, wrap: "truncate-end", children: line.text }, key));';
for (const h of [hook, render])
  if (!src.includes(h)) { console.error(`anchor not found (${h.slice(0, 30)}...): ordna-cli changed, patch needs an update`); process.exit(1); }
const snippet = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ordna-tables.snippet.js"), "utf8");
src = src.replace(hook, () => `${snippet}${hook}\n    text = ordnaHerdrTables(text, width);`).replace(render, () => "return ordnaHerdrLine(line.text, key);");
writeFileSync(target, src);
console.log(`patched ${target} (backup: .orig)`);
