import { randomBytes } from "node:crypto";
import { sshManager } from "../../../lib/ssh-manager";
import { withKeyedMutex } from "../../../lib/provision-lock";
import { readState } from "../mail-state";
import { getMailbox } from "./mailboxes.service";
import { hashPassword } from "./password";

const MASTER_USERNAME = "openship-handoff";
const MASTER_FILE = "/etc/dovecot/dovecot-master-users";
const MASTER_TMP_FILE = "/etc/dovecot/.openship-handoff-master-users.tmp";
const HANDOFF_TTL_MS = 10 * 60_000;

const generations = new Map<string, number>();

function replaceMasterEntry(content: string, hash: string): string {
  const lines = content.split(/\r?\n/).filter((line) => !line.startsWith(`${MASTER_USERNAME}:`));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push(`${MASTER_USERNAME}:${hash}`);
  return `${lines.join("\n")}\n`;
}

async function writeMasterEntry(serverId: string, password: string): Promise<void> {
  await sshManager.withExecutor(serverId, async (exec) => {
    const current = await exec.readFile(MASTER_FILE).catch(() => "");
    const hash = await hashPassword(exec, password);
    await exec.writeFile(MASTER_TMP_FILE, replaceMasterEntry(current, hash));
    await exec.exec(
      `chown dovecot:dovecot ${MASTER_TMP_FILE} && chmod 0400 ${MASTER_TMP_FILE} && mv ${MASTER_TMP_FILE} ${MASTER_FILE} && doveadm reload`,
    );
  });
}

async function removeMasterEntry(serverId: string): Promise<void> {
  await sshManager.withExecutor(serverId, async (exec) => {
    const current = await exec.readFile(MASTER_FILE).catch(() => "");
    const next = current
      .split(/\r?\n/)
      .filter((line) => !line.startsWith(`${MASTER_USERNAME}:`))
      .join("\n")
      .replace(/\n+$/, "");
    await exec.writeFile(MASTER_TMP_FILE, next ? `${next}\n` : "");
    await exec.exec(
      `chown dovecot:dovecot ${MASTER_TMP_FILE} && chmod 0400 ${MASTER_TMP_FILE} && mv ${MASTER_TMP_FILE} ${MASTER_FILE} && doveadm reload`,
    );
  });
}

async function clearGeneration(serverId: string, generation: number): Promise<void> {
  if (generations.get(serverId) !== generation) return;
  await withKeyedMutex(`mail-webmail-handoff:${serverId}`, async () => {
    if (generations.get(serverId) !== generation) return;
    await removeMasterEntry(serverId);
    generations.delete(serverId);
  });
}

export interface WebmailHandoff {
  url: string;
  expiresAt: string;
}

export async function createMailboxWebmailHandoff(
  serverId: string,
  email: string,
): Promise<WebmailHandoff> {
  const mailbox = await getMailbox(serverId, email);
  if (!mailbox) throw new Error("Mailbox not found");
  if (!mailbox.active) throw new Error("Mailbox is disabled");

  const state = await sshManager.withExecutor(serverId, (exec) => readState(exec));
  const webmail = state?.webmail;
  if (!webmail?.installed || !webmail.url || !webmail.brandingToken) {
    throw new Error("Webmail is not installed");
  }

  const normalizedEmail = mailbox.username;
  const password = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);
  const generation = (generations.get(serverId) ?? 0) + 1;

  await withKeyedMutex(`mail-webmail-handoff:${serverId}`, async () => {
    generations.set(serverId, generation);
    await writeMasterEntry(serverId, password);
  });
  const cleanupTimer = setTimeout(() => {
    void clearGeneration(serverId, generation).catch(() => undefined);
  }, HANDOFF_TTL_MS);
  cleanupTimer.unref?.();

  const base = webmail.url.replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/admin/handoff`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-branding-admin-token": webmail.brandingToken,
      },
      body: JSON.stringify({
        email: normalizedEmail,
        authUser: `${normalizedEmail}*${MASTER_USERNAME}`,
        password,
        expiresAt: expiresAt.toISOString(),
      }),
    });
    if (!response.ok) {
      throw new Error(`Webmail handoff rejected (${response.status})`);
    }
    const body = (await response.json()) as { token?: string; expiresAt?: string };
    if (!body.token || !body.expiresAt) throw new Error("Webmail returned an invalid handoff");
    return {
      url: `${base}/auth/handoff?token=${encodeURIComponent(body.token)}`,
      expiresAt: body.expiresAt,
    };
  } catch (err) {
    clearTimeout(cleanupTimer);
    await clearGeneration(serverId, generation).catch(() => undefined);
    throw err;
  }
}
