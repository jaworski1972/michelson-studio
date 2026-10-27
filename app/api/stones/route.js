import { NextResponse } from "next/server";
import { list, del, put } from "@vercel/blob";
import { getVercelOidcToken } from "@vercel/oidc";
import { STONE_CUTS, STONE_COLORS, STONE_VIEWS } from "@/lib/presets";

export const maxDuration = 120;

const GATEWAY = "https://ai-gateway.vercel.sh/v1";

// Biblioteka idealnych kamieni (Blob: stones/<kolor>-<szlif>-<widok>-*.png). Kamienie są generowane przez AI
// albo wgrywane z własnych zdjęć makro – nie z cudzych zdjęć (prawa autorskie).
export async function GET() {
  const out = [];
  let cursor;
  do {
    const r = await list({ prefix: "stones/", cursor, limit: 1000 });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => a.pathname.localeCompare(b.pathname));
  return NextResponse.json({ stones: out.map((b) => ({ url: b.url, name: b.pathname.slice(7) })) });
}

// body: { cut, color, view }
export async function POST(request) {
  const { cut = "round", color = "white", view = "top" } = await request.json().catch(() => ({}));
  if (!STONE_CUTS[cut] || !STONE_COLORS[color] || !STONE_VIEWS[view]) return NextResponse.json({ error: "Zły parametr" }, { status: 400 });
  const prompt =
    `Ultra-sharp professional macro studio photograph of a single loose ${STONE_CUTS[cut].en}, ${STONE_COLORS[color].en}, ${STONE_VIEWS[view].en}. ` +
    "Luxury jeweller catalogue quality like Tiffany & Co.: crisp, high-contrast facets with deep black and brilliant white areas, " +
    "sharp facet edges, lively sparkle and subtle fire, perfectly symmetrical ideal cut, flawless clarity. " +
    "Pure white seamless background, the stone centred and filling about 70% of a square frame, no setting, no prongs, no text.";
  const auth = process.env.AI_GATEWAY_API_KEY || (await getVercelOidcToken());
  const r = await fetch(`${GATEWAY}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-image-2", prompt, n: 1, size: "1024x1024" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return NextResponse.json({ error: j?.error?.message || `AI Gateway ${r.status}` }, { status: 502 });
  const b64 = j?.data?.[0]?.b64_json;
  let buf;
  if (b64) buf = Buffer.from(b64, "base64");
  else if (j?.data?.[0]?.url) buf = Buffer.from(await (await fetch(j.data[0].url)).arrayBuffer());
  else return NextResponse.json({ error: "Model nie zwrócił obrazu" }, { status: 502 });
  const blob = await put(`stones/${color}-${cut}-${view}.png`, buf, { access: "public", addRandomSuffix: true, contentType: "image/png" });
  return NextResponse.json({ stone: { url: blob.url, name: blob.pathname.slice(7) } });
}

export async function DELETE(request) {
  const { url } = await request.json().catch(() => ({}));
  if (!url || !/\.blob\.vercel-storage\.com\/stones\//.test(url)) return NextResponse.json({ error: "Zły plik" }, { status: 400 });
  await del(url);
  return NextResponse.json({ ok: true });
}
