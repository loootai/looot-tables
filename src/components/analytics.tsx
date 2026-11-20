'use client';

import { DatabuddyProvider } from '@databuddy/sdk/react';
import { ANALYTICS_CLIENT_ID } from '@/lib/analytics';

/** Page views, Web Vitals and outbound links for deployments that configure Databuddy. Sheet IDs are masked; error capture stays off because messages can quote scraped content. */
export function Analytics() {
	if (!ANALYTICS_CLIENT_ID) return null;
	return <DatabuddyProvider clientId={ANALYTICS_CLIENT_ID} autocapture={{ attributes: true, outgoingLinks: true, webVitals: true }} maskPaths={['/app/sheets/*']} />;
}
