#!/usr/bin/env bash
# Download the Tesseract English traineddata needed for WB image-label OCR.
#
# Usage: ./scripts/download_ocr_data.sh
#
# Places public/tessdata/eng.traineddata (~2-23 MB) so the WB Advanced
# sequencer can OCR image-only label pages offline.
set -euo pipefail

DEST="public/tessdata/eng.traineddata"
mkdir -p public/tessdata

if [[ -f "$DEST" ]]; then
  echo "$DEST already exists. Remove it first to re-download."
  exit 0
fi

echo "Downloading eng.traineddata -> $DEST ..."
curl -L --fail --retry 3 \
  -o "$DEST" \
  "https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata"

echo "Done. Reload the dev server and open WB Advanced mode — the banner should report"
echo "  Tesseract OCR ready for image-only labels."
