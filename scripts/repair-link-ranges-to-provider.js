#!/usr/bin/env node
/**
 * repair-link-ranges-to-provider.js
 * ============================================================================
 * Post-rebrand repair: link existing number ranges that have NO valid provider
 * association to an existing provider record (default: "T- SMS").
 *
 * WHY
 *   Ranges historically allowed a free-text "Provider (reference)" with no
 *   provider link. Newer validation requires ranges.provider_id to point at a
 *   real ams_providers row. The boot-time backfill in backend/schema.js only
 *   links a range when the stored text matches a provider name EXACTLY
 *   (LOWER(TRIM(ranges.provider)) = LOWER(TRIM(gp.name))). So text like
 *   "T-SMS" never matches a provider literally named "T- SMS" (with a space),
 *   and those ranges keep provider_id = NULL: they show under no provider and
 *   fail the newer validation on edit.
 *
 * WHAT IT DOES
 *   For every range whose provider_id is NULL or points at a provider record
 *   that no longer exists (and ONLY those):
 *     Phase A - if the range's stored provider text matches an existing
 *               provider after normalisation (case + punctuation/space
 *               insensitive, e.g. "T-SMS" -> "T- SMS"), link to THAT provider.
 *     Phase B - otherwise link to the target provider (default "T- SMS").
 *
 * WHAT IT NEVER TOUCHES
 *   - ranges that already have a VALID provider_id       (left untouched)
 *   - ranges.provider (the informational reference text)  (left untouched)
 *   - range id / name / numbers / rates / allocations / ownership
 *   - ams_providers rows, provider financial values, SMPP connections
 *   - nothing is deleted, ever
 *
 * IDEMPOTENT
 *   Every UPDATE is guarded with
 *     WHERE id = ? AND (provider_id IS NULL
 *                       OR provider_id NOT IN (SELECT id FROM ams_providers))
 *   so re-running after a successful run updates zero rows.
 *
 * SAFETY
 *   DRY RUN is the default - it only prints the plan. Nothing is written
 *   unless you pass --apply. Before applying, the previous provider_id of
 *   every row about to change is saved to a timestamped JSON backup next to
 *   this script, so the change can be reverted exactly.
 *
 * USAGE
 *   node scripts/repair-link-ranges-to-provider.js                  # dry run
 *   node scripts/repair-link-ranges-to-provider.js --provider="T- SMS"
 *   node scripts/repair-link-ranges-to-provider.js --apply          # write
 *   node scripts/repair-link-ranges-to-provider.js --apply --db=/path/data.sqlite
 *   node scripts/repair-link-ranges-to-provider.js --apply --include-deleted
 * ============================================================================
 */
'use strict';

const path = require('path');
const fs = require('fs');

const argv = process.argv.slice(2);
const hasFlag = n => argv.includes('--' + n);
const getOpt = (n, d) => {
  const hit = argv.find(a => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};

if (hasFlag('help') || hasFlag('h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
  process.exit(0);
}

const APPLY = hasFlag('apply');
const INCLUDE_DELETED = hasFlag('include-deleted');
const TARGET_NAME = String(getOpt('provider', 'T- SMS'));
const BACKEND_DIR = path.resolve(__dirname, '..', 'backend');
const DB_FILE = path.resolve(
  getOpt('db',
    process.env.DB_FILE
    || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'data.sqlite') : null)
    || path.join(BACKEND_DIR, 'data.sqlite'))
);

/* case + punctuation/space insensitive comparison key */
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('\n[FATAL] better-sqlite3 is not installed.\n' +
    '        Run this from the project root on the VPS, e.g.:\n' +
    '        cd /opt/skyline-sms/backend && npm i better-sqlite3\n');
  process.exit(2);
}

if (!fs.existsSync(DB_FILE)) {
  console.error('[FATAL] Database not found: ' + DB_FILE +
    '\n        Pass the real path with --db=/path/to/data.sqlite');
  process.exit(2);
}

console.log('==================================================================');
console.log(' Range -> Provider link repair');
console.log('==================================================================');
console.log(' Database     : ' + DB_FILE);
console.log(' Mode         : ' + (APPLY ? 'APPLY (will write)' : 'DRY RUN (no changes written)'));
console.log(' Target       : "' + TARGET_NAME + '"');
console.log(' Deleted rows : ' + (INCLUDE_DELETED ? 'included' : 'skipped (default)'));
console.log('');

const db = new Database(DB_FILE, { readonly: !APPLY, fileMustExist: true });

for (const t of ['ranges', 'ams_providers']) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)) {
    console.error('[FATAL] table "' + t + '" not found in ' + DB_FILE);
    process.exit(2);
  }
}

const providers = db.prepare('SELECT id, name FROM ams_providers ORDER BY id').all();
console.log(' Providers in registry (' + providers.length + '):');
providers.forEach(p => console.log('   #' + p.id + '  ' + p.name));

/* resolve target: exact (case-insensitive/trimmed) first, then normalised */
const tNorm = norm(TARGET_NAME);
const target =
  providers.find(p => String(p.name).trim().toLowerCase() === TARGET_NAME.trim().toLowerCase())
  || providers.filter(p => norm(p.name) === tNorm)[0];

if (!target) {
  console.error('\n[FATAL] No provider matching "' + TARGET_NAME + '" exists in ams_providers.');
  console.error('        Create it in the Management Panel first, or pass --provider="Exact Name".');
  process.exit(2);
}
console.log('\n Target provider resolved to: #' + target.id + '  "' + target.name + '"');

/* Phase A lookup: normalised provider name -> provider */
const byNorm = new Map();
for (const p of providers) {
  const k = norm(p.name);
  if (k && !byNorm.has(k)) byNorm.set(k, p);
}

/* ranges.deleted_at is optional in older databases - degrade gracefully */
const HAS_DELETED_AT = db.prepare("PRAGMA table_info(ranges)").all().some(c => c.name === 'deleted_at');
const delFilter = (INCLUDE_DELETED || !HAS_DELETED_AT) ? '1=1' : "COALESCE(r.deleted_at,'')=''";
const broken = db.prepare(
  `SELECT r.id, r.name, r.provider, r.provider_id, r.deleted_at
     FROM ranges r
    WHERE ${delFilter}
      AND (r.provider_id IS NULL
           OR r.provider_id NOT IN (SELECT id FROM ams_providers))
    ORDER BY r.id`
).all();

const total = db.prepare(`SELECT COUNT(*) c FROM ranges r WHERE ${delFilter}`).get().c;
const alreadyOk = total - broken.length;

console.log('\n Ranges in scope         : ' + total);
console.log(' Already correctly linked: ' + alreadyOk + '  (these are NEVER touched)');
console.log(' Needing repair          : ' + broken.length);
console.log('');

if (!broken.length) {
  console.log(' Nothing to do - every range already has a valid provider link.');
  console.log(' (Re-running this script is safe; it updates 0 rows.)');
  db.close();
  process.exit(0);
}

const plan = [];
for (const r of broken) {
  const txt = String(r.provider || '').trim();
  const match = txt ? byNorm.get(norm(txt)) : null;
  if (match) {
    plan.push({ ...r, to: match, reason: 'text "' + txt + '" matches provider #' + match.id + ' "' + match.name + '"' });
  } else {
    plan.push({ ...r, to: target, reason: txt ? 'text "' + txt + '" matches no provider -> default target' : 'no provider text -> default target' });
  }
}

console.log(' ------------------------------------------------------------------');
console.log(' PROPOSED CHANGES');
console.log(' ------------------------------------------------------------------');
for (const r of plan) {
  console.log('  id=' + String(r.id).padEnd(6) +
    ' | ' + String(r.name || '(unnamed)').slice(0, 34).padEnd(34) +
    ' | text "' + String(r.provider || '') + '"' +
    ' | provider_id ' + String(r.provider_id === null ? 'NULL' : r.provider_id) +
    ' -> ' + r.to.id + ' ("' + r.to.name + '")');
  console.log('         reason: ' + r.reason);
}
console.log('');

if (!APPLY) {
  console.log(' DRY RUN complete. No rows were changed.');
  console.log(' Review the list above. If it is correct, apply with:');
  console.log('   node scripts/repair-link-ranges-to-provider.js --provider="' + target.name + '" --apply');
  db.close();
  process.exit(0);
}

/* ---- backup, then apply ---- */
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(__dirname, 'range-provider-repair-backup-' + stamp + '.json');
fs.writeFileSync(backupFile, JSON.stringify({
  created_at: new Date().toISOString(),
  db_file: DB_FILE,
  target_provider: target,
  changes: plan.map(r => ({
    id: r.id, name: r.name,
    old_provider_id: r.provider_id, new_provider_id: r.to.id
  }))
}, null, 2));
console.log(' Backup of previous values written to: ' + backupFile);

const upd = db.prepare(
  `UPDATE ranges SET provider_id = ?
    WHERE id = ?
      AND (provider_id IS NULL
           OR provider_id NOT IN (SELECT id FROM ams_providers))`
);
const applyAll = db.transaction(rows => {
  let n = 0;
  for (const r of rows) n += upd.run(r.to.id, r.id).changes;
  return n;
});

const changed = applyAll(plan);
db.close();

console.log('');
console.log(' APPLIED. Rows updated: ' + changed);
console.log(' Re-run this script to verify (it should now report 0 needing repair).');
console.log(' To revert: restore your DB backup, or set provider_id back to the');
console.log(' "old_provider_id" values recorded in ' + path.basename(backupFile) + '.');
