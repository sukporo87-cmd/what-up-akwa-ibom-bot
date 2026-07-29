#!/usr/bin/env node
// ============================================
// FILE: src/scripts/check-state-map.js
//
// Diffs every state the engine can park a user in against the PROMPTS map in
// game-state.service.js, which is what tells the web client whether to render
// a chooser, a text field or a file picker.
//
// An unmapped state is not fatal — it falls back to a plain text box — but it
// means the web player gets a worse control than they should, and nobody finds
// out. This makes it findable.
//
//   node src/scripts/check-state-map.js
//
// Exits 1 if anything is unmapped, so it can gate a deploy.
// ============================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Read the map without loading the service (which would want redis and a db).
const svcSrc = fs.readFileSync(path.join(ROOT, 'services/game-state.service.js'), 'utf8');
const promptsBlock = svcSrc.slice(
    svcSrc.indexOf('const PROMPTS = {'),
    svcSrc.indexOf('const UNKNOWN')
);
const mapped = new Set([...promptsBlock.matchAll(/^\s{4}([A-Z_]+)\s*:/gm)].map(m => m[1]));

// Every setUserState() call across the engine.
const scanDirs = ['controllers', 'services'];
const found = new Map();          // STATE -> [files]

for (const dir of scanDirs) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;

    for (const file of fs.readdirSync(full)) {
        if (!file.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(full, file), 'utf8');
        for (const m of src.matchAll(/setUserState\s*\([^,]+,\s*['"]([A-Z_]+)['"]/g)) {
            if (!found.has(m[1])) found.set(m[1], []);
            if (!found.get(m[1]).includes(`${dir}/${file}`)) {
                found.get(m[1]).push(`${dir}/${file}`);
            }
        }
    }
}

const engineStates = [...found.keys()].sort();
const unmapped = engineStates.filter(s => !mapped.has(s));
const stale = [...mapped].filter(s => !engineStates.includes(s)).sort();

console.log(`engine states found : ${engineStates.length}`);
console.log(`mapped in PROMPTS   : ${mapped.size}`);

if (unmapped.length) {
    console.log(`\n✗ UNMAPPED — these fall back to a plain text field:`);
    for (const s of unmapped) {
        console.log(`    ${s}   (set in ${found.get(s).join(', ')})`);
    }
    console.log(`\n  Add each to PROMPTS in services/game-state.service.js with the`);
    console.log(`  control the player actually needs: expects 'choice', 'text' or 'media'.`);
}

if (stale.length) {
    console.log(`\n! MAPPED BUT NEVER SET — probably removed from the engine:`);
    stale.forEach(s => console.log(`    ${s}`));
}

if (!unmapped.length && !stale.length) {
    console.log('\n✓ state map is in sync');
}

process.exit(unmapped.length ? 1 : 0);