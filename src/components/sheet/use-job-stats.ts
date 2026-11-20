'use client';

import { useEffect, useState } from 'react';
import { jobStats } from '@/lib/api';
import type { JobStats } from '@/lib/job-stats';

/** A job's measured providers for this routing, fetched once per session (free). Null while loading or without a job. */
export function useJobStats(job: string | null | undefined, prefer: string): JobStats | null {
	const [stats, setStats] = useState<{ key: string; value: JobStats } | null>(null);
	const key = `${job}|${prefer}`;
	useEffect(() => {
		if (!job) return;
		let live = true;
		jobStats(job, prefer).then((value) => { if (live) setStats({ key, value }); }, () => {});
		return () => { live = false; };
	}, [job, prefer, key]);
	return job && stats?.key === key ? stats.value : null;
}
