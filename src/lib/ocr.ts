/**
 * OCR worker for image-only PDF label pages.
 *
 * Uses Tesseract.js (Web Worker) to OCR rendered PDF pages when the PDF has no
 * selectable text layer — the common case for image-based Wildberries (WB)
 * sticker labels produced by some WB print flows.
 *
 * Assets (bundled with the app so OCR works offline / without a CDN):
 *   public/ocr/worker.min.js           — Tesseract worker
 *   public/ocr/tesseract-core-simd.wasm — Tesseract core (SIMD build)
 *   public/tessdata/eng.traineddata    — English traineddata (REQUIRED, see README)
 *
 * If `eng.traineddata` is missing, OCR gracefully degrades and reports
 * `available: false` instead of crashing.
 */

type OcrImage =
  | HTMLCanvasElement
  | HTMLImageElement
  | HTMLVideoElement
  | ImageData
  | Blob
  | string;

export interface OcrResult {
  text: string;
  confidence: number; // 0 - 100
  available: boolean;
}

const WORKER_PATH = '/ocr/worker.min.js';
const CORE_PATH = '/ocr/tesseract-core-simd.wasm';
const LANG_PATH = '/tessdata/';

type TesseractWorker = {
  recognize: (img: OcrImage) => Promise<{ data: { text: string; confidence: number } }>;
  terminate: () => Promise<void>;
};

let worker: TesseractWorker | null = null;
let initializing: Promise<void> | null = null;
let failed = false;

async function ensureWorker(): Promise<void> {
  if (worker) return;
  if (initializing) {
    await initializing;
    return;
  }
  initializing = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { createWorker }: { createWorker: (opts?: any) => Promise<any> } =
      await import('tesseract.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w: any = await createWorker({
      logger: () => undefined,
      workerPath: WORKER_PATH,
      corePath: CORE_PATH,
      langPath: LANG_PATH,
    });
    await w.load();
    await w.loadLanguage('eng');
    await w.initialize('eng');
    worker = {
      recognize: (img: OcrImage) => w.recognize(img),
      terminate: () => w.terminate(),
    };
  })();
  await initializing;
}

/** Check whether OCR is available (traineddata present and worker loads). */
export async function isOcrAvailable(): Promise<boolean> {
  if (failed) return false;
  if (worker) return true;
  try {
    await ensureWorker();
    return !!worker;
  } catch {
    failed = true;
    return false;
  }
}

/**
 * OCR an image (e.g. a rendered PDF page canvas). Returns empty text with
 * `available: false` when OCR cannot run (missing traineddata / worker error).
 */
export async function ocrImage(image: OcrImage): Promise<OcrResult> {
  if (failed) return { text: '', confidence: 0, available: false };
  try {
    await ensureWorker();
    if (!worker) return { text: '', confidence: 0, available: false };
    const ret = await worker.recognize(image);
    return {
      text: ret.data?.text || '',
      confidence: ret.data?.confidence ?? 0,
      available: true,
    };
  } catch (e) {
    console.warn('[ocr] recognize failed:', e);
    failed = true;
    return { text: '', confidence: 0, available: false };
  }
}

/** Release the worker (optional, e.g. on unload). */
export async function terminateOcr(): Promise<void> {
  if (worker) {
    try {
      await worker.terminate();
    } catch {
      /* ignore */
    }
    worker = null;
  }
  failed = false;
  initializing = null;
}
