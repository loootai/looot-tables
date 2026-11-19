import { withDatabase } from '@/lib/server/database';
import { handleMcpRequest } from '@/lib/server/mcp';
import { McpStore } from '@/lib/server/mcp-store';
import { OrganizationStore } from '@/lib/server/organization-store';
import { WorkspaceStore } from '@/lib/server/workspace-store';

export const maxDuration = 300;

export async function POST(request: Request) {
	return withDatabase((database) => handleMcpRequest(request, { keys: new McpStore(database), sheets: new WorkspaceStore(database), organization: new OrganizationStore(database) }));
}

export function GET() { return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } }); }
export const DELETE = GET;
