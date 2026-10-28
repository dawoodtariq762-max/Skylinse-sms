/**
 * Seed — sirf ek Admin account banata hai (agar DB khaali ho).
 * Koi demo/fake data nahi. Baaki sab (managers, agents, clients,
 * ranges, numbers) aap panel se khud add karenge.
 */
const db = require('./db');
const bcrypt = require('bcryptjs');

function hash(p) { return bcrypt.hashSync(p, 10); }

// ==== ADMIN CREDENTIALS (yahan change kar sakte hain) ====
const ADMIN_USERNAME = process.env.ADMIN_INITIAL_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_INITIAL_PASSWORD;

function ensureTestAccount() {
  const existing = db.get("SELECT id FROM users WHERE username=? COLLATE NOCASE", ['test']);
  if (existing || !process.env.TEST_PANEL_INITIAL_PASSWORD) return;
  db.run(`INSERT INTO users (username,password,role,name,active) VALUES (?,?,?,?,1)`,
    ['test', hash(process.env.TEST_PANEL_INITIAL_PASSWORD), 'test', 'Test Panel']);
  console.log('✓ Test Panel account created — username: test');
}

function seed() {
  const existing = db.get('SELECT COUNT(*) AS c FROM users');
  if (existing && existing.c > 0) { console.log('• Seed skipped (users already present)'); ensureTestAccount(); return; }

  if (!ADMIN_PASSWORD) throw new Error('Fresh database: set ADMIN_INITIAL_PASSWORD before starting; existing accounts are never reset');
  console.log('• Creating admin account...');
  db.run(
    `INSERT INTO users (username,password,role,name,active) VALUES (?,?,?,?,1)`,
    [ADMIN_USERNAME, hash(ADMIN_PASSWORD), 'admin', 'Administrator']
  );
  console.log(`✓ Admin created — username: ${ADMIN_USERNAME}`);
  ensureTestAccount();
  console.log('  (Ab is se login karke managers/agents/clients/ranges add karein)');
}

module.exports = { seed };
