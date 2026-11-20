# OCR language data (`eng.traineddata`)

WB Advanced sequencing uses **Tesseract.js** to OCR image-only label pages
(PDFs with no embedded text layer, like some Wildberries sticker sheets). OCR
requires the English traineddata file:

```
public/tessdata/eng.traineddata
```

This file is **not bundled** (it is ~2–23 MB depending on the build) so you must
add it yourself.

## Download

From a machine with internet access, get the official file:

```bash
curl -L -o public/tessdata/eng.traineddata \
  https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata
```

Then restart the dev server / redeploy.

## How it works

- `src/lib/ocr.ts` loads a Tesseract worker from `public/ocr/` (worker + wasm
  already bundled) and reads `eng.traineddata` from `public/tessdata/`.
- In `PDFSequencer` → **WB Advanced v4.1**, image-only sticker pages are
  OCR'd automatically, and the recovered `orderId + 4-digit code` sticker
  numbers (e.g. `5971104 2531`) are matched and rearranged to your pasted order.
- Without `eng.traineddata`, OCR reports "unavailable" and falls back to the
  embedded text layer + native barcode scan only — image-only labels won't be
  read.

## Verify

Open the WB Advanced banner after uploading a labels PDF. It should report
`Tesseract OCR ready for image-only labels.` If it says unavailable, place
`eng.traineddata` in `public/tessdata/` and reload.
