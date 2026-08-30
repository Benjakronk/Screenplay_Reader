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
const { hashPassword, cleanEmail, cleanName } = require('./auth');

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
  // --admin anywhere in the arguments. An administrator is the only one who can
  // invite a NEW person into the system; everyone else may add people who
  // already have an account. Promotion is deliberately a shell operation on the
  // server rather than something reachable from the app.
  const argv = process.argv.slice(2);
  const admin = argv.includes('--admin');
  const args = argv.filter((a) => a !== '--admin');

  const email = args[0];
  if (!email) {
    console.error('usage: node create-user.js <email> ["Display Name"] [--admin]   (prompts for the password)');
    console.error('       node create-user.js <email> <password> ["Display Name"] [--admin]');
    console.error('');
    console.error('  --admin  may invite new people. Passing it promotes an existing account;');
    console.error('           leaving it off never demotes one.');
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
  let normalisedEmail, normalisedName;
  try {
    normalisedEmail = cleanEmail(email);
    normalisedName = cleanName(name);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (password.length < 10) {
    console.error('password must be at least 10 characters');
    process.exit(2);
  }

  await init();
  const normalised = normalisedEmail;
  const hash = await hashPassword(password);

  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash, created_at, is_admin)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       -- --admin promotes; leaving it off never demotes, so a routine password
       -- reset cannot quietly strip someone's administrator rights.
       is_admin = users.is_admin OR EXCLUDED.is_admin
     RETURNING id, is_admin, (xmax = 0) AS created`,
    [normalised, normalisedName, hash, Date.now(), admin]);

  const what = rows[0].created ? 'created' : 'reset the password for';
  console.log(`${what} ${normalised} (${rows[0].id})` +
              (rows[0].is_admin ? ' - ADMINISTRATOR, may invite new people' : ''));
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
