import crypto from "node:crypto";
import { put } from "@vercel/blob";
const BASE = process.env.BASE, SECRET = process.env.SESSION_SECRET;
const b64 = (b) => Buffer.from(b).toString("base64url");
const payload = b64(JSON.stringify({ u: "pawel", n: "Paweł", exp: Date.now() + 3600e3 }));
const cookie = `ms_session=${payload}.${b64(crypto.createHmac("sha256", SECRET).update(payload).digest())}`;
const H = { cookie, "content-type": "application/json" };
const imgs = {
  "zolte-michelson-solitaire-3-4.webp": "https://michelson.pl/cdn/shop/files/0001-8289373339599506187.webp?width=1500",
  "zolte-michelson-solitaire-front.webp": "https://michelson.pl/cdn/shop/files/0001-5070425507672110087.webp?width=1500",
  "zolte-michelson-pave-3-4.webp": "https://michelson.pl/cdn/shop/files/0001-2550622981104184722.webp?width=1500",
  "zolte-michelson-pave-front.webp": "https://michelson.pl/cdn/shop/files/0001-7441532172274095209.webp?width=1500",
  "zolte-michelson-pave-3-4-b.webp": "https://michelson.pl/cdn/shop/files/3458.webp?width=1500",
  "zolte-michelson-pave-bok.webp": "https://michelson.pl/cdn/shop/files/3517.webp?width=1500",
};
const have = new Set(((await (await fetch(`${BASE}/api/refs`, { headers: H })).json()).refs || []).map((r) => r.name.replace(/-[A-Za-z0-9]{30}(\.\w+)$/, "$1")));
for (const [name, url] of Object.entries(imgs)) {
  if (have.has(name)) { console.log("skip", name); continue; }
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const pathname = `refs/${name}`;
  const r = await fetch(`${BASE}/api/upload`, { method: "POST", headers: H, body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname, callbackUrl: `${BASE}/api/upload`, clientPayload: null, multipart: false } }) });
  const { clientToken } = await r.json();
  const b = await put(pathname, buf, { access: "public", token: clientToken, contentType: "image/webp" });
  console.log("ref", name, buf.length, b.url);
}
