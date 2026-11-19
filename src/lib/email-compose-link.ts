import type { EmailDraft } from './types';

export const EMAIL_APPS = [
 { id: 'default', label: 'Default email app', icon: null },
 { id: 'gmail', label: 'Gmail', icon: 'gmail' },
 { id: 'slashy', label: 'Slashy', icon: null },
 { id: 'outlook', label: 'Outlook', icon: 'outlook' },
 { id: 'outlook-work', label: 'Outlook · Work or school', icon: 'outlook' },
 { id: 'yahoo', label: 'Yahoo Mail', icon: 'yahoo' },
 { id: 'proton', label: 'Proton Mail', icon: 'proton' },
 { id: 'fastmail', label: 'Fastmail', icon: 'fastmail' },
 { id: 'zoho', label: 'Zoho Mail', icon: 'zoho' },
] as const;
export type EmailApp = typeof EMAIL_APPS[number]['id'];

/** Encode values individually, including + in addresses, & in bodies and line breaks.
 * %20 avoids the literal '+' displayed by some webmail login redirects. */
function query(fields: Record<string, string>): string {
 return Object.entries(fields).filter(([, value]) => value !== '').map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}
export function emailComposeLink(app: EmailApp, draft: EmailDraft): string {
 const { to, cc, bcc, subject, body } = draft;
 const mailto = `mailto:${encodeURIComponent(to).replace(/%40/gi, '@').replace(/%2C/gi, ',')}?${query({ cc, bcc, subject, body })}`;
 switch (app) {
  case 'default': return mailto;
  case 'slashy': return `https://slashy.com/?${query({ compose: 'true', to, cc, bcc, subject, body })}`;
  case 'gmail': return `https://mail.google.com/mail/u/0/?${query({ tf: 'cm', to, cc, bcc, su: subject, body })}`;
  case 'outlook': return `https://outlook.live.com/mail/0/deeplink/compose?${query({ to, cc, bcc, subject, body })}`;
  case 'outlook-work': return `https://outlook.office.com/mail/deeplink/compose?${query({ to, cc, bcc, subject, body })}`;
  case 'yahoo': return `https://compose.mail.yahoo.com/?${query({ to, cc, bcc, subject, body })}`;
  case 'proton': return `https://mail.proton.me/inbox/#mailto=${encodeURIComponent(mailto)}`;
  case 'fastmail': return `https://app.fastmail.com/mail/inbox/compose?${query({ to, cc, bcc, subject, body })}`;
  case 'zoho': return `https://mail.zoho.com/mail/compose.do?${query({ extsrc: 'mailto', mode: 'compose', ct: mailto })}`;
 }
}
