'use client';

import Image from 'next/image';
import { useState } from 'react';
import { ChevronDown, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buttonClassName } from '@/components/ui/button-class';
import { FloatingMenu } from '@/components/ui/menu';
import { EMAIL_APPS, emailComposeLink, type EmailApp } from '@/lib/email-compose-link';
import type { EmailDraft } from '@/lib/types';

function AppIcon({ icon }: { icon: typeof EMAIL_APPS[number]['icon'] }) {
 return icon ? <Image src={`/providers/email/${icon}.${icon === 'gmail' ? 'svg' : 'png'}`} alt="" width={16} height={16} className="size-4 shrink-0 object-contain" /> : <Mail aria-hidden strokeWidth={1.75} />;
}

/** A separate provider picker keeps opening a composer an explicit user action. */
export function EmailDraftAction({ draft, disabled = false }: { draft: EmailDraft; disabled?: boolean }) {
 const [app, setApp] = useState<EmailApp>('gmail');
 const [anchor, setAnchor] = useState<DOMRect | null>(null);
 const selected = EMAIL_APPS.find((entry) => entry.id === app)!;
 const empty = !Object.values(draft).some((value) => value.trim());
 const unavailable = disabled || empty;
 return <div role="group" aria-label="Create email draft" className="inline-flex shrink-0 gap-0.5">
  <a href={unavailable ? undefined : emailComposeLink(app, draft)} target={app === 'default' ? undefined : '_blank'} rel="noopener noreferrer" aria-disabled={unavailable || undefined} tabIndex={unavailable ? -1 : undefined} title={`Create draft in ${selected.label}`} className={buttonClassName('primary', 'sm', `rounded-r-none bg-black text-white ${unavailable ? 'pointer-events-none opacity-50' : ''}`)}><AppIcon icon={selected.icon} />Create draft</a>
  <Button size="sm" variant="primary" className="w-8 rounded-l-none bg-black px-0 text-white" disabled={disabled} aria-label={`Email app: ${selected.label}`} aria-haspopup="menu" aria-expanded={anchor !== null} title="Choose email app" onClick={(event) => setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect())}>
   <ChevronDown aria-hidden className="!size-3.5" strokeWidth={1.75} />
  </Button>
  {anchor && <FloatingMenu anchor={anchor} align="right" width="w-64" onClose={() => setAnchor(null)} items={EMAIL_APPS.map((entry) => ({ label: entry.label, icon: <AppIcon icon={entry.icon} />, checked: app === entry.id, onSelect: () => setApp(entry.id) }))} />}
 </div>;
}
