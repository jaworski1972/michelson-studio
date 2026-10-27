import { NextResponse } from "next/server";
import { getJob, deleteJob, writeResult } from "@/lib/jobs";
import { jobProgress, stopJob } from "@/lib/sandbox";

export const maxDuration = 30;

export async function GET(_request, { params }) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "Nie ma takiego zlecenia" }, { status: 404 });

  if (job.result) {
    if (job.sandbox && !job.result.sandboxStopped) {
      await stopJob(job.sandbox); // zwalniamy maszynę od razu po zakończeniu
      job.result.sandboxStopped = true;
      await writeResult(id, job.result).catch(() => {});
    }
    return NextResponse.json({ job: { ...job, status: job.result.ok ? "done" : "error" } });
  }
  if (!job.sandbox) return NextResponse.json({ job: { ...job, status: "error" } });

  const p = await jobProgress(job.sandbox);
  if (p.sandbox === "running" || p.sandbox === "pending" || p.sandbox === "unknown") {
    return NextResponse.json({ job: { ...job, status: "running", progress: p.progress || null } });
  }
  // maszyna się zatrzymała, a wyniku nie ma (np. przekroczony czas)
  const ageMin = (Date.now() - new Date(job.createdAt).getTime()) / 60000;
  if (ageMin < 2) return NextResponse.json({ job: { ...job, status: "running", progress: null } });
  const result = { ok: false, error: "Obróbka przerwana (przekroczony czas lub błąd maszyny)", sandboxStopped: true };
  await writeResult(id, result).catch(() => {});
  return NextResponse.json({ job: { ...job, result, status: "error" } });
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ ok: true });
  if (job.sandbox && !job.result) await stopJob(job.sandbox);
  await deleteJob(id);
  // plik źródłowy kasujemy tylko, jeśli nie korzysta z niego inne zlecenie
  return NextResponse.json({ ok: true });
}
