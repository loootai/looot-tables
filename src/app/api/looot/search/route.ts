import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/api";
import { parsePriceUsd } from "@/lib/cost";
import { loootFromEnv } from "@/lib/looot";

export async function GET(req: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ results: [] });
  try {
    const hits = await loootFromEnv().search(q, 20);
    return NextResponse.json({
      results: hits.map((h) => ({
        endpointId: h.endpointId,
        provider: h.provider ?? null,
        name: h.name ?? h.endpointId,
        category: h.category ?? null,
        priceUsd: parsePriceUsd(h.estimatedPrice),
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
