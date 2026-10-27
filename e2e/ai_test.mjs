import crypto from "node:crypto";
import fs from "node:fs";
import { put } from "@vercel/blob";
const BASE = process.env.BASE, SECRET = process.env.SESSION_SECRET;
const b64 = (b) => Buffer.from(b).toString("base64url");
const payload = b64(JSON.stringify({ u: "pawel", n: "Paweł", exp: Date.now() + 3600e3 }));
const cookie = `ms_session=${payload}.${b64(crypto.createHmac("sha256", SECRET).update(payload).digest())}`;
const H = { cookie, "content-type": "application/json" };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const name = process.env.NAME || "princess-solitaire.jpg";
const pathname = `uploads/${name}`;
let r = await fetch(`${BASE}/api/upload`, { method: "POST", headers: H, body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname, callbackUrl: `${BASE}/api/upload`, clientPayload: null, multipart: false } }) });
const { clientToken } = await r.json();
const blob = await put(pathname, fs.readFileSync(new URL("./" + (process.env.FILE || "princess.jpg"), import.meta.url)), { access: "public", token: clientToken, contentType: "image/jpeg" });
log("uploaded", blob.url);
r = await fetch(`${BASE}/api/jobs`, { method: "POST", headers: H, body: JSON.stringify({ input: { url: blob.url, name, size: 1 }, preset: "katalog", presetName: "Katalog (styl premium)",
  params: { photo: { packshot: true, background: "white", autocrop: true, margin: 1.35, target_side: 2000, studio: 0.5, shadow: true }, sharpen: { enabled: true, amount: 0.5 } } }) });
let job = (await r.json()).job; log("job", job.id);
for (;;) { await new Promise((s) => setTimeout(s, 4000)); const j = (await (await fetch(`${BASE}/api/jobs/${job.id}`, { headers: H })).json()).job; if (j.status !== "running") { job = j; break; } }
const src = job.result.outputs[0].url; log("PACKSHOT", src);
const prompt = process.env.PROMPT;
for (const model of ["gemini", "gpt"]) {
  const t = Date.now();
  r = await fetch(`${BASE}/api/ai-edit`, { method: "POST", headers: H, body: JSON.stringify({ imageUrl: src, name, prompt, model, parentId: job.id }) });
  const j = await r.json();
  log("AI", model, Math.round((Date.now() - t) / 1000) + "s", j.job?.status, j.job?.result?.outputs?.[0]?.url || j.job?.result?.error || JSON.stringify(j));
}
