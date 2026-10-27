"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { Brand, fmtDate, fmtSize } from "./ui";
import {
  VIDEO_PRESETS, PHOTO_PRESETS, VIDEO_OUTPUTS, BASE_COLOR, AI_MODELS, AI_SUGGESTIONS, kindOf,
} from "@/lib/presets";

const clone = (o) => JSON.parse(JSON.stringify(o));
const withColor = (p) => ({ color: { ...BASE_COLOR }, ...clone(p) });

export default function Studio({ user }) {
  const [files, setFiles] = useState([]); // {id, file, name, size, kind, status, pct, url, error}
  const [videoPreset, setVideoPreset] = useState(VIDEO_PRESETS[0].id);
  const [photoPreset, setPhotoPreset] = useState(PHOTO_PRESETS[0].id);
  const [videoParams, setVideoParams] = useState(() => withColor(VIDEO_PRESETS[0].params));
  const [photoParams, setPhotoParams] = useState(() => withColor(PHOTO_PRESETS[0].params));
  const [jobs, setJobs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [toast, setToast] = useState("");

  const hasVideo = files.some((f) => f.kind === "video");
  const hasPhoto = files.some((f) => f.kind === "photo");

  // ---------------- jobs list + polling
  const refresh = useCallback(async () => {
    const r = await fetch("/api/jobs", { cache: "no-store" });
    if (r.status === 401) return (window.location.href = "/login");
    const j = await r.json();
    setJobs((prev) => {
      const live = new Map(prev.filter((x) => x.progress).map((x) => [x.id, x.progress]));
      return (j.jobs || []).map((x) => ({
        ...x,
        status: x.result ? (x.result.ok ? "done" : "error") : "running",
        progress: live.get(x.id) || null,
      }));
    });
    setLoaded(true);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const running = jobs.filter((j) => j.status === "running").map((j) => j.id).join(",");
  useEffect(() => {
    if (!running) return;
    let stop = false;
    const tick = async () => {
      for (const id of running.split(",")) {
        const r = await fetch(`/api/jobs/${id}`, { cache: "no-store" }).catch(() => null);
        if (!r?.ok) continue;
        const { job } = await r.json();
        if (stop) return;
        setJobs((prev) => prev.map((x) => (x.id === id ? { ...x, ...job } : x)));
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [running]);

  // ---------------- file selection & upload
  function addFiles(list) {
    const items = [...list].map((file) => ({
      id: Math.random().toString(36).slice(2),
      file, name: file.name, size: file.size, kind: kindOf(file.name), status: "ready", pct: 0,
    }));
    setFiles((prev) => [...prev, ...items]);
  }

  function choosePreset(kind, id) {
    const list = kind === "video" ? VIDEO_PRESETS : PHOTO_PRESETS;
    const p = list.find((x) => x.id === id);
    if (kind === "video") { setVideoPreset(id); setVideoParams(withColor(p.params)); }
    else { setPhotoPreset(id); setPhotoParams(withColor(p.params)); }
  }

  async function submit() {
    const todo = files.filter((f) => f.kind && f.status !== "sent");
    if (!todo.length) return;
    setBusy(true);
    for (const f of todo) {
      const set = (patch) => setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, ...patch } : x)));
      try {
        let url = f.url;
        if (!url) {
          set({ status: "uploading", pct: 0 });
          const safe = f.name.normalize("NFD").replace(/[^\w.\-]+/g, "_");
          const blob = await upload(`uploads/${safe}`, f.file, {
            access: "public",
            handleUploadUrl: "/api/upload",
            multipart: f.size > 20 * 1024 * 1024,
            onUploadProgress: (e) => set({ pct: Math.round(e.percentage) }),
          });
          url = blob.url;
          set({ url });
        }
        set({ status: "starting" });
        const isVideo = f.kind === "video";
        const presetList = isVideo ? VIDEO_PRESETS : PHOTO_PRESETS;
        const presetId = isVideo ? videoPreset : photoPreset;
        const r = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: { url, name: f.name, size: f.size },
            params: isVideo ? videoParams : photoParams,
            preset: presetId,
            presetName: presetList.find((p) => p.id === presetId)?.name || "Własne ustawienia",
          }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Błąd");
        set({ status: "sent" });
        setJobs((prev) => [{ ...j.job, status: "running", progress: null }, ...prev]);
      } catch (e) {
        set({ status: "error", error: e.message });
      }
    }
    setBusy(false);
    setFiles((prev) => prev.filter((x) => x.status !== "sent"));
  }

  function rerun(job) {
    // wczytuje ten sam plik źródłowy z jego ustawieniami do formularza
    const kind = job.type;
    setFiles([{ id: job.id, name: job.input.name, size: job.input.size, kind, status: "ready", pct: 0, url: job.input.url }]);
    if (kind === "video") { setVideoPreset(job.preset || ""); setVideoParams(withColor(job.params)); }
    if (kind === "photo") { setPhotoPreset(job.preset || ""); setPhotoParams(withColor(job.params)); }
    setOpen(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    setToast("Plik wczytany do formularza – zmień ustawienia i kliknij „Przetwórz”.");
    setTimeout(() => setToast(""), 5000);
  }

  async function remove(job) {
    if (!confirm("Usunąć to zlecenie i jego pliki?")) return;
    await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
    setJobs((prev) => prev.filter((x) => x.id !== job.id));
    setOpen(null);
  }

  function onAiDone(job) {
    setJobs((prev) => [job, ...prev]);
    setOpen(job.id);
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const openJob = jobs.find((j) => j.id === open);
  const readyCount = files.filter((f) => f.kind && f.status !== "sent").length;

  return (
    <>
      <header className="topbar">
        <Brand />
        <div className="who">
          <span>{user?.name}</span>
          <button className="btn ghost small" onClick={logout}>Wyloguj</button>
        </div>
      </header>

      <main className="layout">
        <section className="panel" aria-label="Nowe zlecenie">
          <h2>Nowe zlecenie</h2>
          <DropZone onFiles={addFiles} />
          {files.length > 0 && (
            <ul className="files">
              {files.map((f) => (
                <li key={f.id}>
                  <span className={`tag ${f.kind ? "" : "err"}`}>{f.kind === "video" ? "Film" : f.kind === "photo" ? "Zdjęcie" : "?"}</span>
                  <span className="name" title={f.name}>{f.name}</span>
                  <span className="meta">
                    {f.status === "uploading" ? `${f.pct}%` : f.status === "starting" ? "start…" : f.status === "error" ? <span style={{ color: "var(--err)" }}>{f.error}</span> : fmtSize(f.size)}
                  </span>
                  {!busy && (
                    <button className="btn ghost small" aria-label="Usuń" onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))}>✕</button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {(hasVideo || !files.length) && (
            <>
              <div className="section-label">Filmy – zestaw ustawień</div>
              <Presets list={VIDEO_PRESETS} value={videoPreset} onChange={(id) => choosePreset("video", id)} />
              <details className="adv">
                <summary>Ustawienia szczegółowe filmu</summary>
                <VideoControls p={videoParams} set={(p) => { setVideoParams(p); setVideoPreset(""); }} />
              </details>
            </>
          )}

          {(hasPhoto || !files.length) && (
            <>
              <div className="section-label">Zdjęcia – zestaw ustawień</div>
              <Presets list={PHOTO_PRESETS} value={photoPreset} onChange={(id) => choosePreset("photo", id)} />
              <details className="adv">
                <summary>Ustawienia szczegółowe zdjęcia</summary>
                <PhotoControls p={photoParams} set={(p) => { setPhotoParams(p); setPhotoPreset(""); }} />
              </details>
              <p className="note" style={{ marginTop: 12 }}>
                Dopasowanie pierścionka do palca, usuwanie metek itp. – po obróbce otwórz zdjęcie i użyj <b>Edycji AI</b>.
              </p>
            </>
          )}

          <div style={{ marginTop: 18 }}>
            <button className="btn primary block" disabled={busy || !readyCount} onClick={submit}>
              {busy ? <><span className="spinner" /> Wysyłanie…</> : readyCount ? `Przetwórz (${readyCount})` : "Dodaj pliki"}
            </button>
          </div>
          {toast && <p className="note" style={{ marginTop: 10 }}>{toast}</p>}
        </section>

        <section aria-label="Historia">
          <div className="jobs-head">
            <h2 className="panel-title" style={{ fontFamily: "var(--serif)", fontSize: 22 }}>Zlecenia</h2>
            <button className="btn ghost small" onClick={refresh}>Odśwież</button>
          </div>
          {!loaded ? (
            <div className="empty"><span className="spinner dark" style={{ display: "inline-block" }} /></div>
          ) : jobs.length === 0 ? (
            <div className="empty">Tu pojawią się przetworzone filmy i zdjęcia.</div>
          ) : (
            <div className="jobs">
              {jobs.map((j) => <JobCard key={j.id} job={j} onOpen={() => setOpen(j.id)} />)}
            </div>
          )}
        </section>
      </main>

      {openJob && (
        <JobModal job={openJob} onClose={() => setOpen(null)} onRerun={rerun} onDelete={remove} onAiDone={onAiDone} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- pieces
function DropZone({ onFiles }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`drop ${over ? "over" : ""}`}
      onClick={() => input.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}
      role="button"
      tabIndex={0}
    >
      <strong>Przeciągnij filmy lub zdjęcia</strong>
      <span>albo kliknij, żeby wybrać · MOV, MP4, JPG, PNG, HEIC · można kilka naraz</span>
      <input
        ref={input} type="file" multiple hidden
        accept="video/*,image/*,.mov,.heic,.heif"
        onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }}
      />
    </div>
  );
}

function Presets({ list, value, onChange }) {
  return (
    <div className="presets">
      {list.map((p) => (
        <button key={p.id} type="button" className={`preset ${value === p.id ? "on" : ""}`} onClick={() => onChange(p.id)}>
          <b>{p.name}</b>
          <small>{p.hint}</small>
        </button>
      ))}
    </div>
  );
}

function Range({ label, value, min, max, step, onChange, fmt }) {
  return (
    <div className="ctrl">
      <label>{label}</label>
      <output>{fmt ? fmt(value) : value}</output>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}

function ColorControls({ p, set }) {
  const c = p.color || BASE_COLOR;
  const up = (k, v) => set({ ...p, color: { ...c, [k]: v } });
  const sign = (v) => (v > 0 ? `+${v}` : `${v}`);
  return (
    <>
      <Range label="Jasność" value={c.exposure} min={-1} max={1} step={0.05} onChange={(v) => up("exposure", v)} fmt={sign} />
      <Range label="Kontrast" value={c.contrast} min={0.7} max={1.4} step={0.02} onChange={(v) => up("contrast", v)} />
      <Range label="Nasycenie" value={c.saturation} min={0.6} max={1.5} step={0.02} onChange={(v) => up("saturation", v)} />
      <Range label="Temperatura barwowa" value={c.temperature} min={4500} max={8500} step={100} onChange={(v) => up("temperature", v)}
        fmt={(v) => (v === 6500 ? "neutralna" : v > 6500 ? `cieplej (${v} K)` : `chłodniej (${v} K)`)} />
    </>
  );
}

function VideoControls({ p, set }) {
  const up = (k, patch) => set({ ...p, [k]: { ...p[k], ...patch } });
  const outs = new Set(p.outputs || []);
  const defl = p.deflicker?.enabled;
  return (
    <div>
      <div className="ctrl">
        <label>Usuwanie migotania</label>
        <div className="seg">
          {[["auto", "Auto"], [true, "Wł."], [false, "Wył."]].map(([v, l]) => (
            <button key={l} type="button" className={defl === v ? "on" : ""} onClick={() => up("deflicker", { enabled: v })}>{l}</button>
          ))}
        </div>
      </div>
      <label className="check"><input type="checkbox" checked={!!p.stabilize?.enabled} onChange={(e) => up("stabilize", { enabled: e.target.checked })} /> Stabilizacja (nagrania z ręki)</label>
      {p.stabilize?.enabled && (
        <Range label="Siła wygładzania ruchu" value={p.stabilize.smoothing} min={5} max={45} step={1} onChange={(v) => up("stabilize", { smoothing: v })} />
      )}
      <label className="check"><input type="checkbox" checked={!!p.sharpen?.enabled} onChange={(e) => up("sharpen", { enabled: e.target.checked })} /> Wyostrzenie</label>
      {p.sharpen?.enabled && (
        <Range label="Siła wyostrzenia" value={p.sharpen.amount} min={0.1} max={1} step={0.05} onChange={(v) => up("sharpen", { amount: v })} />
      )}
      <label className="check"><input type="checkbox" checked={!!p.denoise?.enabled} onChange={(e) => up("denoise", { enabled: e.target.checked })} /> Odszumianie (słabe światło)</label>
      {p.denoise?.enabled && (
        <Range label="Siła odszumiania" value={p.denoise.strength} min={1} max={8} step={0.5} onChange={(v) => up("denoise", { strength: v })} />
      )}
      <ColorControls p={p} set={set} />
      <div className="section-label" style={{ marginTop: 10 }}>Pliki wynikowe</div>
      <div className="chips">
        {VIDEO_OUTPUTS.map((o) => (
          <button key={o.key} type="button" className={`chip ${outs.has(o.key) ? "on" : ""}`}
            onClick={() => {
              const n = new Set(outs);
              n.has(o.key) ? n.delete(o.key) : n.add(o.key);
              n.add("master");
              set({ ...p, outputs: [...n] });
            }}>
            {o.label}
          </button>
        ))}
      </div>
      {[...outs].some((k) => ["9x16", "1x1", "4x5", "16x9"].includes(k)) && (
        <>
          <Range label="Kadr przycięcia – poziomo" value={p.crop_offset?.x ?? 0.5} min={0} max={1} step={0.05}
            onChange={(v) => set({ ...p, crop_offset: { x: v, y: p.crop_offset?.y ?? 0.5 } })}
            fmt={(v) => (v < 0.4 ? "lewo" : v > 0.6 ? "prawo" : "środek")} />
          <Range label="Kadr przycięcia – pionowo" value={p.crop_offset?.y ?? 0.5} min={0} max={1} step={0.05}
            onChange={(v) => set({ ...p, crop_offset: { x: p.crop_offset?.x ?? 0.5, y: v } })}
            fmt={(v) => (v < 0.4 ? "góra" : v > 0.6 ? "dół" : "środek")} />
        </>
      )}
    </div>
  );
}

function PhotoControls({ p, set }) {
  const up = (k, patch) => set({ ...p, [k]: { ...p[k], ...patch } });
  const ph = p.photo || {};
  return (
    <div>
      <label className="check"><input type="checkbox" checked={ph.background === "white"} onChange={(e) => up("photo", { background: e.target.checked ? "white" : "none", packshot: e.target.checked || ph.autocrop })} /> Białe tło (usuwa tło spod produktu)</label>
      <label className="check"><input type="checkbox" checked={!!ph.autocrop} onChange={(e) => up("photo", { autocrop: e.target.checked, packshot: e.target.checked || ph.background === "white" })} /> Kadruj na produkt (kwadrat)</label>
      {ph.autocrop && (
        <Range label="Margines wokół produktu" value={ph.margin ?? 1.5} min={1.1} max={2.5} step={0.05} onChange={(v) => up("photo", { margin: v })} fmt={(v) => `${Math.round((v - 1) * 100)}%`} />
      )}
      <label className="check"><input type="checkbox" checked={!!p.deblur?.enabled} onChange={(e) => up("deblur", { enabled: e.target.checked })} /> Odzyskiwanie ostrości (lekko nieostre zdjęcia)</label>
      {p.deblur?.enabled && (
        <Range label="Siła" value={p.deblur.strength} min={0.1} max={1} step={0.05} onChange={(v) => up("deblur", { strength: v })} />
      )}
      <label className="check"><input type="checkbox" checked={!!p.sharpen?.enabled} onChange={(e) => up("sharpen", { enabled: e.target.checked })} /> Wyostrzenie detali</label>
      {p.sharpen?.enabled && (
        <Range label="Siła wyostrzenia" value={p.sharpen.amount} min={0.1} max={1} step={0.05} onChange={(v) => up("sharpen", { amount: v })} />
      )}
      <label className="check"><input type="checkbox" checked={!!ph.auto_wb} onChange={(e) => up("photo", { auto_wb: e.target.checked })} /> Automatyczny balans bieli</label>
      <ColorControls p={p} set={set} />
      <div className="ctrl">
        <label>Format</label>
        <div className="seg">
          {["jpg", "png"].map((f) => (
            <button key={f} type="button" className={(ph.format || "jpg") === f ? "on" : ""} onClick={() => up("photo", { format: f })}>{f.toUpperCase()}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function statusTag(job) {
  if (job.status === "done") return <span className="tag ok">Gotowe</span>;
  if (job.status === "error") return <span className="tag err">Błąd</span>;
  return <span className="tag run">W toku</span>;
}

function JobCard({ job, onOpen }) {
  const thumb = job.result?.previews?.after || (job.type !== "video" ? job.input?.url : null);
  const pct = job.progress?.pct ?? 0;
  return (
    <button className="job" onClick={onOpen}>
      <div className="thumb" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>
        {statusTag(job)}
        {!thumb && (job.status === "running" ? <span className="spinner dark" /> : job.type === "video" ? "Film" : "")}
      </div>
      <div className="body">
        <div className="title" title={job.input?.name}>{job.input?.name}</div>
        <div className="sub">{job.presetName || (job.type === "video" ? "Film" : "Zdjęcie")} · {job.user} · {fmtDate(job.createdAt)}</div>
        {job.status === "running" && (
          <>
            <div className="bar"><i style={{ width: `${Math.max(3, pct)}%` }} /></div>
            <div className="sub">{job.progress?.message || "uruchamianie…"}</div>
          </>
        )}
      </div>
    </button>
  );
}

function Compare({ before, after }) {
  const [pos, setPos] = useState(50);
  const box = useRef(null);
  const drag = useRef(false);
  const move = (clientX) => {
    const r = box.current.getBoundingClientRect();
    setPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div
      className="compare" ref={box}
      onPointerDown={(e) => { drag.current = true; move(e.clientX); e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => drag.current && move(e.clientX)}
      onPointerUp={() => (drag.current = false)}
    >
      <img src={before} alt="Przed" draggable={false} />
      <div className="after" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
        <img src={after} alt="Po" draggable={false} />
      </div>
      <div className="handle" style={{ left: `${pos}%` }} />
      <span className="lbl" style={{ left: 10 }}>Przed</span>
      <span className="lbl" style={{ right: 10 }}>Po</span>
    </div>
  );
}

function JobModal({ job, onClose, onRerun, onDelete, onAiDone }) {
  const res = job.result;
  const outs = res?.outputs || [];
  const videos = outs.filter((o) => o.file?.endsWith(".mp4"));
  const [view, setView] = useState("compare");
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const canCompare = res?.previews?.before && res?.previews?.after;
  const shownVideo = videos.find((v) => v.key === view);

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h3>{job.input?.name}</h3>
            <div className="sub">
              {job.presetName || ""} · {job.user} · {fmtDate(job.createdAt)}
              {res?.seconds ? ` · obróbka ${Math.round(res.seconds)} s` : ""}
              {res?.info?.w ? ` · ${res.info.w}×${res.info.h}` : ""}
            </div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Zamknij">✕</button>
        </div>

        <div className="modal-grid">
          <div>
            {job.status === "running" && (
              <div className="empty">
                <span className="spinner dark" style={{ display: "inline-block" }} />
                <p>{job.progress?.message || "Uruchamianie maszyny…"} {job.progress?.pct ? `(${Math.round(job.progress.pct)}%)` : ""}</p>
                <div className="bar" style={{ maxWidth: 320, margin: "0 auto" }}><i style={{ width: `${Math.max(3, job.progress?.pct || 0)}%` }} /></div>
              </div>
            )}
            {job.status === "error" && (
              <div className="errbox">{res?.error || "Błąd"}{res?.log ? `\n\n${res.log.slice(-800)}` : ""}</div>
            )}
            {job.status === "done" && (
              <>
                {(canCompare && videos.length > 0) && (
                  <div className="tabs">
                    <button className={`chip ${view === "compare" ? "on" : ""}`} onClick={() => setView("compare")}>Przed / po (klatka)</button>
                    {videos.map((v) => (
                      <button key={v.key} className={`chip ${view === v.key ? "on" : ""}`} onClick={() => setView(v.key)}>▶ {v.label}</button>
                    ))}
                  </div>
                )}
                {shownVideo ? (
                  <video className="player" src={shownVideo.url} controls autoPlay loop muted playsInline />
                ) : canCompare ? (
                  <Compare before={res.previews.before} after={res.previews.after} />
                ) : null}
                <p className="sub" style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 8 }}>
                  Przeciągnij suwak, żeby porównać oryginał z wersją po obróbce.
                </p>
              </>
            )}
          </div>

          <aside>
            {job.status === "done" && (
              <>
                <div className="section-label" style={{ marginTop: 0 }}>Pobierz</div>
                <div className="outputs">
                  {outs.map((o) => (
                    <div className="output" key={o.key}>
                      <div>
                        <div>{o.label}</div>
                        <div className="meta">{fmtSize(o.size)}</div>
                      </div>
                      <a className="btn small" href={`${o.url}?download=1`} download>Pobierz</a>
                    </div>
                  ))}
                </div>
              </>
            )}

            {job.status === "done" && (job.type === "photo" || job.type === "ai") && (
              <AiEdit job={job} onDone={onAiDone} />
            )}

            <div className="section-label">Akcje</div>
            <div style={{ display: "grid", gap: 8 }}>
              {job.type !== "ai" && <button className="btn" onClick={() => onRerun(job)}>Przetwórz ponownie z innymi ustawieniami</button>}
              <a className="btn" href={`${job.input?.url}?download=1`}>Pobierz oryginał</a>
              <button className="btn danger" onClick={() => onDelete(job)}>Usuń zlecenie</button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function AiEdit({ job, onDone }) {
  const sources = useMemo(() => {
    const list = [];
    const out = job.result?.outputs?.[0];
    if (out) list.push({ id: "out", label: job.type === "ai" ? "Wynik tej edycji AI" : "Wersja po obróbce", url: out.url });
    if (job.type !== "ai") list.push({ id: "orig", label: "Oryginał", url: job.input.url });
    return list;
  }, [job]);
  const [src, setSrc] = useState(sources[0]?.id);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gemini");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function run() {
    setBusy(true);
    setErr("");
    const s = sources.find((x) => x.id === src);
    const r = await fetch("/api/ai-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl: s.url, name: job.input.name, prompt, model, parentId: job.id }),
    }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (j.job?.status === "done") onDone(j.job);
    else setErr(j.job?.result?.error || j.error || "Nie udało się");
  }

  return (
    <>
      <div className="section-label">Edycja AI</div>
      <div style={{ display: "grid", gap: 8 }}>
        <select className="sel" value={src} onChange={(e) => setSrc(e.target.value)}>
          {sources.map((s) => <option key={s.id} value={s.id}>Źródło: {s.label}</option>)}
        </select>
        <textarea className="prompt" placeholder="Np. dopasuj pierścionek do palca, żeby siedział prosto" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="chips">
          {AI_SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => setPrompt(s)}>{s.split(" – ")[0]}</button>
          ))}
        </div>
        <select className="sel" value={model} onChange={(e) => setModel(e.target.value)}>
          {Object.entries(AI_MODELS).map(([k, m]) => <option key={k} value={k}>Model: {m.label}</option>)}
        </select>
        <button className="btn primary" disabled={busy || !prompt.trim()} onClick={run}>
          {busy ? <><span className="spinner" /> Generowanie (do 1 min)…</> : "Wykonaj edycję AI"}
        </button>
        {err && <div className="errbox">{err}</div>}
        <p className="note warn">AI może zmienić detale biżuterii (kamień, łapki, wzór). Zawsze porównaj wynik z oryginałem przed publikacją w sklepie.</p>
      </div>
    </>
  );
}
