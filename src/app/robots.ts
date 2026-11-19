import type { MetadataRoute } from 'next';
import { indexingEnabled, siteUrl } from '@/lib/server/deployment';

export default function robots(): MetadataRoute.Robots {
	// Forks keep the homepage crawlable so its noindex is seen; app paths would loop cookieless crawlers.
	if (!indexingEnabled()) return { rules: { userAgent: '*', disallow: ['/api/', '/mcp', '/app', '/login'] } };
	return {
		rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/mcp'] },
		sitemap: new URL('/sitemap.xml', siteUrl()).toString(),
	};
}
