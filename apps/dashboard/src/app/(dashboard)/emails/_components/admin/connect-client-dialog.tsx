"use client";

/**
 * "Connect a mail client" dialog - server settings + per-client setup steps
 * for the mailboxes tab. Opened from the tab header (mailbox picker shown)
 * or from a row's Connect action (mailbox fixed to that row).
 */

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import type { MailCredentials } from "@/lib/api/mail";
import { useI18n, interpolate } from "@/components/i18n-provider";

// Ground-truth verified directly on this install (`doveconf protocols` ->
// "pop3 imap sieve lmtp"), not a general assumption - flip this if the mail
// server's protocol config ever changes.
const POP3_AVAILABLE = true;

const CLIENT_KEYS = [
  "iosMail",
  "androidGmail",
  "macMail",
  "outlook",
  "thunderbird",
  ...(POP3_AVAILABLE ? (["gmailWeb"] as const) : []),
] as const;
type ClientKey = (typeof CLIENT_KEYS)[number];

export function ConnectClientDialog({
  credentials,
  mailboxUsernames,
  initialUsername,
  webmailUrl,
  onClose,
}: {
  credentials: MailCredentials;
  mailboxUsernames: string[];
  /** Set when opened from a specific row - hides the mailbox picker. */
  initialUsername?: string;
  webmailUrl?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const c = t.emailsAdmin.mailboxes.connect;
  const [username, setUsername] = useState(
    initialUsername ?? mailboxUsernames[0] ?? credentials.username,
  );
  const [activeClient, setActiveClient] = useState<ClientKey>("iosMail");
  const clientCopy = c.clients[activeClient];

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-4 shrink-0 border-b border-border/50">
        <h3 className="text-xl font-bold text-foreground mb-1">{c.title}</h3>
        <p className="text-sm text-muted-foreground">
          {interpolate(c.description, { username })}
        </p>
        {!initialUsername && mailboxUsernames.length > 1 && (
          <div className="mt-3">
            <label className="block text-xs text-muted-foreground mb-1">
              {c.mailboxPickerLabel}
            </label>
            <select
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
            >
              {mailboxUsernames.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-6">
        <section>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2.5">
            {c.serverSettingsHeading}
          </h4>
          <div className="space-y-3">
            <ServerBlock
              heading={c.imapHeading}
              rows={[
                { label: c.hostLabel, value: credentials.imapHost },
                { label: c.portLabel, value: "993" },
                { label: c.securityLabel, value: c.sslTlsSecurity },
              ]}
            />
            {POP3_AVAILABLE && (
              <ServerBlock
                heading={c.pop3Heading}
                rows={[
                  { label: c.hostLabel, value: credentials.imapHost },
                  { label: c.portLabel, value: "995" },
                  { label: c.securityLabel, value: c.sslTlsSecurity },
                ]}
              />
            )}
            <ServerBlock
              heading={c.smtpHeading}
              rows={[
                { label: c.hostLabel, value: credentials.smtpHost },
                { label: c.portLabel, value: "587" },
                { label: c.securityLabel, value: c.startTlsSecurity },
              ]}
            />
            <ServerBlock
              heading={c.smtpsHeading}
              rows={[
                { label: c.hostLabel, value: credentials.smtpHost },
                { label: c.portLabel, value: "465" },
                { label: c.securityLabel, value: c.sslTlsSecurity },
              ]}
            />
            <ServerBlock
              heading={c.accountHeading}
              rows={[{ label: c.usernameLabel, value: username }]}
            />
          </div>
          <div className="mt-3 rounded-xl border border-border/60 bg-muted/30 px-3.5 py-2.5">
            <p className="text-xs text-foreground/90 leading-relaxed">
              {c.passwordNote}
            </p>
          </div>
        </section>

        <section>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2.5">
            {c.clientsHeading}
          </h4>
          <div className="flex gap-1.5 flex-wrap mb-3">
            {CLIENT_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setActiveClient(key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                  activeClient === key
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover:text-foreground hover:bg-muted/50"
                }`}
              >
                {c.clients[key].label}
              </button>
            ))}
          </div>
          <ol className="space-y-2 text-sm text-foreground list-decimal list-inside marker:text-muted-foreground marker:text-xs">
            {clientCopy.steps.map((step, i) => (
              <li key={i} className="leading-relaxed pl-1">
                {step}
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="px-6 py-4 border-t border-border/50 shrink-0 flex items-center justify-between gap-3">
        {webmailUrl ? (
          <a
            href={webmailUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="size-3.5" />
            {c.openWebmailInstead}
          </a>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium rounded-xl bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors"
        >
          {c.close}
        </button>
      </div>
    </div>
  );
}

function ServerBlock({
  heading,
  rows,
}: {
  heading: string;
  rows: { label: string; value: string }[];
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
        {heading}
      </p>
      <dl className="space-y-1.5">
        {rows.map((row) => (
          <CopyRow key={row.label} label={row.label} value={row.value} />
        ))}
      </dl>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable (permissions/private mode) - silently ignore */
    }
  };
  return (
    <div className="flex items-center gap-3 text-[13px]">
      <dt className="w-20 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex-1 min-w-0 flex items-center gap-1.5">
        <span className="font-mono text-foreground truncate">{value}</span>
        <button
          type="button"
          onClick={copy}
          className="p-1 text-muted-foreground hover:text-foreground shrink-0"
          title={t.emailsAdmin.mailboxes.connect.copy}
          aria-label={`${t.emailsAdmin.mailboxes.connect.copy} ${label}`}
        >
          {copied ? (
            <Check className="size-3 text-success" />
          ) : (
            <Copy className="size-3" />
          )}
        </button>
      </dd>
    </div>
  );
}
