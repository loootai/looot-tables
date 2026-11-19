import { EmailDraftSchema, type CellValue, type ColumnOp, type EmailDraft } from './types';
import { renderTemplate } from './template';
import { columnRole, type RoleColumn } from './column-roles';

export const EMAIL_FIELDS = ['to', 'cc', 'bcc', 'subject', 'body'] as const;
export const EMPTY_EMAIL: EmailDraft = { to: '', cc: '', bcc: '', subject: '', body: '' };
export function isEmailColumn(column: RoleColumn): boolean {
 return columnRole(column) === 'email-draft';
}
/** JSON keeps drafts compatible with cell storage, exports and spreadsheet formulas.
 * Formulas can also return To:/Cc:/Bcc:/Subject:/Body: lines. Plain text is the body. */
export function parseEmailDraft(value: CellValue | undefined): EmailDraft {
 if (typeof value !== 'string' || !value) return { ...EMPTY_EMAIL };
 try {
  const result = EmailDraftSchema.safeParse(JSON.parse(value));
  if (result.success) return result.data;
 } catch { /* A formula may return labeled text instead of JSON. */ }
 const draft = { ...EMPTY_EMAIL };
 let field: typeof EMAIL_FIELDS[number] | undefined;
 for (const line of value.split(/\r?\n/)) {
  const match = /^(To|Cc|Bcc|Subject|Body):[ \t]*(.*)$/i.exec(line);
  if (match && field !== 'body') {
   field = match[1].toLowerCase() as typeof EMAIL_FIELDS[number];
   draft[field] = match[2];
  } else if (field) draft[field] += `\n${line}`;
 }
 return field ? draft : { ...draft, body: value };
}
export function renderEmailDraft(op: Extract<ColumnOp, { kind: 'email-draft' }>, row: Record<string, CellValue>): EmailDraft {
 return Object.fromEntries(EMAIL_FIELDS.map((field) => [field, renderTemplate(op[field], row)])) as EmailDraft;
}
