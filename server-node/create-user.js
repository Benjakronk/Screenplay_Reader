'use strict';

// Creates an account from the command line. There is no public registration
// endpoint, so this is how the FIRST account comes into being; everyone after
// that can be invited from inside the app.
//
//   node create-user.js <email> ["Display Name"]        <- prompts, nothing echoed
//   node create-user.js <email> <password> ["Display Name"]
//
// PREFER THE FIRST FORM. A password given as an argument ends up in your shell
// history and is briefly visible to any other user via `ps`. Omit it and it is
// read from the terminal with echo off, or from a pipe:
//
//   printf '%s' "$PW" | node create-user.js you@example.no "Your Name"
//
// Re-running for an existing email resets that account's password, which is
// also the password-reset path (there is no email flow).

const readline = require('readline');
const { pool, query, init } = require('./db');
const { hashPassword } = require('./auth');

// Reads a password without echoing it. Falls back to reading stdin when piped.
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      process.stdin.on('error', reject);
      return;
    }
    process.stdout.write(prompt);
    const rl = readline.createInterface({
      input: process.stdin, output: process.stdout, terminal: true,
    });
    rl._writeToOutput = () => {};          // swallow the echo
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const email = args[0];
  if (!email) {
    console.error('usage: node create-user.js <email> ["Display Name"]        (prompts for the password)');
    console.error('       node create-user.js <email> <password> ["Display Name"]');
    process.exit(2);
  }

  // Two shapes: (email, name) with a prompted password, or the legacy
  // (email, password, name). One argument after the email is a name.
  let password, name;
  if (args.length >= 3) {
    [, password, name] = args;
  } else {
    name = args[1] || '';
    password = await readSecret('Password (not shown): ');
  }
  if (!password) {
    console.error('no password given');
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
