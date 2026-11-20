import { marked, type Token, type Tokens } from 'marked';
import type { Column, Content, ContentImage, ContentText, TDocumentDefinitions } from 'pdfmake/interfaces';
import { documentFilename, documentTitle } from './document';
import { brandAccent, type DocumentBrand, type DocumentBranding } from './document-branding';

function safeLink(href: string): string | undefined {
	return /^(https?:\/\/|mailto:)/i.test(href) ? href : undefined;
}

type MarkdownToken = Tokens.Heading | Tokens.Paragraph | Tokens.Text | Tokens.Strong | Tokens.Em | Tokens.Del | Tokens.Link | Tokens.Br | Tokens.HTML | Tokens.Space | Tokens.List | Tokens.Blockquote | Tokens.Code | Tokens.Hr | Tokens.Table | Tokens.Image | Tokens.Codespan | Tokens.Escape | Tokens.Def;

function inline(tokens: Token[]): ContentText[] {
	return tokens.flatMap((raw): ContentText[] => {
		const token = raw as MarkdownToken;
		switch (token.type) {
			case 'strong': return [{ text: inline(token.tokens), bold: true }];
			case 'em': return [{ text: inline(token.tokens), font: 'Roboto', italics: true }];
			case 'del': return [{ text: inline(token.tokens), decoration: 'lineThrough' }];
			case 'link': return [{ text: inline(token.tokens), link: safeLink(token.href), color: '#1f5c45' }];
			case 'br': return [{ text: '\n' }];
			case 'html': return [];
			default: return [{ text: 'text' in token ? String(token.text) : token.raw }];
		}
	});
}

function tableWidths(token: Tokens.Table): Array<number | '*'> {
	const lengths = token.header.map((cell, index) => Math.max(cell.text.length, ...token.rows.map((row) => row[index]?.text.length ?? 0)));
	const longest = Math.max(...lengths);
	const widths = lengths.map((length): number | '*' => longest > 30 && length <= 24 ? Math.min(110, Math.max(45, length * 5)) : '*');
	return widths.reduce<number>((sum, width) => sum + (typeof width === 'number' ? width : 0), 0) > (507 - lengths.length * 16) * 0.6 ? lengths.map(() => '*') : widths;
}

function blocks(tokens: Token[]): Content[] {
	return tokens.flatMap((raw): Content[] => {
		const token = raw as MarkdownToken;
		switch (token.type) {
			case 'space': case 'html': return [];
			case 'heading': return [{ text: inline(token.tokens), fontSize: [24, 13, 11, 10.5, 10.5, 10.5][token.depth - 1], bold: token.depth !== 1, margin: [0, token.depth === 1 ? 0 : 12, 0, 6], headlineLevel: token.depth }];
			case 'paragraph': case 'text': return [{ text: token.tokens ? inline(token.tokens) : token.text, margin: [0, 0, 0, 8] }];
			case 'list': {
				const items = token.items.map((item) => ({ stack: blocks(item.tokens) }));
				return [token.ordered ? { ol: items, start: typeof token.start === 'number' ? token.start : 1, margin: [0, 0, 0, 8] } : { ul: items, margin: [0, 0, 0, 8] }];
			}
			case 'blockquote': return [{ table: { widths: ['*'], body: [[{ stack: blocks(token.tokens), margin: [10, 8, 10, 2], fillColor: '#f2f4f7' }]] }, layout: 'noBorders', margin: [0, 4, 0, 8] }];
			case 'code': return [{ text: token.text, fontSize: 9, preserveLeadingSpaces: true, background: '#f4f4f5', margin: [0, 4, 0, 10] }];
			case 'hr': return [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 495, y2: 0, lineWidth: 0.5, lineColor: '#dddddd' }], margin: [0, 8, 0, 12] }];
			case 'table': return [{ table: { headerRows: 1, widths: tableWidths(token), body: [token.header.map((cell, index) => ({ text: inline(cell.tokens), bold: true, fillColor: '#f0f2f5', alignment: token.align[index] ?? 'left' })), ...token.rows.map((row) => row.map((cell, index) => ({ text: inline(cell.tokens), alignment: token.align[index] ?? 'left' })))] }, layout: { hLineWidth: (index) => index === 0 ? 0 : 0.5, vLineWidth: () => 0, hLineColor: () => '#e0e3e8', paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 6, paddingBottom: () => 6 }, fontSize: 9.5, margin: [0, 4, 0, 10] }];
			default: return [{ text: token.raw, margin: [0, 0, 0, 8] }];
		}
	});
}

function brandMark(brand: DocumentBrand, alignment: 'left' | 'right'): ContentImage | ContentText {
	return brand.logoData ? { image: brand.logoData, fit: [160, 32], alignment } : { text: brand.name.length > 45 ? `${brand.name.slice(0, 44)}…` : brand.name, fontSize: 12, bold: true, alignment };
}

export function documentPdfTitle(markdown: string, fallback: string, { primary, secondary }: DocumentBranding = {}): string {
	return primary && secondary && primary.domain !== secondary.domain ? `${primary.name} × ${secondary.name}` : documentTitle(markdown, fallback);
}

export function documentPdfDefinition(markdown: string, fallback: string, branding: DocumentBranding = {}): TDocumentDefinitions {
	const { primary, secondary } = branding;
	const distinctSecondary = secondary?.domain !== primary?.domain ? secondary : undefined;
	const marks: Column[] = [];
	if (primary) marks.push({ ...brandMark(primary, 'left'), width: 200 });
	marks.push({ text: '', width: '*' });
	if (distinctSecondary) marks.push({ ...brandMark(distinctSecondary, 'right'), width: 200 });
	const title = documentPdfTitle(markdown, fallback, branding);
	const tokens = marked.lexer(markdown);
	if (primary && distinctSecondary) {
		const heading = tokens.findIndex((token) => token.type === 'heading' && token.depth === 1);
		const replacement: Tokens.Heading = { type: 'heading', depth: 1, raw: '', text: title, tokens: [{ type: 'text', raw: title, text: title }] };
		if (heading >= 0) tokens[heading] = replacement;
		else tokens.unshift(replacement);
	}
	return {
		info: { title },
		pageSize: 'A4', pageMargins: [44, 100, 44, 48],
		defaultStyle: { font: 'Rethink', fontSize: 10.5, lineHeight: 1.2, color: '#30343b' },
		background: (_page, size) => ({ canvas: [{ type: 'rect', x: 0, y: 0, w: 5, h: size.height, color: brandAccent(primary?.accentColor) }] }),
		header: { columns: marks, margin: [44, 30, 44, 0] },
		content: blocks(tokens),
		pageBreakBefore: (node, queries) => Boolean(node.headlineLevel && queries.getFollowingNodesOnPage().length === 0 && queries.getNodesOnNextPage().length > 0),
		footer: (page, pages) => ({ columns: [{ text: primary?.domain ?? '', width: '*' }, { text: pages > 1 ? `${page} / ${pages}` : '', alignment: 'right' }], fontSize: 8, color: '#606875', margin: [44, 12, 44, 0] }),
	};
}

/** A decoded image stays drawable after its object URL is revoked, so the blob is released as soon as it loads. */
async function decodeImage(blob: Blob) {
	const url = URL.createObjectURL(blob);
	const image = new Image();
	image.src = url;
	try { await image.decode(); }
	finally { URL.revokeObjectURL(url); }
	return image;
}

async function embeddedBrand(brand?: DocumentBrand): Promise<DocumentBrand | undefined> {
	if (!brand?.logoUrl) return brand;
	try {
		const response = await fetch(brand.logoUrl, { signal: AbortSignal.timeout(8000), credentials: 'omit', referrerPolicy: 'no-referrer' });
		if (!response.ok) return brand;
		const blob = await response.blob();
		if (blob.size > 5_000_000 || !blob.type.startsWith('image/')) return brand;
		const image = await decodeImage(blob);
		const canvas = document.createElement('canvas');
		const scale = Math.min(1, 648 / image.width, 144 / image.height);
		canvas.width = Math.max(1, Math.round(image.width * scale));
		canvas.height = Math.max(1, Math.round(image.height * scale));
		const context = canvas.getContext('2d');
		if (!context) return brand;
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		// Trim transparent and white padding so the visible wordmark fills its header slot.
		const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
		let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
		for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
			const offset = (y * canvas.width + x) * 4;
			if (data[offset + 3] < 16 || Math.min(data[offset], data[offset + 1], data[offset + 2]) > 245) continue;
			left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
		}
		if (right < left) return brand;
		const cropped = document.createElement('canvas');
		cropped.width = right - left + 1;
		cropped.height = bottom - top + 1;
		cropped.getContext('2d')!.drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
		return { ...brand, logoData: cropped.toDataURL('image/png') };
	} catch { return brand; }
}

export async function downloadDocumentPdf(markdown: string, fallback: string, branding: DocumentBranding = {}): Promise<void> {
	const [{ default: pdfMake }, { default: fonts }] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')]);
	pdfMake.addVirtualFileSystem(fonts);
	pdfMake.addFonts({ Rethink: { normal: `${location.origin}/fonts/document/rethink-regular.ttf`, bold: `${location.origin}/fonts/document/rethink-semibold.ttf`, italics: `${location.origin}/fonts/document/rethink-regular.ttf`, bolditalics: `${location.origin}/fonts/document/rethink-semibold.ttf` } });
	const [primary, secondary] = await Promise.all([embeddedBrand(branding.primary), embeddedBrand(branding.secondary)]);
	await pdfMake.createPdf(documentPdfDefinition(markdown, fallback, { primary, secondary })).download(documentFilename(documentPdfTitle(markdown, fallback, { primary, secondary })));
}
