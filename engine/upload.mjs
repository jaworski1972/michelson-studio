// Uploads engine outputs from /tmp/job/out to Vercel Blob and writes jobs/<id>/result.json.
import { put } from "@vercel/blob";
import fs from "node:fs";
import path from "node:path";

const OUT = "/tmp/job/out";
const id = process.env.JOB_ID;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const TYPES = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".png": "image/png" };

async function upload(file) {
  const p = path.join(OUT, file);
  const size = fs.statSync(p).size;
  const blob = await put(`jobs/${id}/${file}`, fs.createReadStream(p), {
    access: "public",
    addRandomSuffix: true,
    contentType: TYPES[path.extname(file)] || "application/octet-stream",
    multipart: size > 20 * 1024 * 1024,
  });
  return { url: blob.url, size };
}

const manifest = readJson(path.join(OUT, "manifest.json")) || { ok: false, error: "Silnik nie zakończył pracy" };
const result = { ok: !!manifest.ok, finishedAt: new Date().toISOString(), seconds: manifest.seconds, info: manifest.info };

try {
  if (manifest.ok) {
    result.outputs = [];
    for (const o of manifest.outputs) {
      const up = await upload(o.file);
      result.outputs.push({ key: o.key, label: o.label, file: o.file, ...up });
    }
    result.previews = {};
    for (const [k, f] of [["before", "preview_before.jpg"], ["after", "preview_after.jpg"]]) {
      if (fs.existsSync(path.join(OUT, f))) result.previews[k] = (await upload(f)).url;
    }
  } else {
    result.error = manifest.error;
    try {
      result.log = fs.readFileSync(path.join(OUT, "log.txt"), "utf8").slice(-3000);
    } catch {}
  }
} catch (e) {
  result.ok = false;
  result.error = `Błąd zapisu wyników: ${e.message}`;
}

await put(`jobs/${id}/result.json`, JSON.stringify(result), {
  access: "public",
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: "application/json",
  cacheControlMaxAge: 60,
});
console.log("result written", result.ok);
