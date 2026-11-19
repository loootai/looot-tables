'use client';

// Adapted from https://github.com/nightspite/shadcn-color-picker (MIT).
// License: third-party/shadcn-color-picker.LICENSE
import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { HexColorInput, HexColorPicker } from 'react-colorful';
import { Check } from 'lucide-react';
import { CATEGORY_COLORS, categoryColorStyle } from '@/lib/category-colors';
import { Button } from './button';
import { INPUT_CLASS } from './input-styles';

export function ColorPicker({ value, onChange, label }: { value: string; onChange: (color: string) => void; label: string }) {
	const [open, setOpen] = useState(false);
	const [container, setContainer] = useState<HTMLElement | undefined>(undefined);
	const trigger = useRef<HTMLButtonElement>(null);
	return <Popover.Root open={open} onOpenChange={(next) => { if (next) setContainer(trigger.current?.closest<HTMLElement>('[role="dialog"]') ?? undefined); setOpen(next); }}>
		<Popover.Trigger asChild>
			<button ref={trigger} type="button" aria-label={label} className="grid size-8 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
				<span className="size-6 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)] transition-transform hover:scale-110" style={{ backgroundColor: value }} />
			</button>
		</Popover.Trigger>
		{open && <Popover.Portal container={container}>
			<Popover.Content aria-label={label} sideOffset={8} align="start" collisionPadding={16} onEscapeKeyDown={(event) => event.stopPropagation()} className="z-[80] w-64 rounded-xl border border-line bg-surface p-3 shadow-floating outline-none">
				<div className="mb-3 grid grid-cols-8 gap-1.5">
					{CATEGORY_COLORS.map((color) => <button key={color} type="button" aria-label={`Use ${color}`} aria-pressed={value.toLowerCase() === color} onClick={() => onChange(color)} className="grid size-6 place-items-center rounded-full border border-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" style={categoryColorStyle(color)}>{value.toLowerCase() === color && <Check className="size-3" />}</button>)}
				</div>
				<div className="[&_.react-colorful]:w-full! [&_.react-colorful]:h-36! [&_.react-colorful__pointer]:size-4!">
					<HexColorPicker color={value} onChange={onChange} />
				</div>
				<div className="mt-3 flex items-center gap-2">
					<HexColorInput aria-label="Hex color" color={value} onChange={(color) => onChange(color.length === 4 ? `#${color.slice(1).split('').map((digit) => digit + digit).join('')}` : color)} prefixed className={`${INPUT_CLASS} h-8 font-mono`} />
					<Popover.Close asChild><Button size="sm">Done</Button></Popover.Close>
				</div>
			</Popover.Content>
		</Popover.Portal>}
	</Popover.Root>;
}
