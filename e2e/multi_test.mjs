import crypto from "node:crypto";
import fs from "node:fs";
import { put } from "@vercel/blob";
const BASE = process.env.BASE, SECRET = process.env.SESSION_SECRET;
const b64 = (b) => Buffer.from(b).toString("base64url");
const payload = b64(JSON.stringify({ u: "pawel", n: "Paweł", exp: Date.now() + 3600e3 }));
const cookie = `ms_session=${payload}.${b64(crypto.createHmac("sha256", SECRET).update(payload).digest())}`;
const H = { cookie, "content-type": "application/json" };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function up(local, pathname) {
  const r = await fetch(`${BASE}/api/upload`, { method: "POST", headers: H, body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname, callbackUrl: `${BASE}/api/upload`, clientPayload: null, multipart: false } }) });
  const { clientToken } = await r.json();
  return (await put(pathname, fs.readFileSync(local), { access: "public", token: clientToken, contentType: "image/jpeg" })).url;
}
// 1) seed style references (once)
const existing = (await (await fetch(`${BASE}/api/refs`, { headers: H })).json()).refs || [];
let refs = existing;
if (!existing.length) {
  for (const f of fs.readdirSync("refs")) refs.push({ url: await up(`refs/${f}`, `refs/${f}`), name: f });
  log("seeded refs", refs.length);
}
const refUrls = refs.filter((r) => /koniak/.test(r.name || r.url)).map((r) => r.url).slice(0, 3);
log("refs used", refUrls.length);
// 2) the twisted ring: original + 2 other angles
const main = await up("twist.jpg", "uploads/pierscionek-pleciony.jpg");
const extras = [await up("twist2.jpg", "uploads/pierscionek-pleciony-2.jpg"), await up("twist3.jpg", "uploads/pierscionek-pleciony-3.jpg")];
const prompt = process.env.PROMPT;
const t = Date.now();
const r = await fetch(`${BASE}/api/ai-edit`, { method: "POST", headers: H, body: JSON.stringify({ imageUrl: main, extraUrls: extras, refUrls, name: "pierscionek-pleciony.jpg", prompt, models: ["gpt", "gemini"], variants: 2, metal: "yellow" }) });
const j = await r.json();
log("AI", Math.round((Date.now() - t) / 1000) + "s", j.job?.status, j.job?.result?.error || "");
for (const o of j.job?.result?.outputs || []) if (o.variant) log(o.label, o.url);
if (j.job?.result?.warnings) log("warnings", j.job.result.warnings);
