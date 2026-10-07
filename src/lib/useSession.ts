"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { browserSupabase } from "./supabase/browser";

/** Send the visitor to /login when there is no Supabase session. */
export function useRequireSession() {
  const router = useRouter();
  useEffect(() => {
    browserSupabase().auth.getSession().then(({ data }) => {
      if (!data.session) router.replace("/login");
    });
  }, [router]);
}
