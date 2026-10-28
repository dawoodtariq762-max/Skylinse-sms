/**
 * Backup service for Skyline SMS.
 * - Uses the ASYNCHRONOUS SQLite online-backup API (better-sqlite3 db.backup)
 *   so a backup never blocks the Node event loop.
 * - Writes backups atomically to a dedicated folder.
 * - Retains backups for a configurable number of days.
 * - Designed for VPS deployment.
 *
 * ============================================================================
 * POST-REBRAND REPAIR — why this file changed
 * ----------------------------------------------------------------------------
 * createBackup() previously ran `db.exec("VACUUM INTO '<file>')`. On
 * better-sqlite3 that call is FULLY SYNCHRONOUS: it copies the entire database
 * file while holding the event loop. On this deployment's multi-GB database
 * that took minutes, during which EVERY request on the server stalled — the
 * reverse proxy then returned HTTP 504 and the whole application appeared to be
 * down. It was also triggered automatically 15 s after every boot and then
 * every BACKUP_INTERVAL_HOURS, so the freeze could happen with nobody clicking
 * anything.
 *
 * better-sqlite3 exposes `db.backup(dest)`, a Promise-based wrapper around
 * sqlite3_backup_init/step/finish. That work runs off the JavaScript thread, so
 * the server keeps serving requests while the copy proceeds. The file it
 * produces is a complete, internally consistent, restorable SQLite database
 * (same guarantee as VACUUM INTO), written to a .tmp path and atomically
 * renamed only after the copy succeeds.
 *
 * The synchronous path is retained purely as a fallback for a db layer that
 * does not expose a raw better-sqlite3 handle; it is never used on this build.
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
/* Backup file naming. New backups use "skyline-sms-backup-<ts>.sqlite".
   Backups created under the panel's earlier backup prefixes (ams-, qtech-, nova-,
   almada-, powerx-, galaxy-) are still listed, restorable and pruned by
   retention — only the prefix differs. Those legacy strings remain here solely
   so existing production backups stay visible and usable. */
const BACKUP_PREFIX = 'skyline-sms-backup-';
const LEGACY_BACKUP_PREFIXES = [
  'ams-sms-backup-',
  'qtech-sms-backup-',
  'nova-sms-backup-',
  'almada-sms-backup-',
  'powerx-sms-backup-',
  'galaxy-sms-backup-',
];
/* Any "<brand>-sms-backup-<timestamp>.sqlite". Kept intentionally broad so
   backups written by earlier builds of this panel remain downloadable and
   restorable; path.basename() is applied first, so this cannot traverse
   directories. Listing is intentionally MORE tolerant than this (see
   listBackups) so that nothing already on disk is ever hidden from the UI. */
const BACKUP_NAME_RE = /^[a-z0-9]+-sms-backup-[\w.-]+\.sqlite$/i;
function isBackupFileName(base) { return BACKUP_NAME_RE.test(String(base || '')); }
function getDbFile(db) {
  return db.getDbFile ? db.getDbFile() : path.join(__dirname, 'data.sqlite');
}
function getBackupDir(db) {
  return process.env.BACKUP_DIR
    || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'backups') : null)
    // VPS-safe default: outside the application folder, so backups survive accidental app deletion.
    || path.join(os.homedir(), 'skyline-sms-backups');
}
function ensureBackupDir(db) {
  const dir = getBackupDir(db);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function safeBackupName(name) {
  const base = path.basename(String(name || ''));
  if (!isBackupFileName(base)) {
    throw new Error('Invalid backup file name');
  }
  return base;
}
function backupPath(db, fileName) {
  return path.join(ensureBackupDir(db), safeBackupName(fileName));
}
/**
 * List every .sqlite file in the backup directory.
 * Deliberately tolerant: it no longer filters by brand prefix, because
 * filtering hid genuine production backups from the Backups page ("no existing
 * backups are displayed"). Files whose name does not match the expected
 * "<brand>-sms-backup-…" pattern are still listed, but flagged `legacy:true`
 * purely so the UI can label them. Nothing is ever deleted here.
 */
function listBackups(db) {
  let dir;
  try {
    dir = ensureBackupDir(db);
  } catch (e) {
    console.warn('[backup] listBackups: cannot create dir:', e.message);
    return [];
  }
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    console.warn('[backup] listBackups: cannot read dir', dir, e.message);
    return [];
  }
  return files
    .filter(f => f.endsWith('.sqlite'))
    .map(file => {
      try {
        const st = fs.statSync(path.join(dir, file));
        const birth = st.birthtime && st.birthtime.getTime() ? st.birthtime : st.mtime;
        return {
          file,
          size: st.size,
          created_at: birth.toISOString(),
          modified_at: st.mtime.toISOString(),
          legacy: !isBackupFileName(file),
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));
}

/**
 * Create a backup. ASYNC — must be awaited.
 * Primary path uses the non-blocking SQLite online-backup API.
 */
async function createBackup(db, reason = 'manual') {
  const dir = ensureBackupDir(db);
  const file = `${BACKUP_PREFIX}${ts()}.sqlite`;
  const fullPath = path.join(dir, file);
  const tmpPath = fullPath + '.tmp';
  try { fs.unlinkSync(tmpPath); } catch (_) { /* nothing to clean */ }

  const raw = (db && typeof db.getRaw === 'function') ? db.getRaw() : null;

  if (raw && typeof raw.backup === 'function') {
    /* ---- NON-BLOCKING PATH ------------------------------------------------
       Best-effort passive WAL checkpoint so the copy starts from a tidy state.
       PASSIVE never waits on or blocks other writers. */
    try { raw.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch (_) {}
    await raw.backup(tmpPath);   /* <-- off the JS thread; server stays up */
  } else if (db && typeof db.exec === 'function') {
    /* ---- FALLBACK (synchronous; only if no raw handle) -------------------- */
    try { if (db.save) db.save(); } catch (_) {}
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}
    db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
  } else {
    const buffer = (db && db.exportBuffer) ? db.exportBuffer() : fs.readFileSync(getDbFile(db));
    fs.writeFileSync(tmpPath, Buffer.from(buffer));
  }

  /* Only publish the backup once the copy completed and is non-trivial. */
  const st = fs.statSync(tmpPath);
  if (!st.size) throw new Error('Backup produced an empty file; original left untouched');
  fs.renameSync(tmpPath, fullPath);
  return { file, size: st.size, reason, created_at: new Date().toISOString() };
}

function cleanupOldBackups(db) {
  const days = Math.max(1, parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const backups = listBackups(db);
  const deleted = [];
  for (const b of backups) {
    const t = new Date(b.modified_at).getTime();
    if (t < cutoff) {
      try {
        const fullPath = path.join(getBackupDir(db), path.basename(b.file));
        fs.unlinkSync(fullPath);
        deleted.push(b.file);
      } catch (e) { /* keep it if it cannot be removed */ }
    }
  }
  return deleted;
}
function deleteBackup(db, fileName) {
  const fullPath = backupPath(db, fileName);
  if (!fs.existsSync(fullPath)) throw new Error('Backup not found');
  fs.unlinkSync(fullPath);
  return true;
}
function getLatestBackup(db) {
  return listBackups(db)[0] || null;
}
async function restoreBackup(db, fileName) {
  const fullPath = backupPath(db, fileName);
  if (!fs.existsSync(fullPath)) throw new Error('Backup not found');
  // Always create a safety snapshot before restore.
  const safety = await createBackup(db, 'pre-restore-safety');
  if (!db.replaceWithFile) throw new Error('Database restore is not supported by db layer');
  db.replaceWithFile(fullPath);
  return { ok: true, restored_from: path.basename(fileName), safety_backup: safety.file };
}
function startAutomaticBackups(db, logger = console) {
  const enabled = String(process.env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    logger.log('• Automatic backups disabled');
    return null;
  }
  const hours = Math.max(1, parseFloat(process.env.BACKUP_INTERVAL_HOURS || '3'));
  const ms = hours * 60 * 60 * 1000;
  // Create a startup backup shortly after boot, then schedule interval.
  // Both handlers are async and never block the event loop.
  setTimeout(() => {
    (async () => {
      try {
        const b = await createBackup(db, 'startup');
        cleanupOldBackups(db);
        logger.log('✓ Startup backup created:', b.file);
      } catch (e) { logger.error('Backup error:', e.message); }
    })();
  }, 15000);
  const timer = setInterval(() => {
    (async () => {
      try {
        const b = await createBackup(db, 'auto');
        cleanupOldBackups(db);
        logger.log('✓ Auto backup created:', b.file);
      } catch (e) { logger.error('Backup error:', e.message); }
    })();
  }, ms);
  if (timer.unref) timer.unref();
  logger.log(`• Automatic backups enabled: every ${hours} hour(s), dir: ${getBackupDir(db)}`);
  return timer;
}
module.exports = {
  getBackupDir,
  listBackups,
  createBackup,
  cleanupOldBackups,
  deleteBackup,
  getLatestBackup,
  restoreBackup,
  backupPath,
  startAutomaticBackups,
};
