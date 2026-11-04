// ordna-herdr patch: markdown rendering for the TUI task detail (tables, headings, bullets, **bold**, `code`).
function ordnaHerdrTables(text, width) {
    if (width <= 0 || !text.includes("|"))
        return text;
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const lines = text.split("\n");
    const out = [];
    for (let i = 0; i < lines.length;) {
        if (!isRow(lines[i])) {
            out.push(lines[i++]);
            continue;
        }
        const block = [];
        while (i < lines.length && isRow(lines[i]))
            block.push(lines[i++]);
        out.push(...ordnaHerdrTable(block, width));
    }
    return out.join("\n");
}
function ordnaHerdrWrapCell(s, n) {
    const out = [];
    let cur = "";
    for (let word of s.split(/\s+/)) {
        while (word.length > n) {
            if (cur) { out.push(cur); cur = ""; }
            out.push(word.slice(0, n));
            word = word.slice(n);
        }
        if (!cur) cur = word;
        else if (cur.length + 1 + word.length <= n) cur += " " + word;
        else { out.push(cur); cur = word; }
    }
    out.push(cur);
    return out;
}
// Header rows carry a leading zero-width marker so the renderer can make them bold.
function ordnaHerdrTable(block, width) {
    const rows = block.map((l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\*\*|`/g, "").replace(/\\\|/g, "|")));
    const isSep = (r) => r.every((c) => /^:?-{2,}:?$/.test(c));
    const sepAt = rows.findIndex(isSep);
    const cols = Math.max(...rows.map((r) => r.length));
    const data = rows.filter((r) => !isSep(r));
    const w = Array.from({ length: cols }, (_, c) => Math.max(1, ...data.map((r) => (r[c] ?? "").length)));
    const total = () => w.reduce((a, b) => a + b, 0) + 3 * cols + 1;
    while (total() > width && Math.max(...w) > 6)
        w[w.indexOf(Math.max(...w))]--;
    const rule = (l, m, r) => l + w.map((n) => "─".repeat(n + 2)).join(m) + r;
    const cellLines = (r) => {
        const cells = w.map((n, c) => ordnaHerdrWrapCell(r[c] ?? "", n));
        const h = Math.max(...cells.map((x) => x.length));
        return Array.from({ length: h }, (_, i) => "│ " + w.map((n, c) => (cells[c][i] ?? "").padEnd(n)).join(" │ ") + " │");
    };
    const multi = data.some((r, i) => i > (sepAt > 0 ? sepAt - 1 : -1) && cellLines(r).length > 1);
    const out = [rule("┌", "┬", "┐")];
    rows.forEach((r, i) => {
        if (isSep(r)) { out.push(rule("├", "┼", "┤")); return; }
        const header = sepAt > 0 && i < sepAt;
        out.push(...cellLines(r).map((l) => (header ? "​" : "") + l));
        if (multi && !header && i < rows.length - 1)
            out.push(rule("├", "┼", "┤"));
    });
    out.push(rule("└", "┴", "┘"));
    return out;
}
function ordnaHerdrInline(s) {
    return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean).map((p, i) => {
        if (p.length > 4 && p.startsWith("**") && p.endsWith("**"))
            return _jsx(Text, { bold: true, color: theme.text, children: p.slice(2, -2) }, i);
        if (p.length > 2 && p.startsWith("`") && p.endsWith("`"))
            return _jsx(Text, { color: theme.accent2, children: p.slice(1, -1) }, i);
        return p;
    });
}
function ordnaHerdrLine(text, key) {
    if (text === "")
        return _jsx(Text, { children: " " }, key);
    if (/^[┌├└]/.test(text))
        return _jsx(Text, { color: theme.textMuted, wrap: "truncate-end", children: text }, key);
    if (/^​?│/.test(text)) {
        const header = text.startsWith("​");
        const cells = text.replace(/^​/, "").split("│").slice(1, -1);
        const kids = [_jsx(Text, { color: theme.textMuted, children: "│" }, "b0")];
        cells.forEach((c, i) => kids.push(_jsx(Text, { bold: header, color: header ? theme.accent2 : theme.text, children: c }, "c" + i), _jsx(Text, { color: theme.textMuted, children: "│" }, "b" + (i + 1))));
        return _jsx(Text, { wrap: "truncate-end", children: kids }, key);
    }
    const h = text.match(/^#{3,6}\s+(.*)$/);
    if (h)
        return _jsx(Text, { bold: true, color: theme.accent2, wrap: "truncate-end", children: h[1].replace(/\*\*|`/g, "") }, key);
    const t = text.replace(/^(\s*)- \[ \] /, "$1☐ ").replace(/^(\s*)- \[[xX]\] /, "$1☑ ").replace(/^(\s*)[-*] /, "$1• ");
    return _jsx(Text, { color: theme.text, wrap: "truncate-end", children: ordnaHerdrInline(t) }, key);
}
