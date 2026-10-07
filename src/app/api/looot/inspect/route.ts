import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/api";
import { loootFromEnv } from "@/lib/looot";

export async function GET(req: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    const r = await loootFromEnv().inspect(id);
    const props = r.inputSchema?.properties ?? {};
    const required = r.inputSchema?.required ?? r.usageHints?.requiredInputFields ?? [];
    return NextResponse.json({
      endpointId: id,
      priceUsd: typeof r.estimatedMaxCost === "number" ? r.estimatedMaxCost : null,
      inputs: Object.entries(props).map(([name, p]) => ({
        name,
        type: p.type ?? "string",
        description: p.description ?? "",
        required: required.includes(name),
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
