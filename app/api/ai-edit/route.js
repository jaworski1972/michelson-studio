import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import sharp from "sharp";
import { getVercelOidcToken } from "@vercel/oidc";
import { userFromRequest } from "@/lib/auth";
import { newJobId, saveJob, writeResult } from "@/lib/jobs";
import { AI_MODELS, METALS } from "@/lib/presets";

export const maxDuration = 300;

const GATEWAY = "https://ai-gateway.vercel.sh/v1";
const BLOB_RE = /^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\//;

// Builds the instruction. Image order sent to the model: [product, ...extra angles, ...style refs]
function buildPrompt({ prompt, extras, refs, metal }) {
  const lines = [
    "You are retouching a professional jewelry product photo for an online store.",
    "IMAGE 1 is the product to edit — the result must show exactly this piece of jewelry, from the same camera angle and perspective as IMAGE 1.",
  ];
  if (extras > 0) {
    lines.push(
      `IMAGES 2–${1 + extras} show the SAME ring from other angles. Use them only to read details correctly ` +
        "(number and placement of stones, prongs, ornaments, milgrain, band profile). Keep the camera angle of IMAGE 1."
    );
  }
  if (refs > 0) {
    const a = 2 + extras;
    const b = 1 + extras + refs;
    lines.push(
      `IMAGE${refs > 1 ? `S ${a}–${b} are` : ` ${a} is`} STYLE REFERENCE${refs > 1 ? "S" : ""} from our photo retoucher (different products). ` +
        "Copy ONLY the look: lighting, pure white background, soft shadow, metal polish and stone brilliance. " +
        "IGNORE their camera angle, composition and jewelry design — never copy stones, prongs, side stones or ornaments from them."
    );
  }
  lines.push(
    "Keep the jewelry design exactly identical to IMAGE 1: same stones (shape, size, count, cut, color), prongs, setting, " +
      "ornaments, engravings and band profile. Do not invent or remove any element — in particular do not add side stones, halos or extra pavé.",
  );
  if (metal && METALS[metal]?.en) lines.push(`Metal: ${METALS[metal].en}. Keep this metal colour accurate.`);
  lines.push("Photorealistic result, no text or watermarks.", "", "Requested edit (may be in Polish):", prompt);
  return lines.join("\n");
}

async function token() {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  return getVercelOidcToken();
}

async function editGemini(urls, text, auth) {
  const r = await fetch(`${GATEWAY}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AI_MODELS.gemini.id,
      modalities: ["text", "image"],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text }, ...urls.map((url) => ({ type: "image_url", image_url: { url } }))],
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

async function editGpt(urls, text, auth) {
  const r = await fetch(`${GATEWAY}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: AI_MODELS.gpt.id, prompt: text, images: urls.map((image_url) => ({ image_url })) }),
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

// Powiększenie wyniku AI do sklepu: dłuższy bok `side` px (Lanczos), białe tło, delikatne doostrzenie.
async function upscale(buf, side, fit = false) {
  if (fit) {
    // packshot: wytnij produkt z białego tła i ustaw go tak, by zajmował ~72% kwadratu
    // model często daje lekko szare tło – rozjaśnij tak, by tło było czysto białe (bez widocznej ramki po dopasowaniu)
    const base = sharp(buf).flatten({ background: "#ffffff" }).removeAlpha();
    const { data, info } = await base.clone().raw().toBuffer({ resolveWithObject: true });
    const bg = [0, 0, 0];
    const pts = [];
    const step = Math.max(1, Math.floor(Math.min(info.width, info.height) / 40));
    for (let x = 0; x < info.width; x += step) pts.push([x, 0], [x, info.height - 1]);
    for (let y = 0; y < info.height; y += step) pts.push([0, y], [info.width - 1, y]);
    for (let c = 0; c < 3; c++) {
      const vals = pts.map(([x, y]) => data[(y * info.width + x) * info.channels + c]).sort((a, b) => a - b);
      bg[c] = Math.max(200, vals[Math.floor(vals.length / 2)]);
    }
    const flat = await base.linear(bg.map((v) => 255 / v), [0, 0, 0]).png().toBuffer();
    const trimmed = await sharp(flat).trim({ background: "#ffffff", threshold: 12 }).toBuffer({ resolveWithObject: true });
    const tw = trimmed.info.width, th = trimmed.info.height;
    const target = Math.round(side * 0.72);
    const k = target / Math.max(tw, th);
    const nw = Math.round(tw * k), nh = Math.round(th * k);
    const left = Math.round((side - nw) / 2), top = Math.round((side - nh) / 2);
    let pipe = sharp(trimmed.data).resize(nw, nh, { kernel: "lanczos3" });
    if (k > 1) pipe = pipe.sharpen({ sigma: 0.7, m1: 0.6, m2: 1.2 });
    const out = await pipe
      .extend({ top, bottom: side - nh - top, left, right: side - nw - left, background: "#ffffff" })
      .jpeg({ quality: 94, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { buf: out.data, w: out.info.width, h: out.info.height };
  }
  const img = sharp(buf).flatten({ background: "#ffffff" });
  const meta = await img.metadata();
  const long = Math.max(meta.width || 0, meta.height || 0);
  let pipe = img;
  if (long && long < side) {
    pipe = pipe
      .resize({ width: meta.width >= meta.height ? side : null, height: meta.height > meta.width ? side : null, kernel: "lanczos3" })
      .sharpen({ sigma: 0.7, m1: 0.6, m2: 1.2 });
  }
  const out = await pipe.jpeg({ quality: 94, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { buf: out.data, w: out.info.width, h: out.info.height };
}

function dataUrlToBuffer(u) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(u);
  if (!m) throw new Error("Nieoczekiwany format odpowiedzi");
  return { buf: Buffer.from(m[2], "base64"), type: m[1] };
}

function friendly(e) {
  const msg = String(e?.message || e);
  if (/free tier|paid credits|top-up|insufficient/i.test(msg)) {
    return "Edycja AI wymaga doładowania kredytów AI Gateway w Vercelu (Vercel → AI Gateway → Top up).";
  }
  return msg;
}

// body: { imageUrl, extraUrls?: [], refUrls?: [], name, prompt, models?: ['gemini','gpt'] | model, variants?: 1-3, metal?, parentId? }
export async function POST(request) {
  const user = userFromRequest(request);
  const body = await request.json().catch(() => ({}));
  const { imageUrl, name, prompt, parentId } = body;
  const extraUrls = (body.extraUrls || []).filter((u) => BLOB_RE.test(u)).slice(0, 4);
  const refUrls = (body.refUrls || []).filter((u) => BLOB_RE.test(u)).slice(0, 3);
  const models = (Array.isArray(body.models) ? body.models : [body.model || "gemini"]).filter((m) => AI_MODELS[m]);
  const variants = Math.max(1, Math.min(3, parseInt(body.variants || 1, 10)));
  const metal = METALS[body.metal] ? body.metal : "auto";
  if (!imageUrl || !prompt?.trim() || !models.length) return NextResponse.json({ error: "Podaj zdjęcie i polecenie" }, { status: 400 });
  if (!BLOB_RE.test(imageUrl)) return NextResponse.json({ error: "Nieprawidłowy plik" }, { status: 400 });

  const job = {
    id: newJobId(),
    type: "ai",
    input: { url: imageUrl, name: name || "zdjecie.jpg" },
    params: { prompt, models, variants, metal, extraUrls, refUrls },
    presetName: `Edycja AI · ${models.map((m) => AI_MODELS[m].label).join(" + ")}${variants > 1 ? ` · ${variants} warianty` : ""}`,
    parentId: parentId || null,
    user: user?.name || "?",
    createdAt: new Date().toISOString(),
  };
  await saveJob(job);
  const t0 = Date.now();
  const text = buildPrompt({ prompt, extras: extraUrls.length, refs: refUrls.length, metal: metal === "auto" ? null : metal });
  const urls = [imageUrl, ...extraUrls, ...refUrls];
  const fit = /packshot/i.test(prompt);

  try {
    const auth = await token();
    const tasks = [];
    for (const m of models) for (let v = 1; v <= variants; v++) tasks.push({ m, v });
    const settled = await Promise.allSettled(
      tasks.map(async ({ m, v }) => {
        const { buf, type } = m === "gpt" ? await editGpt(urls, text, auth) : await editGemini(urls, text, auth);
        const ext = type.includes("jpeg") ? "jpg" : type.includes("webp") ? "webp" : "png";
        const tag = `${m}${variants > 1 ? `_${v}` : ""}`;
        const [raw, big] = await Promise.all([
          put(`jobs/${job.id}/ai_${tag}.${ext}`, buf, { access: "public", addRandomSuffix: true, contentType: type }),
          upscale(buf, 2000, fit),
        ]);
        const bigBlob = await put(`jobs/${job.id}/ai_${tag}_2000.jpg`, big.buf, { access: "public", addRandomSuffix: true, contentType: "image/jpeg" });
        const label = `${AI_MODELS[m].label}${variants > 1 ? ` · wariant ${v}` : ""}`;
        return [
          { key: `ai_${tag}`, label: `${label} · ${big.w}×${big.h} JPG`, file: `ai_${tag}_2000.jpg`, url: bigBlob.url, size: big.buf.length, variant: true, w: big.w, h: big.h },
          { key: `ai_${tag}_raw`, label: `${label} · oryginał z modelu`, file: `ai_${tag}.${ext}`, url: raw.url, size: buf.length },
        ];
      })
    );
    const outputs = settled.filter((s) => s.status === "fulfilled").flatMap((s) => s.value);
    const errors = settled.filter((s) => s.status === "rejected").map((s) => friendly(s.reason));
    if (!outputs.length) throw new Error(errors[0] || "Brak wyników");
    // najpierw wersje 2000 px, potem surowe
    outputs.sort((a, b) => (b.variant ? 1 : 0) - (a.variant ? 1 : 0));
    const first = outputs[0];
    const result = {
      ok: true,
      finishedAt: new Date().toISOString(),
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      info: { w: first.w, h: first.h },
      outputs,
      warnings: errors.length ? errors : undefined,
      previews: { before: imageUrl, after: first.url },
    };
    await writeResult(job.id, result);
    return NextResponse.json({ job: { ...job, result, status: "done" } });
  } catch (e) {
    const result = { ok: false, error: `Edycja AI nie powiodła się: ${friendly(e)}` };
    await writeResult(job.id, result);
    return NextResponse.json({ job: { ...job, result, status: "error" } });
  }
}
