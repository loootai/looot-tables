import { companyPreview } from '@/lib/company-preview';
import type { Column, Row } from '@/lib/types';
import { detailValue } from '@/lib/detail-value';
import { DetailValue } from './detail-value';

/** Renders only data passed in from the saved sheet. No effects, logos, or API calls. */
export function CompanyPreview({ row, column, columns }: { row: Row; column: Column; columns: Column[] }) {
	const preview = companyPreview(row, column, columns);
	return <section aria-label="Saved company intel" className="flex flex-col gap-4">
		<div>
			<h4 className="text-body-sm text-fg">Saved company intel</h4>
			<p className="mt-1 text-caption leading-relaxed text-fg-subtle">From your saved results. Opening this preview uses no credits.</p>
		</div>
		{preview.domain && <div className="text-body-sm"><DetailValue value={`https://${preview.domain}`} /></div>}
		{preview.profiles.map((profile) => <details key={profile.source} open className="rounded-lg border border-line-subtle p-3">
			<summary className="cursor-pointer text-body-sm text-fg">{profile.source}</summary>
			<p className="mt-1 text-caption text-fg-subtle">Saved with {profile.column} · {new Date(profile.time).toLocaleDateString()}</p>
			<div className="mt-3 text-body-sm"><DetailValue value={profile.data} /></div>
		</details>)}
		{preview.fields.length > 0 ? <div>
			<h5 className="mb-2 text-caption text-fg-subtle">From this row</h5>
			<dl className="divide-y divide-line-subtle rounded-lg border border-line-subtle px-3">{preview.fields.map(({ column: field, cell }) => <div key={field.id} className="min-w-0 py-3">
				<dt className="mb-1 text-caption text-fg-subtle">{field.name}</dt>
				<dd className="text-body-sm text-fg"><DetailValue value={detailValue(cell.v)} /></dd>
			</div>)}</dl>
		</div> : preview.profiles.length === 0 ? <p className="text-body-sm text-fg-subtle">No additional intel saved for this row yet.</p> : null}
	</section>;
}
