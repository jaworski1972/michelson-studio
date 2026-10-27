// Gotowe zestawy ustawień. `params` trafia 1:1 do silnika (engine/studio.py).

export const VIDEO_PRESETS = [
  {
    id: "reka",
    name: "Pierścionek na dłoni",
    hint: "Nagranie z ręki: stabilizacja + wyostrzenie. Migotanie usuwane automatycznie, jeśli wystąpi.",
    params: {
      stabilize: { enabled: true, smoothing: 20 },
      deflicker: { enabled: "auto", strength: 1, passes: 2 },
      sharpen: { enabled: true, amount: 0.6 },
      denoise: { enabled: false, strength: 3 },
      outputs: ["master", "web"],
    },
  },
  {
    id: "jarzeniowka",
    name: "Migotanie światła",
    hint: "Jarzeniówka / LED: dwuprzebiegowe usuwanie migotania 2D + wyostrzenie kamieni.",
    params: {
      stabilize: { enabled: false, smoothing: 20 },
      deflicker: { enabled: true, strength: 1, passes: 2 },
      sharpen: { enabled: true, amount: 0.6 },
      denoise: { enabled: false, strength: 3 },
      outputs: ["master", "web"],
    },
  },
  {
    id: "statyw",
    name: "Statyw / obrotnica",
    hint: "Bez stabilizacji, lekkie odszumienie i wyostrzenie.",
    params: {
      stabilize: { enabled: false, smoothing: 20 },
      deflicker: { enabled: "auto", strength: 1, passes: 2 },
      sharpen: { enabled: true, amount: 0.5 },
      denoise: { enabled: true, strength: 2.5 },
      outputs: ["master", "web"],
    },
  },
  {
    id: "social",
    name: "Social media",
    hint: "Jak „na dłoni” + gotowe formaty Reels 9:16, post 1:1 i 4:5.",
    params: {
      stabilize: { enabled: true, smoothing: 20 },
      deflicker: { enabled: "auto", strength: 1, passes: 2 },
      sharpen: { enabled: true, amount: 0.6 },
      denoise: { enabled: false, strength: 3 },
      outputs: ["master", "web", "9x16", "1x1", "4x5"],
    },
  },
];

export const PHOTO_PRESETS = [
  {
    id: "packshot",
    name: "Packshot na białym",
    hint: "Usuwa tło i zafarb, rozjaśnia, kadruje produkt w kwadrat 2000 px.",
    params: {
      photo: { packshot: true, background: "white", autocrop: true, margin: 1.5, target_side: 2000, max_side: 3000 },
      sharpen: { enabled: true, amount: 0.5 },
      deblur: { enabled: false, strength: 0.4 },
    },
  },
  {
    id: "ostrosc",
    name: "Odzyskaj ostrość",
    hint: "Dla lekko nieostrych zdjęć: dekonwolucja + delikatne wyostrzenie detali.",
    params: {
      photo: { packshot: false, background: "none", autocrop: false, max_side: 4000 },
      sharpen: { enabled: true, amount: 0.3 },
      deblur: { enabled: true, strength: 0.4 },
    },
  },
  {
    id: "korekta",
    name: "Delikatna korekta",
    hint: "Lekkie wyostrzenie, bez zmian kadru i tła.",
    params: {
      photo: { packshot: false, background: "none", autocrop: false, max_side: 4000 },
      sharpen: { enabled: true, amount: 0.4 },
      deblur: { enabled: false, strength: 0.4 },
    },
  },
];

export const VIDEO_OUTPUTS = [
  { key: "master", label: "Pełna jakość" },
  { key: "web", label: "Strona 1080p" },
  { key: "9x16", label: "Reels 9:16" },
  { key: "1x1", label: "Post 1:1" },
  { key: "4x5", label: "Post 4:5" },
  { key: "16x9", label: "Poziomy 16:9" },
];

export const BASE_COLOR = { exposure: 0, contrast: 1, saturation: 1, temperature: 6500, gamma: 1 };

export const VIDEO_EXT = ["mp4", "mov", "m4v", "avi", "mkv", "webm", "mts"];
export const PHOTO_EXT = ["jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "heif"];

export function kindOf(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (VIDEO_EXT.includes(ext)) return "video";
  if (PHOTO_EXT.includes(ext)) return "photo";
  return null;
}

export const AI_MODELS = {
  gemini: { id: "google/gemini-3.1-flash-image-preview", label: "Gemini (Nano Banana)" },
  gpt: { id: "openai/gpt-image-2", label: "GPT Image" },
};

export const AI_SUGGESTIONS = [
  "Dopasuj pierścionek do palca – ma przylegać i siedzieć prosto, kamieniem na środku palca",
  "Wyprostuj pierścionek, żeby kamień był na środku palca",
  "Usuń metkę i drobne zabrudzenia z tła",
  "Rozjaśnij zdjęcie i daj neutralnie białe tło studyjne",
];
