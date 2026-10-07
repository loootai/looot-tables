"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserSupabase } from "@/lib/supabase/browser";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    const { error: err } = await browserSupabase().auth.signInWithPassword({ email, password });
    if (err) setError(err.message);
    else router.push("/");
  }

  return (
    <form className="card" onSubmit={signIn} style={{ maxWidth: 360, margin: "10vh auto" }}>
      <h1>looot tables</h1>
      <p className="muted">Sign in with the Supabase user you created for this app.</p>
      <div className="field"><label htmlFor="email">Email</label><input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
      <div className="field"><label htmlFor="password">Password</label><input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
      {error && <p className="err">{error}</p>}
      <button className="primary" type="submit">Sign in</button>
    </form>
  );
}
