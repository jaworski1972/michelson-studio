# Michelson Studio

Obróbka filmów i zdjęć biżuterii (michelson.pl).

- **Aplikacja**: Next.js na Vercelu (logowanie, upload, podgląd przed/po, pobieranie, edycja AI).
- **Pliki**: Vercel Blob (`uploads/`, `jobs/<id>/`).
- **Obróbka**: każde zlecenie uruchamia osobną maszynę Vercel Sandbox ze snapshotu (ffmpeg, OpenCV, onnxruntime, model IS-Net).
  Silnik: `engine/studio.py` – usuwanie migotania 2D, stabilizacja, wyostrzanie, kolor, formaty social; zdjęcia: packshot na białym tle, kadrowanie, odzyskiwanie ostrości.
- **Edycja AI**: Vercel AI Gateway (Gemini / GPT Image) – uwierzytelnienie przez OIDC, bez kluczy.

Zmienne środowiskowe: `AUTH_USERS`, `SESSION_SECRET`, `SANDBOX_SNAPSHOT_ID` (start), `BLOB_READ_WRITE_TOKEN`.
