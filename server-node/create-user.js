'use strict';

// Creates an account from the command line. There is no public registration
// endpoint, so this is how the FIRST account comes into being; everyone after
// that can be invited from inside the app.
//
//   node create-user.js <email> <password> ["Display Name"]
//
// Re-running for an existing email resets that account's password, which is
// also the password-reset path (there is no email flow).

const { pool, query, init } = require('./db');
const { hashPassword } = require('./auth');

async function main() {
  const [email, password, name] = process.argv.slice(2);
  if (!email || !password) {
    console.error('usage: node create-user.js <email> <password> ["Display Name"]');
    process.exit(2);
  }
  if (!email.includes('@')) {
    console.error('that does not look like an email address');
    process.exit(2);
  }
  if (password.length < 10) {
    console.error('password must be at least 10 characters');
    process.exit(2);
  }

  await init();
  const normalised = email.trim().toLowerCase();
  const hash = await hashPassword(password);

  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash, created_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, (xmax = 0) AS created`,
    [normalised, (name || '').trim(), hash, Date.now()]);

  console.log(rows[0].created
    ? `created ${normalised} (${rows[0].id})`
    : `reset the password for ${normalised} (${rows[0].id})`);
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
