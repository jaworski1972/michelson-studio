import { cookies } from "next/headers";
import { verifySession, sessionCookie } from "@/lib/auth";
import Studio from "./studio";

export const dynamic = "force-dynamic";

export default async function Home() {
  const store = await cookies();
  const user = verifySession(store.get(sessionCookie.name)?.value);
  return <Studio user={user} />;
}
