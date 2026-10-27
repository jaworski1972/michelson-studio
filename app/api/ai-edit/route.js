import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { getVercelOidcToken } from "@vercel/oidc";
import { userFromRequest } from "@/lib/auth";
import { newJobId, saveJob, writeResult } from "@/lib/jobs";
import { AI_MODELS } from "@/lib/presets";

export const maxDuration = 300;

const GATEWAY = "https://ai-gateway.vercel.sh/v1";


const GUARD =
  "You are retouching a professional jewelry product photo for an online store. " +
  "Apply ONLY the edit requested below. Keep the jewelry design exactly identical: the same stones " +
  "(shape, size, count, cut, color), prongs, setting, band profile, engravings and metal color. " +
  "Keep the hand, skin, nails, lighting, background and framing unchanged unless the edit asks for it. " +
  "Photorealistic result, no added text or watermarks.\n\nRequested edit (may be in Polish): ";

async function token() {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  return getVercelOidcToken();
}

async function editGemini(imageUrl, prompt, auth) {
  const r = await fetch(`${GATEWAY}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AI_MODELS.gemini.id,
      modalities: ["text", "image"],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: GUARD + prompt },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      stream: false,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `AI Gateway ${r.status}`);
  const msg = j?.choices?.[0]?.message || {};
  const img = msg.images?.[0]?.image_url?.url || msg.images?.[0]?.url;
  if (!img) throw new Error(msg.content ? `Model nie zwrócił obrazu: ${String(msg.content).slice(0, 200)}` : "Model nie zwrócił obrazu");
  return dataUrlToBuffer(img);
}

async function editGpt(imageUrl, prompt, auth) {
  const r = await fetch(`${GATEWAY}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: AI_MODELS.gpt.id, prompt: GUARD + prompt, images: [{ image_url: imageUrl }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `AI Gateway ${r.status}`);
  const b64 = j?.data?.[0]?.b64_json;
  if (b64) return { buf: Buffer.from(b64, "base64"), type: "image/png" };
  if (j?.data?.[0]?.url) {
    const img = await fetch(j.data[0].url);
    return { buf: Buffer.from(await img.arrayBuffer()), type: img.headers.get("content-type") || "image/png" };
  }
  throw new Error("Model nie zwrócił obrazu");
}

function dataUrlToBuffer(u) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(u);
  if (!m) throw new Error("Nieoczekiwany format odpowiedzi");
  return { buf: Buffer.from(m[2], "base64"), type: m[1] };
}

// body: { imageUrl, name, prompt, model: 'gemini'|'gpt', parentId? }
export async function POST(request) {
  const user = userFromRequest(request);
  const { imageUrl, name, prompt, model = "gemini", parentId } = await request.json().catch(() => ({}));
  if (!imageUrl || !prompt?.trim()) return NextResponse.json({ error: "Podaj zdjęcie i polecenie" }, { status: 400 });
  if (!/^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\//.test(imageUrl)) {
    return NextResponse.json({ error: "Nieprawidłowy plik" }, { status: 400 });
  }
  const job = {
    id: newJobId(),
    type: "ai",
    input: { url: imageUrl, name: name || "zdjecie.jpg" },
    params: { prompt, model },
    presetName: `Edycja AI · ${AI_MODELS[model]?.label || model}`,
    parentId: parentId || null,
    user: user?.name || "?",
    createdAt: new Date().toISOString(),
  };
  await saveJob(job);
  const t0 = Date.now();
  try {
    const auth = await token();
    const { buf, type } = model === "gpt" ? await editGpt(imageUrl, prompt, auth) : await editGemini(imageUrl, prompt, auth);
    const ext = type.includes("jpeg") ? "jpg" : type.includes("webp") ? "webp" : "png";
    const blob = await put(`jobs/${job.id}/ai.${ext}`, buf, { access: "public", addRandomSuffix: true, contentType: type });
    const result = {
      ok: true,
      finishedAt: new Date().toISOString(),
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      outputs: [{ key: "ai", label: "Edycja AI", file: `ai.${ext}`, url: blob.url, size: buf.length }],
      previews: { before: imageUrl, after: blob.url },
    };
    await writeResult(job.id, result);
    return NextResponse.json({ job: { ...job, result, status: "done" } });
  } catch (e) {
    const result = { ok: false, error: `Edycja AI nie powiodła się: ${e.message}` };
    await writeResult(job.id, result);
    return NextResponse.json({ job: { ...job, result, status: "error" } });
  }
}
