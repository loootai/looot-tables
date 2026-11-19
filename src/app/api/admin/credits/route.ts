import { creditReportResponse, loadCreditReport } from '@/lib/server/credit-report';

export async function GET(request: Request) {
	return creditReportResponse(request, loadCreditReport);
}
