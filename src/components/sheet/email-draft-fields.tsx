'use client';

import type { Dispatch, SetStateAction } from 'react';
import { ChevronDown } from 'lucide-react';
import { parseEmailDraft } from '@/lib/email-draft';
import type { Cell, EmailDraft } from '@/lib/types';
import { Field, Input, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';

export function EmailDraftFields({ cell, draft, setDraft, onSave }: { cell?: Cell; draft: EmailDraft | null; setDraft: Dispatch<SetStateAction<EmailDraft | null>>; onSave: (cell: Cell) => Promise<void> }) {
 const { toast } = useToast();
 const value = draft ?? parseEmailDraft(cell?.v);
 const busy = cell?.s === 'running' || cell?.s === 'queued';
 async function save() {
  if (!draft || busy) return;
  const next = draft;
  try {
   await onSave({ v: JSON.stringify(next), s: 'done', t: Date.now(), m: { ...cell?.m, reasoning: 'Edited by hand' } });
   setDraft((current) => current === next ? null : current);
  } catch (error) { toast(error instanceof Error ? error.message : 'Could not save draft', 'error'); }
 }
 function field(name: keyof EmailDraft, label: string) {
  return <Field label={label}>{(id) => name === 'body'
   ? <Textarea id={id} rows={12} disabled={busy} onBlur={() => void save()} value={value[name]} onChange={(event) => setDraft({ ...value, [name]: event.target.value })} />
   : <Input id={id} disabled={busy} onBlur={() => void save()} value={value[name]} onChange={(event) => setDraft({ ...value, [name]: event.target.value })} />}</Field>;
 }
 return <section aria-label="Email draft" className="flex flex-col gap-4">
  {cell?.s === 'error' && <p role="alert" className="text-body-sm text-danger">{cell.e}</p>}
  {busy && <p role="status" className="text-body-sm text-fg-muted">{cell.s === 'running' ? 'Drafting email…' : 'Queued'}</p>}
  {field('to', 'To')}
  <details className="group/recipients"><summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-body-sm text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden"><ChevronDown aria-hidden className="size-3.5 shrink-0 -rotate-90 transition-transform group-open/recipients:rotate-0" strokeWidth={1.75} />Cc / Bcc{value.cc || value.bcc ? ' · Added' : ''}</summary><div className="mt-3 flex flex-col gap-3">{field('cc', 'Cc')}{field('bcc', 'Bcc')}</div></details>
  {field('subject', 'Subject')}{field('body', 'Body')}
  {cell?.f && <p className="text-caption text-fg-subtle">Editing this draft replaces its formula. Use the formula bar to keep editing the formula.</p>}
 </section>;
}
