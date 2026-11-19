import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentTitle, documentFilename, isDocumentColumn } from '../src/lib/document';
import { ColumnOpSchema } from '../src/lib/types';
import { cellFromInput } from '../src/lib/formula-input';

test('documents are markdown strings with a title and portable filename', () => {
 const markdown = '# **Acme** / Company brief\n\n## Overview\n\nResearch from the row.';
 const op = ColumnOpSchema.parse({ kind: 'ai', prompt: 'One page brief on {{Company}}', output: 'document', research: 'none' });
 assert.equal(isDocumentColumn({ op }), true);
 assert.equal(isDocumentColumn({ format: 'document' }), true);
 assert.equal(isDocumentColumn({ format: 'text' }), false);
 assert.equal(cellFromInput(markdown, { format: 'document' }).v, markdown);
 assert.equal(documentTitle(markdown), 'Acme / Company brief');
 assert.equal(documentTitle('No heading', 'Company brief'), 'Company brief');
 assert.equal(documentFilename(documentTitle(markdown)), 'Acme  Company brief.pdf');
});
