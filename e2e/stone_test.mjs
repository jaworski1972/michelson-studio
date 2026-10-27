import crypto from "node:crypto";
const BASE = process.env.BASE, SECRET = process.env.SESSION_SECRET;
const b64 = (b) => Buffer.from(b).toString("base64url");
const payload = b64(JSON.stringify({ u: "pawel", n: "Paweł", exp: Date.now() + 3600e3 }));
const cookie = `ms_session=${payload}.${b64(crypto.createHmac("sha256", SECRET).update(payload).digest())}`;
const H = { cookie, "content-type": "application/json" };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// 1) seed stone library
const want = [["round", "white", "angle"], ["round", "white", "top"], ["princess", "white", "angle"], ["emerald", "cognac", "angle"], ["round", "cognac", "angle"]];
const have = ((await (await fetch(`${BASE}/api/stones`, { headers: H })).json()).stones || []).map((s) => s.name);
const made = await Promise.all(want.filter(([c, col, v]) => !have.some((n) => n.startsWith(`${col}-${c}-${v}`))).map(async ([cut, color, view]) => {
  const r = await fetch(`${BASE}/api/stones`, { method: "POST", headers: H, body: JSON.stringify({ cut, color, view }) });
  const j = await r.json(); log("stone", cut, color, view, j.stone?.url || j.error); return j.stone;
}));
const stones = (await (await fetch(`${BASE}/api/stones`, { headers: H })).json()).stones;
const stoneUrl = stones.find((s) => s.name.startsWith("white-round-angle"))?.url;
log("stone used", stoneUrl);
// 2) latest twisted-ring upload + refs
const refs = (await (await fetch(`${BASE}/api/refs`, { headers: H })).json()).refs;
const refUrls = refs.filter((r) => /michelson-(venetian|pave)-3-4/.test(r.name)).map((r) => r.url).slice(0, 2);
const jobs = (await (await fetch(`${BASE}/api/jobs`, { headers: H })).json()).jobs;
const src = jobs.find((j) => j.type === "ai" && j.input?.name === "pierscionek-pleciony.jpg" && j.params?.extraUrls?.length);
const t = Date.now();
const r = await fetch(`${BASE}/api/ai-edit`, { method: "POST", headers: H, body: JSON.stringify({
  imageUrl: src.input.url, extraUrls: src.params.extraUrls, refUrls, stoneUrl, name: "pierscionek-pleciony.jpg",
  prompt: process.env.PROMPT, models: ["gpt", "gemini"], variants: 2, metal: "yellow", fill: 0.55 }) });
const j = await r.json();
log("AI", Math.round((Date.now() - t) / 1000) + "s", j.job?.status, j.job?.result?.error || "");
for (const o of j.job?.result?.outputs || []) if (o.variant) console.log(o.url);
