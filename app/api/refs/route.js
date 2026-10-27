import { NextResponse } from "next/server";
import { list, del } from "@vercel/blob";

// Biblioteka wzorców stylu (np. zdjęcia „po” od retuszerki). Pliki leżą w Blob pod refs/.
export async function GET() {
  const out = [];
  let cursor;
  do {
    const r = await list({ prefix: "refs/", cursor, limit: 1000 });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return NextResponse.json({ refs: out.map((b) => ({ url: b.url, name: b.pathname.slice(5), uploadedAt: b.uploadedAt })) });
}

export async function DELETE(request) {
  const { url } = await request.json().catch(() => ({}));
  if (!url || !/\.blob\.vercel-storage\.com\/refs\//.test(url)) return NextResponse.json({ error: "Zły plik" }, { status: 400 });
  await del(url);
  return NextResponse.json({ ok: true });
}
