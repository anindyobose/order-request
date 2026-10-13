"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { authRequest, graphqlRequest, SessionUser } from "@/lib/api";

type SessionContextValue = {
  user: SessionUser | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<SessionUser>;
  register: (input: { name: string; email: string; phone: string; password: string }) => Promise<SessionUser>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await graphqlRequest<{ me: SessionUser | null }>(`
        query CurrentUser { me { id name email phone role status } }
      `);
      setUser(result.me);
      setError("");
    } catch (loadError) {
      setUser(null);
      setError(loadError instanceof Error ? loadError.message : "Could not check your sign-in.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const login = useCallback(async (identifier: string, password: string) => {
    const result = await authRequest<{ user: SessionUser }>("login", {
      identifier,
      password,
    });
    setUser(result.user);
    setError("");
    return result.user;
  }, []);

  const register = useCallback(
    async (input: { name: string; email: string; phone: string; password: string }) => {
      const result = await authRequest<{ user: SessionUser }>("register", input);
      setUser(result.user);
      setError("");
      return result.user;
    },
    [],
  );

  const logout = useCallback(async () => {
    await authRequest<{ success: true }>("logout");
    setUser(null);
    setError("");
  }, []);

  const value = useMemo(
    () => ({ user, loading, error, reload, login, register, logout }),
    [user, loading, error, reload, login, register, logout],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside AuthProvider.");
  return value;
}
