#!/usr/bin/env node
// Adds ?v=<content hash> to every local script and stylesheet link in the
// HTML pages, so a release never runs next to a stale copy that Cloudflare's
// cache is still holding. Run before committing frontend changes:
//   node scripts/stamp-assets.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pages = ['index.html', ...readdirSync(join(root, 'pages')).filter((f) => f.endsWith('.html')).map((f) => `pages/${f}`)];
const hashes = new Map();
const hashOf = (file) => {
    if (!hashes.has(file)) hashes.set(file, createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10));
    return hashes.get(file);
};

let changed = 0;
for (const page of pages) {
    const path = join(root, page);
    const before = readFileSync(path, 'utf8');
    const after = before.replace(/(src|href)="((?:\.\.\/)?(?:js\/[\w.-]+\.js|styles\.css))(?:\?v=[\w]+)?"/g, (m, attr, ref) => {
        const file = resolve(dirname(path), ref);
        try { return `${attr}="${ref}?v=${hashOf(file)}"`; } catch { return m; }
    });
    if (after !== before) { writeFileSync(path, after); changed++; console.log(`stamped ${page}`); }
}
console.log(changed ? `${changed} page(s) updated` : 'already up to date');
