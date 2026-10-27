"use client";

export function Brand() {
  return (
    <div className="brand">
      <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="#6F5B3A" />
        <path d="M32 14l10 10-10 26-10-26z" fill="none" stroke="#f7f4ef" strokeWidth="3.2" strokeLinejoin="round" />
        <path d="M22 24h20" stroke="#f7f4ef" strokeWidth="3.2" />
      </svg>
      <div className="brand-name">
        Michelson <span>Studio</span>
      </div>
    </div>
  );
}

export function fmtSize(b) {
  if (!b && b !== 0) return "";
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
