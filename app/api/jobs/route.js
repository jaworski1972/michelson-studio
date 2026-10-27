import { NextResponse, after } from "next/server";
import { userFromRequest } from "@/lib/auth";
import { newJobId, saveJob, listJobs } from "@/lib/jobs";
import { startJob, currentSnapshot, buildSnapshot } from "@/lib/sandbox";
import { kindOf } from "@/lib/presets";

export const maxDuration = 300;

export async function GET() {
  const jobs = await listJobs(60);
  return NextResponse.json({ jobs });
}

// body: { input: {url, name, size}, params, preset, presetName }
export async function POST(request) {
  const user = userFromRequest(request);
  const body = await request.json();
  const { input, params = {}, preset, presetName } = body || {};
  if (!input?.url || !input?.name) return NextResponse.json({ error: "Brak pliku" }, { status: 400 });
  if (!/^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\//.test(input.url)) {
    return NextResponse.json({ error: "Nieprawidłowy plik" }, { status: 400 });
  }
  const type = kindOf(input.name);
  if (!type) return NextResponse.json({ error: "Nieobsługiwany format pliku" }, { status: 400 });

  const job = {
    id: newJobId(),
    type,
    input,
    params,
    preset: preset || null,
    presetName: presetName || null,
    user: user?.name || "?",
    createdAt: new Date().toISOString(),
  };
  try {
    job.sandbox = await startJob(job);
  } catch (e) {
    return NextResponse.json({ error: `Nie udało się uruchomić obróbki: ${e.message}` }, { status: 500 });
  }
  await saveJob(job);
  // seed snapshot from env expires after 7 days -> build a permanent one in the background once
  after(async () => {
    const s = await currentSnapshot();
    if (!s.permanent) await buildSnapshot().catch((e) => console.error("snapshot build failed", e));
  });
  return NextResponse.json({ job });
}
