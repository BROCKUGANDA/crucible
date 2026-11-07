"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAccount } from "wagmi";
import { API_BASE } from "@/lib/apiBase";

interface AuthSessionValue {
  address: string | null;
  expiresAt: number | null;
  loading: boolean;
  isAuthenticated: boolean;
  walletMatches: boolean;
  canUsePrivateResources: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthSessionContext = createContext<AuthSessionValue | null>(null);

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount();
  const [session, setSession] = useState<{ address: string; expiresAt: number | null } | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/auth/session`, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        setSession(null);
        return;
      }
      const body = (await response.json()) as {
        address?: string | null;
        session?: { expiresAt?: number };
      };
      if (typeof body.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
        setSession(null);
        return;
      }
      setSession({
        address: body.address.toLowerCase(),
        expiresAt: typeof body.session?.expiresAt === "number" ? body.session.expiresAt : null,
      });
    } catch {
      // Unreachable auth API means no verified session in this browser view.
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json" },
      });
    } finally {
      setSession(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const walletMatches =
    Boolean(isConnected && address && session && session.address === address.toLowerCase());
  const isAuthenticated = session !== null;
  const canUsePrivateResources =
    isAuthenticated && (!isConnected || walletMatches);

  const value = useMemo<AuthSessionValue>(
    () => ({
      address: session?.address ?? null,
      expiresAt: session?.expiresAt ?? null,
      loading,
      isAuthenticated,
      walletMatches,
      canUsePrivateResources,
      refresh,
      logout,
    }),
    [session, loading, isAuthenticated, walletMatches, canUsePrivateResources, refresh, logout],
  );

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession(): AuthSessionValue {
  const value = useContext(AuthSessionContext);
  if (!value) throw new Error("useAuthSession must be used inside AuthSessionProvider");
  return value;
}
