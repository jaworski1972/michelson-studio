import { Sandbox } from "@vercel/sandbox";
import { put, list } from "@vercel/blob";
import fs from "node:fs";
import path from "node:path";

const ENGINE_DIR = path.join(process.cwd(), "engine");
const REGION = "fra1";

function engineFile(name) {
  return fs.readFileSync(path.join(ENGINE_DIR, name));
}

// ---------------------------------------------------------------- base snapshot
// Snapshot = Ubuntu + ffmpeg + OpenCV + onnxruntime + model. Its id is kept in Blob (config/snapshot.json);
// SANDBOX_SNAPSHOT_ID env is only the initial seed. If the snapshot disappears, a new one is built.

async function storedSnapshotId() {
  try {
    const { blobs } = await list({ prefix: "config/snapshot.json", limit: 1 });
    if (!blobs.length) return null;
    const r = await fetch(`${blobs[0].url}?v=${Date.now()}`, { cache: "no-store" });
    return (await r.json()).snapshotId || null;
  } catch {
    return null;
  }
}

export async function currentSnapshot() {
  const stored = await storedSnapshotId();
  return { id: stored || process.env.SANDBOX_SNAPSHOT_ID || null, permanent: !!stored };
}

export async function buildSnapshot() {
  const sb = await Sandbox.create({ resources: { vcpus: 4 }, timeout: 20 * 60 * 1000, region: REGION, persistent: false });
  await sb.writeFiles([{ path: "/tmp/setup.sh", content: engineFile("setup.sh"), mode: 0o755 }]);
  const r = await sb.runCommand({ cmd: "bash", args: ["/tmp/setup.sh"], sudo: true });
  if (r.exitCode !== 0) {
    const out = await r.output("both").catch(() => "");
    await sb.stop().catch(() => {});
    throw new Error(`setup failed: ${String(out).slice(-500)}`);
  }
  const snap = await sb.snapshot({ expiration: 0 });
  await put("config/snapshot.json", JSON.stringify({ snapshotId: snap.snapshotId, createdAt: new Date().toISOString() }), {
    access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60,
  });
  return snap.snapshotId;
}

/**
 * Starts processing of a job in a fresh sandbox (from the prepared snapshot with ffmpeg,
 * OpenCV, onnxruntime and the background-removal model). Returns the sandbox name.
 */
export async function startJob(job) {
  let { id: snapshotId } = await currentSnapshot();
  const name = `job-${job.id}`;
  const vcpus = job.type === "video" ? 8 : 2;
  const base = {
    name,
    resources: { vcpus },
    timeout: 60 * 60 * 1000,
    region: REGION,
    persistent: false,
    tags: { app: "michelson-studio", job: job.id },
  };
  let sandbox;
  try {
    if (!snapshotId) snapshotId = await buildSnapshot();
    sandbox = await Sandbox.create({ ...base, source: { type: "snapshot", snapshotId } });
  } catch (e) {
    // snapshot missing/expired -> rebuild once
    snapshotId = await buildSnapshot();
    sandbox = await Sandbox.create({ ...base, source: { type: "snapshot", snapshotId } });
  }

  const ext = (job.input.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  await sandbox.writeFiles([
    { path: "/tmp/job/studio.py", content: engineFile("studio.py") },
    { path: "/tmp/job/runner.sh", content: engineFile("runner.sh"), mode: 0o755 },
    { path: "/tmp/job/upload.mjs", content: engineFile("upload.mjs") },
    { path: "/tmp/job/setup.sh", content: engineFile("setup.sh"), mode: 0o755 },
    { path: "/tmp/job/params.json", content: JSON.stringify({ ...job.params, type: job.type }) },
  ]);

  await sandbox.runCommand({
    cmd: "bash",
    args: ["/tmp/job/runner.sh"],
    cwd: "/tmp/job",
    sudo: true,
    detached: true,
    env: {
      JOB_ID: job.id,
      INPUT_URL: job.input.url,
      INPUT_EXT: ext,
      NEEDS_SETUP: "0",
      BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN || "",
    },
  });
  return name;
}

/** Live progress of a running job, or the sandbox state if it is no longer running. */
export async function jobProgress(name) {
  try {
    const sandbox = await Sandbox.get({ name });
    const status = sandbox.status;
    if (status !== "running") return { sandbox: status };
    const buf = await sandbox.readFileToBuffer({ path: "/tmp/job/out/progress.json" });
    return { sandbox: status, progress: buf ? JSON.parse(buf.toString()) : null };
  } catch (e) {
    return { sandbox: "unknown", error: String(e?.message || e) };
  }
}

export async function stopJob(name) {
  try {
    const sandbox = await Sandbox.get({ name });
    if (sandbox.status === "running") await sandbox.stop();
  } catch {
    /* already gone */
  }
}
