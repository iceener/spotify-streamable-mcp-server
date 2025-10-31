import { logger } from '../utils/logger.ts';

export type Session = {
  id: string;
  createdAt: number;
  userId?: string;
  rs?: {
    access_token: string;
    refresh_token: string;
  };
  spotify?: {
    access_token: string;
    refresh_token?: string;
    expires_at?: number; // ms epoch
    scopes?: string[];
  };
};

const sessions = new Map<string, Session>();

export const ensureSession = (id: string): Session => {
  const existing = sessions.get(id);
  if (existing) {
    void logger.info('session', {
      message: 'ensureSession: Found existing session',
      sessionId: id,
      sessionAge: Date.now() - existing.createdAt,
      hasSpotify: !!existing.spotify,
      hasRs: !!existing.rs,
    });
    return existing;
  }

  const session: Session = { id, createdAt: Date.now() };
  sessions.set(id, session);

  void logger.info('session', {
    message: 'ensureSession: Created new session',
    sessionId: id,
    totalSessions: sessions.size,
  });

  return session;
};

export const getSession = (id: string): Session | null => {
  const session = sessions.get(id);
  if (!session) {
    void logger.warning('session', {
      message: 'getSession: Session not found',
      sessionId: id,
      totalSessions: sessions.size,
    });
    return null;
  }

  const ttl = 24 * 60 * 60 * 1000; // 24 hours
  const age = Date.now() - session.createdAt;
  const isExpired = age > ttl;

  void logger.info('session', {
    message: 'getSession: Retrieved session',
    sessionId: id,
    sessionAge: age,
    sessionAgeHours: Math.round(age / (60 * 60 * 1000)),
    isExpired,
    hasSpotify: !!session.spotify,
    hasRs: !!session.rs,
  });

  if (isExpired) {
    sessions.delete(id);
    void logger.info('session', {
      message: 'getSession: Session expired and removed',
      sessionId: id,
      totalSessions: sessions.size,
    });
    return null;
  }

  return session;
};
