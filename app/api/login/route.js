import { NextResponse } from "next/server";
import { checkPassword, signSession, sessionCookie } from "@/lib/auth";

export async function POST(request) {
  const { user, password } = await request.json().catch(() => ({}));
  const u = checkPassword(user, password);
  if (!u) {
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ error: "Nieprawidłowe hasło" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, user: u });
  res.cookies.set(sessionCookie.name, signSession(u), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: sessionCookie.maxAge,
  });
  return res;
}
