import { handleUpload } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";

// Klient wysyła plik prosto do Vercel Blob; tu tylko wydajemy jednorazowy token.
export async function POST(request) {
  const user = userFromRequest(request);
  if (!user) return NextResponse.json({ error: "Nie zalogowano" }, { status: 401 });
  const body = await request.json();
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!/^(uploads|refs|stones)\//.test(pathname)) throw new Error("Zła ścieżka");
        return {
          allowedContentTypes: ["video/*", "image/*", "application/octet-stream"],
          maximumSizeInBytes: 3 * 1024 * 1024 * 1024,
          addRandomSuffix: true,
        };
      },
    });
    return NextResponse.json(json);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
