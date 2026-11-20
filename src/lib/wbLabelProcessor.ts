/**
 * WB (Wildberries) Label Processor — browser entry point.
 *
 * Re-exports the pure, dependency-free matching engine from `wbLabelMatcher`
 * and adds the browser-side PDF processing that replaces the Python
 * pdf2image + cv2 + pytesseract OCR + pyzbar pipeline.
 *
 * Browser approach (no native OCR available):
 *   • pdfjs-dist text extraction as the primary text source (works for labels
 *     that embed selectable text — the common case for WB/Ozon labels).
 *   • Optional per-page canvas render + native `BarcodeDetector` decode for
 *     barcodes/QR when the browser supports it (graceful feature detection).
 *   • Optional Tesseract.js OCR on image-only pages (no embedded text / no
 *     barcode). Requires `public/tessdata/eng.traineddata` (see
 *     public/tessdata/README.md); gracefully disabled when missing.
 *
 * Ported from: wb_label_processor.py (v4.1)
 */

import * as pdfjsLib from 'pdfjs-dist';

// Re-export the entire pure engine so consumers can import from this module.
export * from './wbLabelMatcher';

type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>;

/** Feature-detect the native BarcodeDetector API (Chrome/Edge). */
function getBarcodeDetector(): ((source: CanvasImageSource) => Promise<{ rawValue: string; format: string }[]>) | null {
  const Ctor = typeof window !== 'undefined' ? (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector : undefined;
  if (typeof Ctor !== 'function') return null;
  try {
    const CtorFn = Ctor as {
      getSupportedFormats?: () => Promise<string[]>;
      new (opts?: unknown): { detect: (s: CanvasImageSource) => Promise<{ rawValue: string; format: string }[]> };
    };
    if (typeof CtorFn.getSupportedFormats === 'function') {
      const detector = new CtorFn({
        formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'codabar', 'itf'],
      });
      return (source) => detector.detect(source);
    }
  } catch {
    return null;
  }
  return null;
}

/** Render a PDF page to a canvas (used for barcode detection). */
async function renderPageToCanvas(page: {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
}): Promise<HTMLCanvasElement | null> {
  try {
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    await (page as unknown as {
      render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => {
        promise: Promise<void>;
      };
    }).render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  } catch {
    return null;
  }
}

export interface ProcessPdfOptions {
  /** Attempt barcode/QR decode via native BarcodeDetector when available. */
  detectBarcodes?: boolean;
  /** Run Tesseract OCR on image-only pages (no embedded text / no barcode). */
  ocr?: boolean;
  /** Called with progress (done, total) per page. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Process all pages of a PDF and extract WB-relevant data.
 * Browser equivalent of WBLabelProcessor.process_pdf.
 */
export async function processPdf(
  _pdfBytes: ArrayBuffer,
  pdfDoc: PdfDocument,
  options: ProcessPdfOptions = {},
): Promise<import('./wbLabelMatcher').WBLabelData[]> {
  const { detectBarcodes = true, ocr = true, onProgress } = options;
  // Imported lazily to keep the pure matcher free of pdfjs at module load.
  const { extractTracking, extractOrderId, extractPhone, extractCode, extractAddress, parseQrPayload, scoreWbIndicators, WB_TRACKING_RE_G } =
    await import('./wbLabelMatcher');
  const { ocrImage, isOcrAvailable } = await import('./ocr');
  const detector = detectBarcodes ? getBarcodeDetector() : null;
  const numPages = pdfDoc.numPages;
  const results: import('./wbLabelMatcher').WBLabelData[] = [];

  const OCR_TEXT_THRESHOLD = 40; // embedded text length below which we treat the page as image-only
  // Lazy OCR worker init: only pay the wasm/traineddata cost when a page
  // actually needs it. Cached so subsequent pages reuse the result.
  let ocrAvailable: boolean | null = null;
  async function resolveOcrAvailable(): Promise<boolean> {
    if (ocrAvailable !== null) return ocrAvailable;
    ocrAvailable = ocr && (await isOcrAvailable());
    return ocrAvailable;
  }

  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const textContent = await page.getTextContent();
    const embeddedText = textContent.items.map((item) => ('str' in item ? (item as { str: string }).str : '')).join(' ');

    // Decide whether to OCR: page has little embedded text, or no WB-relevant
    // data could be extracted yet. Render the canvas once — it serves both
    // barcode detection and OCR.
    const likelyImageOnly = embeddedText.trim().length < OCR_TEXT_THRESHOLD;
    let canvas: HTMLCanvasElement | null = null;
    // Only initialize the OCR worker when a page actually looks image-only,
    // so text-based PDFs never pay the wasm/traineddata cost.
    let shouldOcr = false;
    if (likelyImageOnly) {
      shouldOcr = await resolveOcrAvailable();
    }
    if (detector || (shouldOcr && likelyImageOnly)) {
      canvas = await renderPageToCanvas(page);
    }

    // Run OCR on image-only pages to recover sticker/tracking data.
    let ocrText = '';
    if (shouldOcr && canvas && likelyImageOnly) {
      try {
        const result = await ocrImage(canvas);
        if (result.available) ocrText = result.text;
      } catch {
        // OCR failure is non-fatal; fall back to embedded text only.
      }
    }

    // Combined text = embedded layer + OCR layer (OCR fills gaps on image-only labels).
    const text = [embeddedText, ocrText].filter(Boolean).join(' ').trim();

    const data: import('./wbLabelMatcher').WBLabelData = {
      pageIdx: i - 1,
      trackingNumber: null,
      wbOrderId: null,
      phoneNumber: null,
      deliveryCode: null,
      address: null,
      qrPayloads: [],
      barcodes: [],
      rawText: text,
      verticalText: '',
      rotationDetected: 0,
      ocrText,
      ocrRan: Boolean(ocrText),
    };

    // Field extraction — order mirrors the Python pipeline.
    data.trackingNumber = extractTracking(text);
    data.wbOrderId = extractOrderId(text);
    data.phoneNumber = extractPhone(text);
    data.deliveryCode = extractCode(text);
    data.address = extractAddress(text);

    // Barcode/QR decode via native API (best-effort).
    if (detector && canvas) {
      try {
        const codes = await detector(canvas);
        for (const bc of codes) {
          const value = bc.rawValue;
          data.barcodes.push(value);
          const wb = value.match(WB_TRACKING_RE_G);
          if (wb && wb.length > 0 && !data.trackingNumber) data.trackingNumber = wb[0].toUpperCase();
          WB_TRACKING_RE_G.lastIndex = 0;
          if (bc.format === 'qr_code') {
            data.qrPayloads.push(value);
            const parsed = parseQrPayload(value);
            if (parsed.tracking && !data.trackingNumber) data.trackingNumber = parsed.tracking;
            if (parsed.phone && !data.phoneNumber) data.phoneNumber = parsed.phone;
            if (parsed.code && !data.deliveryCode) data.deliveryCode = parsed.code;
            if (parsed.order_id && !data.wbOrderId) data.wbOrderId = parsed.order_id;
          }
        }
      } catch {
        // detection can fail on some pages; ignore
      }
    }

    // Rotation scoring (logical, not true rotated OCR).
    data.rotationDetected = scoreWbIndicators(text) > 0 ? 0 : 0;

    results.push(data);
    onProgress?.(i, numPages);
  }

  return results;
}

/**
 * Convenience: load a PDF via pdfjs and return both the document handle and the
 * processed label data. The caller is responsible for configuring the pdfjs
 * worker before invoking this.
 */
export async function loadAndProcessPdf(
  arrayBuffer: ArrayBuffer,
  options?: ProcessPdfOptions,
): Promise<{ doc: PdfDocument; data: import('./wbLabelMatcher').WBLabelData[] }> {
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const data = await processPdf(arrayBuffer.slice(0), doc, options);
  return { doc, data };
}
