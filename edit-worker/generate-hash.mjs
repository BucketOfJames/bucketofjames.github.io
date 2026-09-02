// Generate a PBKDF2-SHA256 password hash string for the site editor worker.
//
// Usage:
//   node generate-hash.mjs
//
// It prompts for the password (typed input is read-only), produces a string
// of the form  PBKDF2$<iterations>$<salt_b64>$<hash_b64>  and prints it.
// Paste that whole string as the worker secret EDIT_PASS_HASH:
//   npx wrangler secret put EDIT_PASS_HASH
//
// PBKDF2 with a high iteration count + random salt is a deliberately slow KDF,
// chosen per OWASP guidance, so brute-forcing the password is impractical even
// if this secret leaked.

import { pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import readline from "node:readline";

const pbkdf2Async = promisify(pbkdf2);
// Cloudflare Workers caps crypto.subtle PBKDF2 at 100000 iterations, so use
// that maximum (still a strong KDF for a personal editor). Anything above
// 100000 throws and is silently treated as a failed login.
const ITERATIONS = 100000;

function toB64(buf) {
  return buf.toString("base64");
}

function ask() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return new Promise((resolve) => {
    rl.question("Password: ", (value) => {
      rl.close();
      process.stdout.write("\n");
      resolve(value);
    });
  });
}

async function main() {
  const password = await ask();
  if (!password) {
    console.error("No password entered.");
    process.exit(1);
  }
  const salt = toB64(randomBytes(16));
  const hash = await pbkdf2Async(password, Buffer.from(salt, "base64"), ITERATIONS, 32, "sha256");
  const out = `PBKDF2$${ITERATIONS}$${salt}$${toB64(hash)}`;
  console.log("\nEDIT_PASS_HASH secret value:\n");
  console.log(out);
  console.log(
    "\nCopy the line above, then run:\n  npx wrangler secret put EDIT_PASS_HASH\n"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
