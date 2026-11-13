import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createSelectorConnector, signerFromConnector } from "./selector";
import type { MessageSigner, SendTransactionInput, WalletAccount, WalletConnector } from "./types";

type WalletContextValue = {
  account: WalletAccount | null;
  connector: WalletConnector | null;
  connecting: boolean;
  error: string | null;
  connect(networkId: string, contractId: string): Promise<WalletAccount | null>;
  restore(networkId: string, contractId: string): Promise<WalletAccount | null>;
  disconnect(): Promise<void>;
  signer(accountId: string): MessageSigner;
  sendTransaction(input: SendTransactionInput): Promise<{ txHash: string } | null>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

type Props = {
  children: ReactNode;
  connectorFactory?: (networkId: string, contractId: string) => WalletConnector;
};

export function WalletProvider({ children, connectorFactory = createSelectorConnector }: Props) {
  const connectorRef = useRef<WalletConnector | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const [connectorState, setConnectorState] = useState<WalletConnector | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prepare = useCallback(
    async (networkId: string, contractId: string) => {
      const connector = connectorRef.current ?? connectorFactory(networkId, contractId);
      if (connector.networkId !== networkId || connector.contractId !== contractId) {
        throw new Error("wallet is configured for a different network or contract");
      }
      if (!connectorRef.current) {
        connectorRef.current = connector;
        setConnectorState(connector);
        await connector.initialize();
        unsubscribeRef.current = connector.onAccountsChange((accounts) => setAccount(accounts[0] ?? null));
      }
      return connector;
    },
    [connectorFactory],
  );

  const restore = useCallback(
    async (networkId: string, contractId: string) => {
      try {
        const connector = await prepare(networkId, contractId);
        const redirect = await connector.recoverRedirect();
        const accounts = await connector.getAccounts();
        const restored = accounts[0] ?? (redirect && "account" in redirect ? redirect.account : null);
        setAccount(restored);
        return restored;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "wallet restoration failed");
        return null;
      }
    },
    [prepare],
  );

  const connect = useCallback(
    async (networkId: string, contractId: string) => {
      setConnecting(true);
      setError(null);
      try {
        const connector = await prepare(networkId, contractId);
        const existing = await connector.getAccounts();
        const accounts = existing.length > 0 ? existing : await connector.signIn();
        const connected = accounts?.[0] ?? (await connector.getAccounts())[0] ?? null;
        setAccount(connected);
        return connected;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "wallet connection failed");
        return null;
      } finally {
        setConnecting(false);
      }
    },
    [prepare],
  );

  const disconnect = useCallback(async () => {
    await connectorRef.current?.signOut();
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    connectorRef.current = null;
    setConnectorState(null);
    setAccount(null);
    setError(null);
  }, []);

  const signer = useCallback((accountId: string) => {
    const connector = connectorRef.current;
    if (!connector) throw new Error("wallet is not connected");
    return signerFromConnector(connector, accountId);
  }, []);

  const sendTransaction = useCallback(async (input: SendTransactionInput) => {
    const connector = connectorRef.current;
    if (!connector) throw new Error("wallet is not connected");
    return connector.signAndSendTransaction(input);
  }, []);

  useEffect(
    () => () => {
      unsubscribeRef.current?.();
    },
    [],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      account,
      connector: connectorState,
      connecting,
      error,
      connect,
      restore,
      disconnect,
      signer,
      sendTransaction,
    }),
    [account, connectorState, connecting, error, connect, restore, disconnect, signer, sendTransaction],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside WalletProvider");
  return value;
}
