import { AlertCircle } from 'lucide-react';

export function InlineWarning({ message }: { message: string | null }) {
 if (!message) return null;
 return <div role="alert" className="content-in flex items-start gap-2 rounded-md border border-danger/20 bg-danger-soft p-3 text-body-sm text-fg">
  <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
  <span className="min-w-0 break-words">{message}</span>
 </div>;
}
