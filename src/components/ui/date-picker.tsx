'use client';

import { formatDate, parseDate, type DateFormat } from '@/lib/date-format';
import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { CalendarIcon } from 'lucide-react';
import { Calendar } from './calendar';
import { Button } from './button';

export function DatePicker({ value, label, dateFormat, editing = false, onChange, onClose }: {
	value: string; label: string; dateFormat?: DateFormat; editing?: boolean; onChange: (value: string) => void; onClose: () => void;
}) {
	const [open, setOpen] = useState(false);
	const selected = parseDate(value);
	function close() { setOpen(false); onClose(); }
	return <Popover.Root open={open || editing} onOpenChange={(next) => { setOpen(next); if (!next) onClose(); }}>
		<Popover.Trigger asChild>
			<button type="button" aria-label={label} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md text-left text-body-sm hover:bg-neutral-5 focus-visible:outline-2 focus-visible:outline-brand">
				<span className="min-w-0 flex-1 truncate">{(value ? formatDate(value, dateFormat) : null) || <span className="text-fg-subtle">Pick a date</span>}</span><CalendarIcon aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
			</button>
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Content aria-label={label} align="start" sideOffset={6} collisionPadding={8} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} className="z-[100] w-auto rounded-lg border border-line bg-surface text-fg shadow-lg">
				<Calendar mode="single" selected={selected} defaultMonth={selected} captionLayout="dropdown" startMonth={new Date(1900, 0)} endMonth={new Date(2100, 11)} autoFocus onSelect={(date) => {
					if (!date) return;
					onChange(`${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
					close();
				}} />
				<div className="border-t border-line p-2"><Button variant="ghost" size="sm" disabled={!value} onClick={() => { onChange(''); close(); }}>Clear date</Button></div>
			</Popover.Content>
		</Popover.Portal>
	</Popover.Root>;
}
