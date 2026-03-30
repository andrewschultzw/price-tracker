import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getMe, login as apiLogin, logout as apiLogout, getSetupStatus } from '../api';
import type { User } from '../types';

interface AuthState {
  user: User | null;
  loading: boolean;
  needsSetup: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const status = await getSetupStatus();
      if (status.needsSetup) {
        setNeedsSetup(true);
        setLoading(false);
        return;
      }

      const me = await getMe();
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  const login = async (email: string, password: string) => {
    const loggedIn = await apiLogin(email, password);
    setUser(loggedIn);
  };

  const logout = async () => {
    await apiLogout();
    setUser(null);
  };

  const handleSetUser = (u: User) => {
    setUser(u);
    setNeedsSetup(false);
  };

  return (
    <AuthContext.Provider value={{ user, loading, needsSetup, login, logout, setUser: handleSetUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
