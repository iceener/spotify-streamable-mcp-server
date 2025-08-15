export type Session = {
  id: string;
  createdAt: number;
  userId?: string;
  rs?: {
    access_token: string;
    refresh_token: string;
  };
  spotify?: {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number; // ms epoch
    scopes?: string[];
  };
};

const sessions = new Map<string, Session>();

export const ensureSession = (id: string): Session => {
  const existing = sessions.get(id);
  if (existing) {
    return existing;
  }
  const session: Session = { id, createdAt: Date.now() };
  sessions.set(id, session);
  return session;
};

export const getSession = (id: string): Session | null => {
  const session = sessions.get(id);
  if (!session) {
    return null;
  }
  const ttl = 24 * 60 * 60 * 1000; // 24 hours
  if (Date.now() - session.createdAt > ttl) {
    sessions.delete(id);
    return null;
  }
  return session;
};
