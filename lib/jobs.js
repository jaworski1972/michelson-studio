import { put, list, del } from "@vercel/blob";
import crypto from "node:crypto";

// Zlecenia trzymamy w Vercel Blob:
//   jobs/<id>/job.json     – co i jak przetwarzamy (zapis jednorazowy)
//   jobs/<id>/result.json  – wynik (zapisuje go sandbox po zakończeniu)
//   jobs/<id>/<pliki>      – pliki wynikowe i podglądy

export function newJobId() {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function saveJob(job) {
  await put(`jobs/${job.id}/job.json`, JSON.stringify(job), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
}

export async function writeResult(id, result) {
  await put(`jobs/${id}/result.json`, JSON.stringify(result), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
}

async function fetchJson(url) {
  const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) return null;
  return r.json();
}

async function listAll(prefix) {
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return blobs;
}

export async function getJob(id) {
  const blobs = await listAll(`jobs/${id}/`);
  const jobBlob = blobs.find((b) => b.pathname.endsWith("/job.json"));
  if (!jobBlob) return null;
  const resBlob = blobs.find((b) => b.pathname.endsWith("/result.json"));
  const [job, result] = await Promise.all([
    fetchJson(jobBlob.url),
    resBlob ? fetchJson(resBlob.url) : null,
  ]);
  return job ? { ...job, result } : null;
}

export async function listJobs(limit = 40) {
  const blobs = await listAll("jobs/");
  const byId = new Map();
  for (const b of blobs) {
    const id = b.pathname.split("/")[1];
    if (!byId.has(id)) byId.set(id, {});
    const e = byId.get(id);
    if (b.pathname.endsWith("/job.json")) e.job = b.url;
    if (b.pathname.endsWith("/result.json")) e.result = b.url;
  }
  const ids = [...byId.keys()].filter((id) => byId.get(id).job).sort().reverse().slice(0, limit);
  return Promise.all(
    ids.map(async (id) => {
      const e = byId.get(id);
      const [job, result] = await Promise.all([fetchJson(e.job), e.result ? fetchJson(e.result) : null]);
      return job ? { ...job, result } : null;
    })
  ).then((arr) => arr.filter(Boolean));
}

export async function deleteJob(id) {
  const blobs = await listAll(`jobs/${id}/`);
  if (blobs.length) await del(blobs.map((b) => b.url));
}
