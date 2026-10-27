// End-to-end test of the deployed app, run inside a Vercel Sandbox.
import crypto from "node:crypto";
import fs from "node:fs";
import { put } from "@vercel/blob";
const BASE = process.env.BASE;
const SECRET = process.env.SESSION_SECRET;
const b64 = (b) => Buffer.from(b).toString("base64url");
const payload = b64(JSON.stringify({ u: "pawel", n: "Paweł (test)", exp: Date.now() + 3600e3 }));
const cookie = `ms_session=${payload}.${b64(crypto.createHmac("sha256", SECRET).update(payload).digest())}`;
const H = { cookie, "content-type": "application/json" };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function uploadFile(local, name, type) {
  const pathname = `uploads/${name}`;
  const r = await fetch(`${BASE}/api/upload`, { method: "POST", headers: H, body: JSON.stringify({
    type: "blob.generate-client-token", payload: { pathname, callbackUrl: `${BASE}/api/upload`, clientPayload: null, multipart: false } }) });
  const j = await r.json();
  if (!r.ok) throw new Error("token: " + JSON.stringify(j));
  const blob = await put(pathname, fs.readFileSync(local), { access: "public", token: j.clientToken, contentType: type });
  log("uploaded", blob.url);
  return blob.url;
}
async function job(input, params, presetName) {
  const r = await fetch(`${BASE}/api/jobs`, { method: "POST", headers: H, body: JSON.stringify({ input, params, presetName }) });
  const j = await r.json(); if (!r.ok) throw new Error("job: " + JSON.stringify(j));
  log("job started", j.job.id, j.job.sandbox); return j.job.id;
}
async function wait(id) {
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`${BASE}/api/jobs/${id}`, { headers: H }); const j = await r.json();
    if (j.job?.status !== "running") return j.job;
    log(id, j.job.progress?.stage, j.job.progress?.pct, j.job.progress?.message);
    await new Promise((s) => setTimeout(s, 5000));
  }
}
const mode = process.argv[2] || "all";
const out = {};
const nolog = await fetch(`${BASE}/api/jobs`); log("unauth GET /api/jobs ->", nolog.status);
if (mode === "all" || mode === "photo") {
  const url = await uploadFile("/vercel/repo/e2e/packshot.jpg", "e2e-packshot.jpg", "image/jpeg");
  const id = await job({ url, name: "e2e-packshot.jpg", size: 1 }, { photo: { packshot: true, background: "white", autocrop: true, margin: 1.5, target_side: 2000 }, sharpen: { enabled: true, amount: 0.5 } }, "Packshot na białym");
  out.photo = await wait(id); log("PHOTO", JSON.stringify(out.photo.result).slice(0, 800));
  out.photoUrl = url;
}
if (mode === "all" || mode === "video") {
  const url = await uploadFile("/vercel/repo/e2e/clip.mov", "e2e-clip.mov", "video/quicktime");
  const id = await job({ url, name: "e2e-clip.mov", size: 1 }, { stabilize: { enabled: true, smoothing: 20 }, deflicker: { enabled: "auto" }, sharpen: { enabled: true, amount: 0.6 }, outputs: ["master", "web", "9x16", "1x1"] }, "Social media");
  out.video = await wait(id); log("VIDEO", JSON.stringify(out.video.result).slice(0, 900));
}
if (mode === "all" || mode === "ai") {
  const src = out.photo?.result?.outputs?.[0]?.url || process.env.AI_SRC;
  const r = await fetch(`${BASE}/api/ai-edit`, { method: "POST", headers: H, body: JSON.stringify({ imageUrl: src, name: "e2e-packshot.jpg", prompt: "Usuń przezroczystą metkę za pierścionkiem", model: "gemini" }) });
  const j = await r.json(); log("AI", r.status, JSON.stringify(j.job?.result || j).slice(0, 600));
}
