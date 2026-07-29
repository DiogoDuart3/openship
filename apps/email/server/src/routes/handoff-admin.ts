import { Hono } from 'hono';
import { z } from 'zod';
import { env } from '../env';
import { probeImap } from '../lib/imap';
import { createSession, defaultMailHosts } from '../lib/session';
import { createHandoff } from '../lib/handoff';
import { tokenEquals } from './branding-admin';

const handoffSchema = z.object({
  email: z.string().email().max(255),
  authUser: z.string().min(1).max(512),
  password: z.string().min(1).max(512),
  expiresAt: z.string().datetime(),
});

export const handoffAdminRoute = new Hono();

handoffAdminRoute.post('/handoff', async (c) => {
  const token = c.req.header('x-branding-admin-token');
  if (!token || !tokenEquals(token, env.BRANDING_ADMIN_TOKEN)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const parsed = handoffSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid handoff' }, 400);
  const { email, authUser, password } = parsed.data;
  const expiresAt = new Date(parsed.data.expiresAt);
  const expectedAuthUser = `${email.toLowerCase()}*openship-handoff`;
  if (authUser !== expectedAuthUser) return c.json({ error: 'Invalid handoff identity' }, 400);
  if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 10 * 60_000 + 30_000) {
    return c.json({ error: 'Handoff expired' }, 400);
  }

  const hosts = defaultMailHosts(email);
  const ok = await probeImap({
    host: hosts.imapHost,
    port: hosts.imapPort,
    user: authUser,
    pass: password,
  });
  if (!ok) return c.json({ error: 'Handoff credentials rejected' }, 502);

  const session = await createSession({
    email,
    authUser,
    name: null,
    password,
    ...hosts,
    expiresAt,
  });
  const handoffToken = createHandoff({ sessionId: session.id, expiresAt: session.expiresAt });
  c.header('Cache-Control', 'no-store');
  return c.json({ token: handoffToken, expiresAt: session.expiresAt.toISOString() });
});
