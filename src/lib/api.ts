import { NextResponse } from "next/server";
import { LoootError } from "./looot";
import { serverSupabase } from "./supabase/server";

/** Return the signed-in Supabase client, or a 401 response. */
export async function requireUser() {
  const sb = await serverSupabase();
  const { data } = await sb.auth.getUser();
  return data.user ? { sb } : { response: NextResponse.json({ error: "Sign in first" }, { status: 401 }) };
}

export function errorResponse(e: unknown) {
  if (e instanceof LoootError) return NextResponse.json({ error: e.message }, { status: e.status >= 400 ? e.status : 502 });
  return NextResponse.json({ error: e instanceof Error ? e.message : "Unexpected error" }, { status: 500 });
}
