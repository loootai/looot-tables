import { currentAccount } from '@/lib/server/auth';

export async function GET() {
 const account=await currentAccount();
 return Response.json(account?{partition:account.partition,sessionId:account.sessionId}:{error:'Sign in required'},{status:account?200:401,headers:{'Cache-Control':'no-store'}});
}
