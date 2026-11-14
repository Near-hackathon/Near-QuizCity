type Intent = { requestId: string; method: string; args: Record<string, unknown>; txHash?: string };
const prefix = "quizcity.managed-intents:";
const memory = new Map<string, Intent[]>();
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? "[" + value.map(canonical).join(",") + "]"
    : value && typeof value === "object"
      ? "{" +
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
          .join(",") +
        "}"
      : JSON.stringify(value);
function read(key: string): Intent[] {
  const cached = memory.get(key);
  if (cached) return cached;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    memory.set(key, parsed);
    return parsed;
  } catch {
    return memory.get(key) ?? [];
  }
}
function save(key: string, items: Intent[]) {
  memory.set(key, items);
  try {
    sessionStorage.setItem(key, JSON.stringify(items));
  } catch {
    /* The server still retains every submitted transaction. */
  }
}
export async function sendManagedIntent(
  account: string,
  method: string,
  args: Record<string, unknown>,
  send: (input: Intent) => Promise<{ txHash: string; state: string }>,
): Promise<string> {
  const key = prefix + account,
    list = read(key);
  let intent = list.find((item) => item.method === method && canonical(item.args) === canonical(args));
  if (!intent) {
    intent = { requestId: crypto.randomUUID(), method, args };
    list.push(intent);
    save(key, list);
  }
  const response = await send({ requestId: intent.requestId, method: intent.method, args: intent.args });
  intent.txHash = response.txHash;
  save(key, list);
  if (response.state === "rejected")
    throw Error("The saved transaction was rejected. Review it before starting another payment.");
  return response.txHash;
}
export function forgetManagedProof(hash: string) {
  const keys = new Set(memory.keys());
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(prefix)) keys.add(key);
    }
  } catch {
    /* optional cache */
  }
  for (const key of keys)
    save(
      key,
      read(key).filter((item) => item.txHash !== hash),
    );
}
