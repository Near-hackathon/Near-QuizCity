#!/usr/bin/env node
/**
 * Dependency-free tracked-file secret scan used by CI and local verification.
 * Prints only paths and rule names, never the matching secret.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);

const rules = [
  ["near-private-key", /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/],
  ["near-env-key", /NEAR_(?:OPERATOR|DEPLOY)_PRIVATE_KEY\s*=\s*ed25519:/],
  ["pem-private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["postgres-url-credentials", /postgres(?:ql)?:\/\/[^/\s:@]+:[^/\s@]+@(?!localhost\b|127\.0\.0\.1\b)/],
];

const allow = [/\.example$/, /\.test\.(?:ts|tsx|mjs)$/, /^scripts\/secret-scan\.mjs$/];
const allowPath = (path) => allow.some((pattern) => pattern.test(path));
const skipBinary = /\.(?:wasm|png|jpg|jpeg|gif|ico|pdf|woff2?|ttf|zip|gz|tgz)$/i;

let failures = 0;
for (const path of files) {
  if (allowPath(path) || skipBinary.test(path)) continue;
  let text;
  try {
    if (statSync(path).size > 2_000_000) continue;
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  for (const [name, pattern] of rules) {
    if (pattern.test(text)) {
      console.error(`possible secret (${name}) in tracked file: ${path}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`secret scan failed with ${failures} finding(s)`);
  process.exit(1);
}
console.log(`secret scan clean across ${files.length} tracked files`);
