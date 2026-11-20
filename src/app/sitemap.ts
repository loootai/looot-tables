import type { MetadataRoute } from 'next';
import { indexingEnabled, siteUrl } from '@/lib/server/deployment';

export default function sitemap(): MetadataRoute.Sitemap {
	return indexingEnabled() ? [{ url: siteUrl().toString(), changeFrequency: 'monthly', priority: 1 }] : [];
}
