import { randomBytes } from 'node:crypto';
import { deleteSession } from './session';

interface HandoffRecord {
  sessionId: string;
  expiresAt: Date;
}

const handoffs = new Map<string, HandoffRecord>();

export function createHandoff(record: HandoffRecord): string {
  const token = randomBytes(32).toString('base64url');
  handoffs.set(token, record);
  const timer = setTimeout(() => {
    handoffs.delete(token);
    void deleteSession(record.sessionId).catch(() => undefined);
  }, Math.max(0, record.expiresAt.getTime() - Date.now()));
  timer.unref?.();
  return token;
}

export function consumeHandoff(token: string): HandoffRecord | null {
  const record = handoffs.get(token);
  if (!record) return null;
  handoffs.delete(token);
  if (record.expiresAt.getTime() <= Date.now()) {
    void deleteSession(record.sessionId).catch(() => undefined);
    return null;
  }
  return record;
}
