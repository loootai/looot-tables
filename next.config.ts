import type { NextConfig } from 'next';

// Report-only until violations are reviewed. cacheComponents prerenders pages, so per-request nonces are unavailable;
// 'wasm-unsafe-eval' covers the IronCalc formula engine and Databuddy hosts cover opt-in analytics.
const contentSecurityPolicy = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.databuddy.cc${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https:",
	"font-src 'self'",
	"connect-src 'self' https://basket.databuddy.cc https://api.databuddy.cc",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
	{ key: 'Content-Security-Policy-Report-Only', value: contentSecurityPolicy },
	{ key: 'X-Content-Type-Options', value: 'nosniff' },
	{ key: 'X-Frame-Options', value: 'DENY' },
	{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
	{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
	{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
	distDir: process.env.ENRICHABLE_NEXT_DIST_DIR || '.next',
	devIndicators: process.env.ENRICHABLE_NEXT_DIST_DIR ? false : undefined,
	cacheComponents: true,
	partialPrefetching: true,
	poweredByHeader: false,
	serverExternalPackages: ['@neondatabase/serverless', 'ws', 'undici'],
	turbopack: {
		rules: {
			'*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' },
		},
	},
	async headers() {
		return [
			{ source: '/(.*)', headers: securityHeaders },
			{ source: '/api/(.*)', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
		];
	},
};

export default nextConfig;
