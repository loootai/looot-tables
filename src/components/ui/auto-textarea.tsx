'use client';

import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';
import { TEXTAREA_CLASS, useFieldAria } from './field';

export function AutoTextarea({ value, rows = 2, maxRows = 10, className, onScroll, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { maxRows?: number }) {
	const ref = useRef<HTMLTextAreaElement>(null);
	function updateFade(node: HTMLTextAreaElement) {
		const top = node.scrollTop > 1;
		const bottom = node.scrollHeight - node.clientHeight - node.scrollTop > 1;
		node.style.maskImage = top || bottom ? `linear-gradient(to bottom, ${top ? 'transparent' : 'black'}, black 14px, black calc(100% - 14px), ${bottom ? 'transparent' : 'black'})` : 'none';
	}
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		// field-sizing grows the box natively between the row bounds; older engines measure scrollHeight instead.
		const native = CSS.supports('field-sizing', 'content');
		function resize() {
			if (!node) return;
			const style = getComputedStyle(node);
			const line = parseFloat(style.lineHeight);
			const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
			node.style.minHeight = `${rows * line + chrome}px`;
			node.style.maxHeight = `${maxRows * line + chrome}px`;
			if (!native) {
				const scrollTop = node.scrollTop;
				node.style.height = '0px';
				node.style.height = `${node.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`;
				node.style.overflowY = node.scrollHeight > node.clientHeight ? 'auto' : 'hidden';
				node.scrollTop = scrollTop;
			}
			updateFade(node);
		}
		resize();
		let width = node.clientWidth;
		const observer = new ResizeObserver(() => { if (node.clientWidth !== width) { width = node.clientWidth; resize(); } });
		observer.observe(node);
		return () => observer.disconnect();
	}, [value, rows, maxRows]);
	return <textarea {...useFieldAria(props)} ref={ref} value={value} rows={rows} className={clsx(TEXTAREA_CLASS, 'scrollbar-thin [field-sizing:content]', className)} onScroll={(event) => { updateFade(event.currentTarget); onScroll?.(event); }} />;
}
