import type { MessageSigner, SendTransactionInput } from "./types";

type DemoModule = {
  demoSigner(accountId: string): MessageSigner | null;
  registerDemoKey(accountId: string, publicKey: string, secretKey: string): Promise<void>;
  demoTransaction(accountId: string, input: SendTransactionInput): Promise<{ txHash: string } | null>;
};

async function load(demoMode: boolean): Promise<DemoModule | null> {
  if (!import.meta.env.DEV || !demoMode) return null;
  // Vite must not traverse demo signing dependencies for a production build.
  // In development the browser resolves this source module through Vite's dev server.
  const sourceModule = "./demo";
  return (await import(/* @vite-ignore */ sourceModule)) as DemoModule;
}

export async function registerDemoKey(
  demoMode: boolean,
  accountId: string,
  publicKey: string,
  secretKey: string,
): Promise<void> {
  const module = await load(demoMode);
  if (!module) throw new Error("demo accounts are available only in development builds");
  await module.registerDemoKey(accountId, publicKey, secretKey);
}

export async function demoSigner(demoMode: boolean, accountId: string): Promise<MessageSigner | null> {
  const module = await load(demoMode);
  return module?.demoSigner(accountId) ?? null;
}

export async function demoTransaction(
  demoMode: boolean,
  accountId: string,
  input: SendTransactionInput,
): Promise<{ txHash: string } | null> {
  const module = await load(demoMode);
  return module ? module.demoTransaction(accountId, input) : null;
}
