import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function configureWalletEnvironment(source, savedKey, confirmed) {
  const values = Object.fromEntries(
    source.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, "$2")]] : [];
    }),
  );
  if (!["local", "test"].includes(values.APP_ENV ?? "local") || values.NEAR_NETWORK !== "testnet")
    throw Error("Wallet setup requires APP_ENV=local|test and NEAR_NETWORK=testnet.");
  const key = values.TESTNET_WALLET_ENCRYPTION_KEY || savedKey || randomBytes(32).toString("base64");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").toString("base64") !== key)
    throw Error("The existing wallet encryption key is invalid; it was not replaced.");
  if (savedKey && key !== savedKey)
    throw Error("The existing key and recovery copy differ; neither was changed.");
  if (!confirmed) return { key, source, apply: false };
  let next = source;
  for (const [name, value] of [
    ["AUTO_TESTNET_WALLETS", "1"],
    ["TESTNET_WALLET_ENCRYPTION_KEY", key],
  ]) {
    const re = new RegExp("^\\s*" + name + "\\s*=.*$", "gm");
    next = re.test(next)
      ? next.replace(re, name + "=" + value)
      : next.trimEnd() + "\n" + name + "=" + value + "\n";
  }
  return { key, source: next, apply: true };
}
async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--enable"))
    throw Error("Use --enable to apply, or no flag for a dry run.");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const envPath = resolve(root, "server/.env");
  const identity = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const backup = resolve(homedir(), ".config", "quiz-city", identity, "wallet-master.key");
  const source = await readFile(envPath, "utf8");
  let saved;
  try {
    saved = (await readFile(backup, "utf8")).trim();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const plan = configureWalletEnvironment(source, saved, process.argv.includes("--enable"));
  if (!plan.apply) {
    console.log("Dry run: testnet wallets can be enabled. Run npm run wallets:setup -- --enable to apply.");
    return;
  }
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
  await chmod(dirname(backup), 0o700);
  if (!saved) await writeFile(backup, plan.key + "\n", { mode: 0o600, flag: "wx" });
  await chmod(backup, 0o600);
  const temporary = envPath + ".wallet-setup.tmp";
  try {
    await writeFile(temporary, plan.source, { mode: 0o600, flag: "wx" });
    await rename(temporary, envPath);
  } catch {
    throw Error("Environment update could not finish. The recovery key copy was kept.");
  }
  console.log("Automatic testnet wallets enabled. Restart the API.");
  console.log("Encryption key recovery copy: " + backup);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      "Testnet wallet setup could not finish. Check local/test configuration, file permissions and the recovery copy; existing keys were retained.",
    );
    process.exitCode = 1;
  });
}
