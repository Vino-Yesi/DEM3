import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { db, logAction, type User } from './db';
import { hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from './passwords';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'operator' | 'supervisor';
  displayName: string;
  mustChangePassword: boolean;
}

interface AuthContextType {
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  changePassword: (newPassword: string) => Promise<void>;
  isAdmin: boolean;
  loading: boolean;
  updateUser: (updates: Partial<Pick<AuthUser, 'displayName'>>) => void;
}

interface StoredSession {
  userId: number;
  expiresAt: number;
  lastActivityAt: number;
}

const SESSION_STORAGE_KEY = 'yesi_session_v2';
const LEGACY_SESSION_KEY = 'vortex_session';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const AuthContext = createContext<AuthContextType>({
  user: null,
  login: async () => false,
  logout: () => {},
  changePassword: async () => {},
  isAdmin: false,
  loading: true,
  updateUser: () => {},
});

function isRole(value: unknown): value is AuthUser['role'] {
  return value === 'admin' || value === 'operator' || value === 'supervisor';
}

function toAuthUser(user: User | undefined): AuthUser | null {
  if (!user || user.id === undefined || !isRole(user.role)) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    mustChangePassword: Boolean(user.mustChangePassword),
  };
}

function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (!Number.isInteger(value.userId) || !Number.isFinite(value.expiresAt) || !Number.isFinite(value.lastActivityAt)) return null;
    return value as StoredSession;
  } catch {
    return null;
  }
}

function saveSession(session: StoredSession): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Private browsing or storage-disabled contexts can still use the session
    // until the current page is closed; authentication is rechecked in memory.
  }
}

function clearSavedSession(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    // Remove the old, role-bearing localStorage session during upgrade.
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    // Storage is optional; never block logout on storage errors.
  }
}

export async function createInitialAdmin(username: string, password: string, displayName: string): Promise<void> {
  const cleanUsername = username.trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(cleanUsername)) {
    throw new Error('Use a username with 3–32 letters, numbers, dots, underscores or hyphens.');
  }
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`Use a password with at least ${PASSWORD_MIN_LENGTH} characters.`);
  const passwordHash = await hashPassword(password);
  await db.transaction('rw', db.users, async () => {
    if (await db.users.count() !== 0) throw new Error('An account already exists. Sign in instead.');
    await db.users.add({
      username: cleanUsername,
      password: passwordHash,
      role: 'admin',
      displayName: displayName.trim() || cleanUsername,
      createdAt: new Date().toISOString(),
      skillLevel: 5,
    });
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const userRef = useRef<AuthUser | null>(null);
  const lastActivityRef = useRef(Date.now());
  const lastSessionWriteRef = useRef(0);
  const failedAttemptsRef = useRef(new Map<string, { count: number; lockedUntil: number }>());

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // A stored role is never trusted: only the user ID is saved in sessionStorage,
  // and the role is reloaded from IndexedDB whenever the app starts.
  useEffect(() => {
    let active = true;
    const hydrate = async () => {
      const session = readSession();
      const now = Date.now();
      if (!session || session.expiresAt <= now || now - session.lastActivityAt > SESSION_TIMEOUT_MS) {
        clearSavedSession();
        if (active) setLoading(false);
        return;
      }
      try {
        const sessionUser = toAuthUser(await db.users.get(session.userId));
        if (!sessionUser) {
          clearSavedSession();
        } else if (active) {
          lastActivityRef.current = session.lastActivityAt;
          setUser(sessionUser);
        }
      } catch {
        clearSavedSession();
      } finally {
        if (active) setLoading(false);
      }
    };
    void hydrate();
    return () => { active = false; };
  }, []);

  const logout = useCallback(() => {
    const current = userRef.current;
    if (current) void logAction('LOGOUT', `User ${current.username} logged out`, current.displayName).catch(() => undefined);
    clearSavedSession();
    userRef.current = null;
    setUser(null);
  }, []);

  // 30-minute idle timeout plus a 12-hour maximum session age.
  useEffect(() => {
    if (!user) return;
    const recordActivity = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      if (now - lastSessionWriteRef.current < 5_000) return;
      lastSessionWriteRef.current = now;
      const session = readSession();
      if (session) saveSession({ ...session, lastActivityAt: now });
    };
    const checkTimeout = () => {
      const session = readSession();
      const now = Date.now();
      if (now - lastActivityRef.current > SESSION_TIMEOUT_MS || (session && session.expiresAt <= now)) logout();
    };
    const timer = window.setInterval(checkTimeout, 15_000);
    const activityEvents: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart'];
    activityEvents.forEach((eventName) => window.addEventListener(eventName, recordActivity, { passive: true }));
    return () => {
      window.clearInterval(timer);
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, recordActivity));
    };
  }, [user, logout]);

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    const normalizedUsername = username.trim();
    const lockKey = normalizedUsername.toLowerCase();
    const now = Date.now();
    const attempts = failedAttemptsRef.current.get(lockKey);
    if (attempts && attempts.lockedUntil > now) return false;

    const found = await db.users.where('username').equals(normalizedUsername).first();
    if (!found || !(await verifyPassword(password, found.password))) {
      const count = (attempts?.count || 0) + 1;
      const lockedUntil = count >= 5 ? now + Math.min((count - 4) * 30_000, 5 * 60_000) : 0;
      failedAttemptsRef.current.set(lockKey, { count, lockedUntil });
      return false;
    }

    const sessionUser = toAuthUser(found);
    if (!sessionUser) return false;
    failedAttemptsRef.current.delete(lockKey);
    const activityAt = Date.now();
    saveSession({ userId: sessionUser.id, expiresAt: activityAt + SESSION_MAX_AGE_MS, lastActivityAt: activityAt });
    lastActivityRef.current = activityAt;
    lastSessionWriteRef.current = activityAt;
    userRef.current = sessionUser;
    setUser(sessionUser);
    void logAction('LOGIN', `User ${normalizedUsername} logged in`, found.displayName).catch(() => undefined);
    return true;
  }, []);

  const changePassword = useCallback(async (newPassword: string): Promise<void> => {
    const current = userRef.current;
    if (!current) throw new Error('Sign in again before changing the password.');
    if (newPassword.length < PASSWORD_MIN_LENGTH) throw new Error(`Use a password with at least ${PASSWORD_MIN_LENGTH} characters.`);
    const passwordHash = await hashPassword(newPassword);
    await db.users.update(current.id, { password: passwordHash, mustChangePassword: false });
    const updated = { ...current, mustChangePassword: false };
    userRef.current = updated;
    setUser(updated);
    await logAction('PASSWORD_CHANGE', `Password changed for ${current.username}`, current.displayName);
  }, []);

  const updateUser = useCallback((updates: Partial<Pick<AuthUser, 'displayName'>>) => {
    setUser((previous) => {
      if (!previous) return null;
      const updated = { ...previous, ...updates };
      userRef.current = updated;
      return updated;
    });
  }, []);

  const contextValue = React.useMemo<AuthContextType>(
    () => ({ user, login, logout, changePassword, isAdmin: user?.role === 'admin', loading, updateUser }),
    [user, login, logout, changePassword, loading, updateUser],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
