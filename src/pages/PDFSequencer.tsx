import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, FileText, ArrowUpDown, Download, Trash2, AlertTriangle, ScanBarcode, Sparkles, Maximize2, X, CheckCircle2, Filter } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';
import {
  processPdf,
  parseTargetList,
  matchTargets,
  type WBLabelData,
  type WBLabelMatch,
  type WBTarget,
} from '@/lib/wbLabelProcessor';
import { extractTrackingIds, matchTrackingSequence, normalizeTrackingId, parseTrackingSequence, type PdfMarketplace } from '@/lib/pdfSequence';

// Configure PDF.js worker using local Vite asset URL
if (typeof window !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
}

interface ExtractedPage {
  id: number;
  text: string;
  codes: string[];
}

interface ResultRow {
  status: string;
  sequenceOrder: number;
  id: string;
  originalPage: string | number;
  outputPage: string | number;
  notes: string;
}

interface WbMatchRow {
  sequenceOrder: number;
  targetRaw: string;
  matchType: string;
  confidence: number;
  pageIdx: number;
  matchedFields: Record<string, string>;
}

type SequencerMode = 'smart' | 'strict' | 'wb';
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PDF_PAGES = 1_000;

/** Build display codes for a processed WB label page: tracking, sticker (order + code), barcodes. */
function wbPageCodes(ld: WBLabelData): string[] {
  const codes: string[] = [];
  if (ld.trackingNumber) codes.push(ld.trackingNumber);
  if (ld.wbOrderId && ld.deliveryCode) codes.push(`${ld.wbOrderId} ${ld.deliveryCode}`);
  else if (ld.wbOrderId) codes.push(ld.wbOrderId);
  for (const b of ld.barcodes.slice(0, 2)) codes.push(b);
  return codes;
}

export default function PDFSequencer() {
  const [sequenceList, setSequenceList] = useState(() => {
    if (typeof window === 'undefined') return '';
    try {
      return window.sessionStorage.getItem('wms-sequence') || '';
    } catch {
      return '';
    }
  });
  const [pages, setPages] = useState<ExtractedPage[]>([]);
  const [sortedPages, setSortedPages] = useState<ExtractedPage[]>([]);
  const [unmatchedPages, setUnmatchedPages] = useState<ResultRow[]>([]);
  const [duplicateIds, setDuplicateIds] = useState<{ id: string; count: number }[]>([]);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState('');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [mode, setMode] = useState<SequencerMode>('strict');
  const [marketplace, setMarketplace] = useState<PdfMarketplace>('ozon');
  const [removeDuplicates, setRemoveDuplicates] = useState(false);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [wbData, setWbData] = useState<WBLabelData[]>([]);
  const [wbMatches, setWbMatches] = useState<WbMatchRow[]>([]);
  const [wbBarcodeSupported, setWbBarcodeSupported] = useState<boolean | null>(null);
  const [ocrSupported, setOcrSupported] = useState<boolean | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Detect OCR (Tesseract) readiness on mount so the WB banner can advise users.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { isOcrAvailable } = await import('@/lib/ocr');
      if (!cancelled) setOcrSupported(await isOcrAvailable());
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyFilter, setVerifyFilter] = useState<'all' | 'match' | 'missing' | 'extra'>('all');

  const processPdfFile = useCallback(async (file: File, selectedMarketplace: PdfMarketplace = marketplace) => {
    if (file.size > MAX_PDF_BYTES) {
      setPages([]);
      setSortedPages([]);
      setPdfBytes(null);
      setSourceFile(null);
      setFileName('');
      setResults([]);
      setUnmatchedPages([]);
      setDuplicateIds([]);
      setWbData([]);
      setWbMatches([]);
      setMessage({ type: 'error', text: `PDF files must be 50 MB or smaller. This file is ${(file.size / (1024 * 1024)).toFixed(1)} MB.` });
      return;
    }
    setProcessing(true);
    setMessage(null);
    setFileName(file.name);
    setSourceFile(file);
    setResults([]);
    setUnmatchedPages([]);
    setDuplicateIds([]);
    setPages([]);
    setSortedPages([]);
    setPdfBytes(null);
    setWbData([]);
    setWbMatches([]);
    let destroyPdfTask: (() => Promise<void>) | undefined;

    try {
      const arrayBuffer = await file.arrayBuffer();
      // Clone the buffer: pdfjs-dist transfers ownership (detaches) the original
      // so we keep a separate copy for pdf-lib to use during download
      setPdfBytes(arrayBuffer.slice(0));

      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      destroyPdfTask = () => loadingTask.destroy();
      const pdf = await loadingTask.promise;
      const numPages = pdf.numPages;
      if (numPages > MAX_PDF_PAGES) {
        await loadingTask.destroy();
        destroyPdfTask = undefined;
        throw new Error(`The PDF has ${numPages} pages. The current safe limit is ${MAX_PDF_PAGES.toLocaleString()} pages.`);
      }
      const extracted: ExtractedPage[] = [];

      // Native barcode detector (Chrome/Edge) for image-only label pages
      type BdResult = { rawValue: string; format: string };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const BdCtor = typeof window !== 'undefined' ? (window as any).BarcodeDetector : undefined;
      let detector: { detect: (src: CanvasImageSource) => Promise<BdResult[]> } | null = null;
      if (BdCtor) {
        try {
          detector = new BdCtor({
            formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'codabar', 'itf'],
          });
          setWbBarcodeSupported(true);
        } catch {
          detector = null;
          setWbBarcodeSupported(false);
        }
      } else {
        setWbBarcodeSupported(false);
      }

      const extractIdsFromString = (value: string): string[] => extractTrackingIds(value, selectedMarketplace);

      for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const text = textContent.items.map((item) => ('str' in item ? item.str : '')).join(' ');
        const codes = new Set<string>(extractIdsFromString(text));

        // Canvas render + barcode scan for image-based labels
        if (detector) {
          try {
            const scale = 2.0;
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            const ctx = canvas.getContext('2d');
            if (ctx) {
              await page.render({ canvas, canvasContext: ctx, viewport }).promise;
              const barcodes = await detector.detect(canvas);
              for (const b of barcodes) {
                const raw = (b.rawValue || '').trim();
                if (!raw) continue;
                for (const id of extractIdsFromString(raw)) {
                  codes.add(id);
                }
                // Keep an exact raw barcode too; user-pasted values are compared exactly.
                const digits = raw.replace(/[-\s]/g, '');
                if (/^\d{8,20}$/.test(digits)) {
                  const barcodeId = raw.includes('-') ? raw : digits;
                  codes.add(barcodeId);
                } else if (raw.length >= 8) {
                  codes.add(raw);
                }
              }
            }
          } catch {
            // barcode path optional
          }
        }

        const codeList = [...codes];
        extracted.push({
          id: i - 1,
          text: (text || codeList.join(' ')).substring(0, 240),
          codes: codeList,
        });
      }

      await loadingTask.destroy();
      destroyPdfTask = undefined;

      const totalMatches = extracted.reduce((sum, p) => sum + p.codes.length, 0);
      if (mode === 'wb') {
        // WB Advanced mode runs its own detection pipeline; Ozon text counts
        // are not meaningful here, so just confirm the PDF loaded.
        setMessage({ type: 'success', text: `PDF loaded: ${extracted.length} pages. Click “Scan & Sort” to run WB Advanced processing.` });
      } else if (totalMatches === 0) {
        setMessage({
          type: 'warning',
          text: detector
            ? 'No tracking IDs detected in text or barcodes. Try WB Advanced mode, or paste IDs and match by page order. Image labels without barcodes need external OCR.'
            : 'No tracking IDs in PDF text layer. This browser has no BarcodeDetector — use Chrome/Edge for barcode scan, or switch to WB Advanced after uploading.',
        });
      } else {
        setMessage({ type: 'success', text: `Extracted ${extracted.length} pages. Found ${totalMatches} total tracking IDs.` });
      }

      setPages(extracted);
      setSortedPages([]);
    } catch (e: unknown) {
      if (destroyPdfTask) {
        await destroyPdfTask().catch(() => undefined);
        destroyPdfTask = undefined;
      }
      console.error(e);
      setPages([]);
      setSortedPages([]);
      setPdfBytes(null);
      setSourceFile(null);
      setFileName('');
      setMessage({ type: 'error', text: `Failed to process PDF: ${e instanceof Error ? e.message : 'Unknown error'}` });
    } finally {
      setProcessing(false);
    }
  }, [mode, marketplace]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      setPages([]);
      setSortedPages([]);
      setPdfBytes(null);
      setSourceFile(null);
      setFileName('');
      setResults([]);
      setUnmatchedPages([]);
      setDuplicateIds([]);
      setWbData([]);
      setWbMatches([]);
      setMessage({ type: 'error', text: 'Choose a PDF label file.' });
      e.target.value = '';
      return;
    }
    void processPdfFile(file);
    e.target.value = '';
  };

  const handleSort = () => {
    if (!sequenceList.trim() || pages.length === 0) {
      setMessage({ type: 'error', text: 'Provide sequence IDs and upload a PDF' });
      return;
    }

    let targetIdsRaw = parseTrackingSequence(sequenceList);
    if (targetIdsRaw.length === 0) {
      setMessage({ type: 'error', text: 'No tracking IDs were found. Paste one ID per line or a copied spreadsheet column.' });
      return;
    }

    // Detect and track duplicates before deduplication
    const rawCountMap = new Map<string, number>();
    for (const tid of targetIdsRaw) {
      const key = normalizeTrackingId(tid);
      rawCountMap.set(key, (rawCountMap.get(key) || 0) + 1);
    }
    const foundDuplicates: { id: string; count: number }[] = [];
    rawCountMap.forEach((count, key) => {
      if (count > 1) {
        // find the original formatted ID
        const original = targetIdsRaw.find(t => normalizeTrackingId(t) === key) || key;
        foundDuplicates.push({ id: original, count });
      }
    });
    setDuplicateIds(foundDuplicates);

    // Remove duplicates from target list if enabled
    if (removeDuplicates) {
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const tid of targetIdsRaw) {
        const key = normalizeTrackingId(tid);
        if (!seen.has(key)) {
          seen.add(key);
          cleaned.push(tid);
        }
      }
      targetIdsRaw = cleaned;
    }

    const targetIds = targetIdsRaw.map(t => t.trim());

    const pageMap = matchTrackingSequence(targetIds, pages);
    const usedPages = new Set<number>(
      pageMap.filter((page): page is ExtractedPage => Boolean(page)).map((page) => page.id),
    );

    const sorted: ExtractedPage[] = [];
    const resultRows: ResultRow[] = [];
    const unmatchedRows: ResultRow[] = [];
    let matchedCount = 0;
    let newPageCounter = 1;

    if (mode === 'strict') {
      // Strict: only pages matching sequence
      for (let i = 0; i < targetIds.length; i++) {
        const tid = targetIds[i];
        const page = pageMap[i];
        if (page) {
          sorted.push(page);
          resultRows.push({
            status: '✅ INCLUDED',
            sequenceOrder: i + 1,
            id: tid,
            originalPage: page.id + 1,
            outputPage: newPageCounter++,
            notes: 'Found and sequenced',
          });
          matchedCount++;
        } else {
          unmatchedRows.push({
            status: '❌ MISSING',
            sequenceOrder: i + 1,
            id: tid,
            originalPage: 'N/A',
            outputPage: 'N/A',
            notes: 'ID not detected in PDF',
          });
        }
      }
    } else {
      // Smart: matched first, then extras
      for (let i = 0; i < targetIds.length; i++) {
        const tid = targetIds[i];
        const page = pageMap[i];
        if (page) {
          sorted.push(page);
          resultRows.push({
            status: '✅ MATCHED',
            sequenceOrder: i + 1,
            id: tid,
            originalPage: page.id + 1,
            outputPage: newPageCounter++,
            notes: 'Sequenced',
          });
          matchedCount++;
        } else {
          unmatchedRows.push({
            status: '❌ MISSING',
            sequenceOrder: i + 1,
            id: tid,
            originalPage: 'N/A',
            outputPage: 'N/A',
            notes: 'Not in PDF',
          });
        }
      }

      // Add extra pages not in sequence
      pages.forEach(page => {
        if (!usedPages.has(page.id)) {
          sorted.push(page);
          unmatchedRows.push({
            status: 'ℹ️ EXTRA',
            sequenceOrder: 0,
            id: page.codes[0] || `Page ${page.id + 1}`,
            originalPage: page.id + 1,
            outputPage: newPageCounter++,
            notes: 'Extra page in PDF',
          });
        }
      });
    }

    setSortedPages(sorted);
    setResults(resultRows);
    setUnmatchedPages(unmatchedRows);
    setMessage({ type: 'success', text: `Matched ${matchedCount} of ${targetIds.length} tracking IDs` });
  };

  /**
   * WB Advanced Multi-Criteria (v4.1) pipeline.
   * Ports the Python WBLabelProcessor flow: process the PDF for WB label data
   * (embedded text + optional native barcode/QR decode), parse the pasted
   * target list, then run confidence-scored multi-criteria matching.
   */
  const runWbAdvanced = useCallback(async () => {
    if (!pdfBytes) {
      setMessage({ type: 'error', text: 'Upload a labels PDF first.' });
      return;
    }
    if (!sequenceList.trim()) {
      setMessage({ type: 'error', text: 'Paste a target list (tracking #, phone+code, or order IDs).' });
      return;
    }
    setProcessing(true);
    setMessage(null);
    setWbData([]);
    setWbMatches([]);
    setResults([]);
    setUnmatchedPages([]);
    setDuplicateIds([]);
    setSortedPages([]);

    try {
      const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
      const labelData = await processPdf(pdfBytes.slice(0), doc, {
        detectBarcodes: true,
        onProgress: (done, total) => {
          setMessage({ type: 'success', text: `Processing WB labels… page ${done}/${total}` });
        },
      });
      setWbData(labelData);
      const barcodeSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window;
      setWbBarcodeSupported(barcodeSupported);

      // Dedupe targets (preserve first-seen order) when the option is enabled.
      const rawTargets = parseTargetList(sequenceList);
      const targetKey = (t: WBTarget) => {
        const parts = [t.tracking, t.phone, t.code, t.orderId].map((v) => v || '');
        return parts.some(Boolean) ? parts.join('|') : t.raw.trim().toLowerCase();
      };
      const seen = new Set<string>();
      const targets: WBTarget[] = [];
      const dups: { id: string; count: number }[] = [];
      const dupCount = new Map<string, number>();
      for (const t of rawTargets) {
        const key = targetKey(t);
        dupCount.set(key, (dupCount.get(key) || 0) + 1);
        if (removeDuplicates && seen.has(key)) continue;
        seen.add(key);
        targets.push(t);
      }
      dupCount.forEach((count, key) => {
        if (count > 1) {
          const orig = rawTargets.find((t) => targetKey(t) === key);
          dups.push({ id: orig?.raw || key, count });
        }
      });
      setDuplicateIds(dups);

      const matches: WBLabelMatch[] = matchTargets(targets, labelData);

      // Build sorted pages + result rows from matched order, then extras.
      const usedPages = new Set<number>();
      const sorted: ExtractedPage[] = [];
      const resultRows: ResultRow[] = [];
      const unmatched: ResultRow[] = [];
      const wbRows: WbMatchRow[] = [];
      let outCounter = 1;

      targets.forEach((t, idx) => {
        const m = matches.find((mm) => mm.targetIdx === idx);
        if (m) {
          usedPages.add(m.pageIdx);
          const ld = labelData[m.pageIdx];
          sorted.push({
            id: m.pageIdx,
            text: ld.rawText.substring(0, 200),
            codes: wbPageCodes(ld),
          });
          resultRows.push({
            status: '✅ MATCHED',
            sequenceOrder: idx + 1,
            id: t.raw,
            originalPage: m.pageIdx + 1,
            outputPage: outCounter++,
            notes: `${m.matchType} · ${Math.round(m.confidence * 100)}%`,
          });
          wbRows.push({
            sequenceOrder: idx + 1,
            targetRaw: t.raw,
            matchType: m.matchType,
            confidence: m.confidence,
            pageIdx: m.pageIdx,
            matchedFields: m.matchedFields,
          });
        } else {
          unmatched.push({
            status: '❌ MISSING',
            sequenceOrder: idx + 1,
            id: t.raw,
            originalPage: 'N/A',
            outputPage: 'N/A',
            notes: 'No label matched (≥50% confidence)',
          });
        }
      });

      // Append extra/unmatched PDF pages.
      labelData.forEach((ld) => {
        if (!usedPages.has(ld.pageIdx)) {
          sorted.push({
            id: ld.pageIdx,
            text: ld.rawText.substring(0, 200),
            codes: wbPageCodes(ld),
          });
          unmatched.push({
            status: 'ℹ️ EXTRA',
            sequenceOrder: 0,
            id: ld.trackingNumber || (ld.wbOrderId && ld.deliveryCode ? `${ld.wbOrderId} ${ld.deliveryCode}` : ld.wbOrderId || ld.barcodes[0]) || `Page ${ld.pageIdx + 1}`,
            originalPage: ld.pageIdx + 1,
            outputPage: outCounter++,
            notes: 'Extra page in PDF',
          });
        }
      });

      setSortedPages(sorted);
      setResults(resultRows);
      setUnmatchedPages(unmatched);
      setWbMatches(wbRows);

      const detectedTracking = labelData.filter((d) => d.trackingNumber).length;
      const detectedSticker = labelData.filter((d) => d.wbOrderId && d.deliveryCode).length;
      const ocrRanCount = labelData.filter((d) => d.ocrRan).length;
      const imageOnly = labelData.filter((d) => !d.rawText.trim() && !d.barcodes.length).length;
      const matchedCount = matches.length;
      const barcodeNote = !barcodeSupported ? ' No native barcode support in this browser — relied on embedded text only.' : '';
      const ocrNote = ocrRanCount ? ` OCR recovered ${ocrRanCount} image-only page(s).` : '';
      const imageOnlyNote = imageOnly
        ? ` ${imageOnly} page(s) still unreadable (no embedded text, barcode, or OCR text).`
        : '';
      setMessage({
        type: 'success',
        text: `Processed ${labelData.length} pages. Detected ${detectedSticker} sticker numbers and ${detectedTracking} tracking numbers. Matched ${matchedCount} of ${targets.length} targets.${barcodeNote}${ocrNote}${imageOnlyNote}`,
      });
    } catch (e: unknown) {
      console.error(e);
      setMessage({ type: 'error', text: `WB processing failed: ${e instanceof Error ? e.message : 'Unknown error'}` });
    } finally {
      setProcessing(false);
    }
  }, [pdfBytes, sequenceList, removeDuplicates]);

  const handleClear = () => {
    setPages([]);
    setSortedPages([]);
    setPdfBytes(null);
    setSourceFile(null);
    setSequenceList('');
    setFileName('');
    try {
      sessionStorage.removeItem('wms-sequence');
    } catch {
      // Storage may be disabled in private browsing; in-memory clear still works.
    }
    setMessage(null);
    setResults([]);
    setUnmatchedPages([]);
    setDuplicateIds([]);
    setWbData([]);
    setWbMatches([]);
    setWbBarcodeSupported(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const downloadSorted = async () => {
    if (!pdfBytes || sortedPages.length === 0) return;
    setDownloading(true);
    try {
      const originalPdf = await PDFDocument.load(pdfBytes);
      const newPdf = await PDFDocument.create();
      const pageIndices = sortedPages.map(p => p.id);
      const copiedPages = await newPdf.copyPages(originalPdf, pageIndices);
      copiedPages.forEach(page => newPdf.addPage(page));
      const pdfBytes2 = await newPdf.save();
      const blob = new Blob([new Uint8Array(pdfBytes2)], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sorted_${mode}_${new Date().toISOString().split('T')[0]}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setMessage({ type: 'success', text: `✅ Downloaded ${sortedPages.length} sorted pages as PDF!` });
    } catch (e: unknown) {
      console.error(e);
      setMessage({ type: 'error', text: `Download failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Pro PDF Label Sequencer</h1>
        <p className="text-sm text-text-secondary mt-1">Upload labels, extract tracking IDs, and sort pages</p>
      </div>

      {/* Mode Selector */}
      <div className="mb-4 glass-panel rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <ScanBarcode className="w-4 h-4 text-accent-sky" />
          <h3 className="text-sm font-semibold text-text-primary">Sequencing Mode</h3>
        </div>
        <div className="flex gap-2">
          {([
            { key: 'smart' as SequencerMode, label: '📋 Smart Sort', desc: 'Matched pages first, extras appended' },
            { key: 'strict' as SequencerMode, label: '🔒 Strict Rearrange', desc: 'Only pages matching your sequence' },
            { key: 'wb' as SequencerMode, label: '🏷️ WB Advanced v4.1', desc: 'Multi-criteria: tracking #/phone+code/order ID/QR + confidence' },
          ]).map((m) => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              className={`flex-1 p-3 rounded-md border text-left transition-all ${
                mode === m.key
                  ? 'bg-accent-sky/10 border-accent-sky/30'
                  : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]'
              }`}
            >
              <span className={`text-xs font-semibold ${mode === m.key ? 'text-accent-sky' : 'text-text-primary'}`}>{m.label}</span>
              <p className="text-[10px] text-text-secondary mt-0.5">{m.desc}</p>
            </button>
          ))}
        </div>
        {mode !== 'wb' && (
          <div className="mt-3 grid gap-2 sm:grid-cols-[180px_1fr] sm:items-center">
            <label htmlFor="pdf-marketplace" className="text-xs font-medium text-text-primary">Tracking ID format</label>
            <div>
              <select
                id="pdf-marketplace"
                value={marketplace}
                disabled={processing}
                onChange={(event) => {
                  const nextMarketplace = event.target.value as PdfMarketplace;
                  setMarketplace(nextMarketplace);
                  setMessage(null);
                  if (sourceFile) void processPdfFile(sourceFile, nextMarketplace);
                }}
                className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-text-primary disabled:opacity-50"
              >
                <option value="ozon">Ozon</option>
                <option value="yandex-market">Yandex Market</option>
                <option value="wildberries">Wildberries</option>
              </select>
              <p className="mt-1 text-[10px] text-text-secondary">Changing this re-scans the current PDF. IDs are matched exactly after ignoring spaces and hyphens.</p>
            </div>
          </div>
        )}
        {mode === 'strict' && (
          <div className="mt-2 p-2 bg-accent-yellow/10 border border-accent-yellow/20 rounded-md flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-accent-yellow flex-shrink-0 mt-0.5" />
            <p className="text-[10px] text-accent-yellow">Strict Rearrange is on by default: only matched pages are downloaded, in the exact order you pasted. Missing IDs are listed below and do not shift the remaining pages.</p>
          </div>
        )}
        {mode === 'wb' && (
          <div className="mt-2 p-2 bg-accent-sky/10 border border-accent-sky/20 rounded-md flex items-start gap-2">
            <Sparkles className="w-3.5 h-3.5 text-accent-sky flex-shrink-0 mt-0.5" />
            <p className="text-[10px] text-accent-sky">
              WB Advanced Mode: auto-detects WB tracking numbers, phone+code pairs, and order IDs from each pasted line, then matches labels by multiple criteria with confidence scores.
              {' '}
              {ocrSupported === null ? 'Checking OCR…' : ocrSupported ? 'Tesseract OCR ready for image-only labels.' : 'Tesseract OCR unavailable (add public/tessdata/eng.traineddata).'}
              {' | '}
              {wbBarcodeSupported === false ? 'No native barcode support — text layer only.' : 'Barcode/QR via BarcodeDetector when supported.'}
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Sequence List */}
        <div className="glass-panel rounded-lg p-4">
          <div className="flex items-center gap-2 mb-4">
            <ArrowUpDown className="w-4 h-4 text-accent-sky" />
            <h3 className="text-sm font-semibold text-text-primary">Target Sequence</h3>
          </div>
          <textarea
            value={sequenceList}
            aria-label="Paste tracking IDs in the required PDF page order"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setSequenceList(e.target.value)}
            className="w-full h-48 bg-transparent border border-white/[0.08] rounded-md p-3 text-xs text-text-primary font-mono resize-none focus:outline-none focus:border-accent-sky transition-colors"
            placeholder={mode === 'wb' ? 'Paste WB targets, one per line…\n• Sticker number: 5971104 2531 (order id + 4-digit code)\n• WB tracking: WBAERUGBACE0900JRM\n• Order ID: 123456789\n• Phone + Code: 5261288 1844' : marketplace === 'ozon' ? 'Paste IDs in the required order…\n123456789-1234-1\n987654321-4321-2' : 'Paste tracking IDs in the required order…\nOne ID per line, or copy a spreadsheet column'}
          />
          <div className="flex items-center gap-2 mt-3">
            <input
              type="checkbox"
              id="removeDups"
              checked={removeDuplicates}
              onChange={(e) => setRemoveDuplicates(e.target.checked)}
              className="w-3.5 h-3.5 accent-accent-sky"
            />
            <label htmlFor="removeDups" className="text-[10px] text-text-secondary">Remove repeated IDs (optional)</label>
          </div>
          <p className="text-[10px] text-text-secondary mt-2">
            {parseTrackingSequence(sequenceList).length} tracking IDs · pasted order is preserved
          </p>
        </div>

        {/* PDF Upload & Controls */}
        <div className="glass-panel rounded-lg p-4">
          <div className="flex items-center gap-2 mb-4">
            <FileText className="w-4 h-4 text-accent-sky" />
            <h3 className="text-sm font-semibold text-text-primary">Labels PDF</h3>
            {fileName && (
              <span className="ml-auto text-[10px] text-text-secondary truncate max-w-[100px]">{fileName}</span>
            )}
          </div>

          <div
            onClick={() => fileInputRef.current?.click()}
            className="h-32 border-2 border-dashed border-white/[0.08] rounded-md flex flex-col items-center justify-center cursor-pointer hover:border-accent-sky/30 transition-colors"
          >
            <Upload className="w-8 h-8 text-text-secondary mb-2" />
            <p className="text-xs text-text-secondary">{processing ? "Reading PDF…" : "Click to upload PDF"}</p>
            <p className="text-[10px] text-text-secondary/60 mt-1">PDF files only</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={handleFileUpload}
            className="hidden"
          />

          {(pages.length > 0 || (mode === 'wb' && wbData.length > 0)) && (
            <div className="mt-4 p-2 bg-white/[0.02] rounded-md">
              <p className="text-xs text-text-primary">{mode === 'wb' ? `${wbData.length} pages processed` : `${pages.length} pages extracted`}</p>
            </div>
          )}

          <div className="flex gap-2 mt-4">
            <motion.button
              onClick={mode === 'wb' ? runWbAdvanced : handleSort}
              disabled={processing || (mode === 'wb' ? !pdfBytes || !sequenceList.trim() : pages.length === 0 || !sequenceList.trim())}
              whileTap={{ scale: 0.98 }}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-accent-sky text-void font-semibold text-xs rounded-md hover:bg-accent-sky/90 transition-colors disabled:opacity-30 active:translate-y-[1px]"
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
              Scan & Sort
            </motion.button>
            <button
              onClick={handleClear}
              className="px-3 py-2.5 border border-white/[0.08] rounded-md text-text-secondary hover:text-accent-red hover:border-accent-red/30 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {message && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              className={`mt-3 p-2.5 rounded-md text-xs ${
                message.type === 'success'
                  ? 'bg-accent-green/10 border border-accent-green/20 text-accent-green'
                  : message.type === 'warning'
                    ? 'bg-accent-yellow/10 border border-accent-yellow/20 text-accent-yellow'
                    : 'bg-accent-red/10 border border-accent-red/20 text-accent-red'
              }`}
            >
              {message.text}
            </motion.div>
          )}
        </div>

        {/* Sorted Results */}
        <div className="glass-panel rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-accent-green" />
              <h3 className="text-sm font-semibold text-text-primary">Sorted Pages</h3>
              {sortedPages.length > 0 && (
                <span className="text-[10px] bg-accent-green/15 text-accent-green px-1.5 py-0.5 rounded-full">{sortedPages.length}</span>
              )}
            </div>
          </div>

          <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
            {sortedPages.length === 0 ? (
              <p className="text-xs text-text-secondary text-center py-8">
                {pages.length > 0 ? 'Click Scan & Sort to reorder pages' : 'Upload PDF and enter sequence IDs'}
              </p>
            ) : (
              sortedPages.map((page, i) => (
                <motion.div
                  key={`sorted-${page.id}-${i}`}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.02 }}
                  data-testid={`sorted-page-${i + 1}`}
                  className="flex items-center gap-2 p-2 bg-white/[0.02] border border-white/[0.06] rounded-md"
                >
                  <span className="text-[10px] text-accent-green/60 font-mono w-5 flex-shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-mono text-accent-sky truncate">{page.codes[0] || `Page ${page.id + 1}`}</p>
                    <p className="text-[9px] text-text-secondary truncate">{page.text.substring(0, 50)}</p>
                  </div>
                  <span className="text-[9px] text-text-secondary/40 flex-shrink-0">p.{page.id + 1}</span>
                </motion.div>
              ))
            )}
          </div>

          {/* Big Download Button */}
          <AnimatePresence>
            {sortedPages.length > 0 && (
              <motion.button
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                onClick={downloadSorted}
                disabled={downloading}
                className="w-full mt-4 flex items-center justify-center gap-2 py-3 rounded-lg font-bold text-sm transition-all disabled:opacity-50"
                style={{
                  background: downloading ? 'rgba(34,197,94,0.1)' : 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                  color: downloading ? '#22c55e' : '#000',
                  boxShadow: downloading ? 'none' : '0 0 20px rgba(34,197,94,0.3)'
                }}
                whileTap={{ scale: 0.97 }}
              >
                <Download className="w-4 h-4" />
                {downloading ? 'Generating PDF...' : `Download ${sortedPages.length} Sorted Pages`}
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── Summary Banners ── */}
      <AnimatePresence>
        {(results.length > 0 || unmatchedPages.length > 0) && (
          <div className="flex justify-end mb-2">
            <button
              type="button"
              onClick={() => setVerifyOpen(true)}
              className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md bg-white/[0.06] border border-white/10 text-text-primary hover:bg-white/[0.1]"
            >
              <Maximize2 className="w-3.5 h-3.5 text-accent-sky" />
              Full-screen discrepancy view
            </button>
          </div>
        )}

        {(results.length > 0 || unmatchedPages.length > 0 || duplicateIds.length > 0 || wbMatches.length > 0) && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mt-6 space-y-4">

            {/* Matched Results */}
            {results.length > 0 && (
              <div className="glass-panel rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] bg-accent-green/5">
                  <span className="text-xs font-bold text-accent-green">✅ Matched & Sequenced</span>
                  <span className="ml-auto text-[10px] bg-accent-green/15 text-accent-green px-2 py-0.5 rounded-full">{results.length} pages</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px]">
                    <thead>
                      <tr className="text-text-secondary uppercase tracking-widest border-b border-white/[0.04] bg-white/[0.01]">
                        <th className="text-left py-2 px-3">Seq#</th>
                        <th className="text-left py-2 px-3">Tracking ID</th>
                        <th className="text-center py-2 px-3">Original Page</th>
                        <th className="text-center py-2 px-3">Output Page</th>
                        <th className="text-left py-2 px-3">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((row, i) => (
                        <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                          <td className="py-1.5 px-3 text-text-secondary">{row.sequenceOrder}</td>
                          <td className="py-1.5 px-3 font-mono text-accent-sky">{row.id}</td>
                          <td className="py-1.5 px-3 text-center text-text-secondary">{row.originalPage}</td>
                          <td className="py-1.5 px-3 text-center text-accent-green font-semibold">{row.outputPage}</td>
                          <td className="py-1.5 px-3 text-text-secondary">{row.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* WB Advanced Match Details */}
            {wbMatches.length > 0 && (
              <div className="glass-panel rounded-lg overflow-hidden border border-accent-sky/20">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] bg-accent-sky/5">
                  <Sparkles className="w-3.5 h-3.5 text-accent-sky" />
                  <span className="text-xs font-bold text-accent-sky">🏷️ WB Advanced Match Details</span>
                  <span className="ml-auto text-[10px] bg-accent-sky/15 text-accent-sky px-2 py-0.5 rounded-full">{wbMatches.length} matched</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px]">
                    <thead>
                      <tr className="text-text-secondary uppercase tracking-widest border-b border-white/[0.04] bg-white/[0.01]">
                        <th className="text-left py-2 px-3">Seq#</th>
                        <th className="text-left py-2 px-3">Target</th>
                        <th className="text-center py-2 px-3">Page</th>
                        <th className="text-left py-2 px-3">Match Type</th>
                        <th className="text-center py-2 px-3">Confidence</th>
                        <th className="text-left py-2 px-3">Matched Fields</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wbMatches.map((row, i) => (
                        <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                          <td className="py-1.5 px-3 text-text-secondary">{row.sequenceOrder}</td>
                          <td className="py-1.5 px-3 font-mono text-accent-sky">{row.targetRaw}</td>
                          <td className="py-1.5 px-3 text-center text-text-secondary">{row.pageIdx + 1}</td>
                          <td className="py-1.5 px-3 text-accent-sky">{row.matchType}</td>
                          <td className="py-1.5 px-3 text-center">
                            <span className={`font-semibold ${row.confidence >= 0.9 ? 'text-accent-green' : row.confidence >= 0.7 ? 'text-accent-sky' : 'text-accent-yellow'}`}>
                              {Math.round(row.confidence * 100)}%
                            </span>
                          </td>
                          <td className="py-1.5 px-3 text-text-secondary">
                            {Object.entries(row.matchedFields).map(([k, v]) => (
                              <span key={k} className="inline-block bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-0.5 mr-1 mb-0.5 font-mono">
                                {k}: {v}
                              </span>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Missing / Unmatched */}
            {unmatchedPages.length > 0 && (
              <div className="glass-panel rounded-lg overflow-hidden border border-accent-red/20">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] bg-accent-red/5">
                  <span className="text-xs font-bold text-accent-red">❌ Missing / Unmatched IDs</span>
                  <span className="ml-auto text-[10px] bg-accent-red/15 text-accent-red px-2 py-0.5 rounded-full">{unmatchedPages.filter(r => r.status.includes('❌')).length} missing</span>
                  {unmatchedPages.some(r => r.status.includes('ℹ️')) && (
                    <span className="text-[10px] bg-white/10 text-text-secondary px-2 py-0.5 rounded-full">{unmatchedPages.filter(r => r.status.includes('ℹ️')).length} extra in PDF</span>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px]">
                    <thead>
                      <tr className="text-text-secondary uppercase tracking-widest border-b border-white/[0.04] bg-white/[0.01]">
                        <th className="text-left py-2 px-3">Status</th>
                        <th className="text-left py-2 px-3">Seq#</th>
                        <th className="text-left py-2 px-3">Tracking ID</th>
                        <th className="text-left py-2 px-3">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unmatchedPages.map((row, i) => (
                        <tr key={i} className={`border-b border-white/[0.03] ${row.status.includes('❌') ? 'bg-accent-red/[0.03]' : 'bg-white/[0.01]'}`}>
                          <td className="py-1.5 px-3">
                            <span className={`font-bold ${row.status.includes('❌') ? 'text-accent-red' : 'text-text-secondary'}`}>
                              {row.status.includes('❌') ? 'MISSING' : 'EXTRA'}
                            </span>
                          </td>
                          <td className="py-1.5 px-3 text-text-secondary">{row.sequenceOrder || '–'}</td>
                          <td className="py-1.5 px-3 font-mono text-text-primary">{row.id}</td>
                          <td className="py-1.5 px-3 text-text-secondary">{row.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Duplicate IDs */}
            {duplicateIds.length > 0 && (
              <div className="glass-panel rounded-lg overflow-hidden border border-accent-yellow/20">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] bg-accent-yellow/5">
                  <span className="text-xs font-bold text-accent-yellow">⚠️ Duplicate Tracking IDs Detected</span>
                  <span className="ml-auto text-[10px] bg-accent-yellow/15 text-accent-yellow px-2 py-0.5 rounded-full">{duplicateIds.length} IDs</span>
                </div>
                <div className="p-4">
                  <p className="text-[10px] text-text-secondary mb-3">These IDs appeared more than once in your pasted sequence. Only the first occurrence was used.</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {duplicateIds.map((dup, i) => (
                      <div key={i} className="flex items-center justify-between bg-accent-yellow/5 border border-accent-yellow/15 rounded-md px-2.5 py-2">
                        <span className="text-[10px] font-mono text-accent-yellow truncate">{dup.id}</span>
                        <span className="text-[9px] bg-accent-yellow/20 text-accent-yellow px-1.5 py-0.5 rounded ml-1 flex-shrink-0">×{dup.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

          </motion.div>
        )}
      </AnimatePresence>


      {/* ── Full-screen discrepancy verification ───────────────────────── */}
      <AnimatePresence>
        {verifyOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] bg-black flex flex-col"
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 shrink-0">
              <CheckCircle2 className="w-5 h-5 text-accent-sky" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-white">Discrepancy verification</h2>
                <p className="text-[11px] text-text-secondary truncate">
                  Target sequence vs PDF pages · matched / missing / extra
                </p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Filter className="w-3.5 h-3.5 text-text-secondary" />
                {(['all', 'match', 'missing', 'extra'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setVerifyFilter(f)}
                    className={`text-[10px] px-2 py-1 rounded border uppercase ${
                      verifyFilter === f
                        ? 'border-accent-sky/40 bg-accent-sky/15 text-accent-sky'
                        : 'border-white/10 text-text-secondary'
                    }`}
                  >
                    {f}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setVerifyOpen(false)}
                  className="p-2 rounded-md hover:bg-white/10 text-text-secondary"
                  title="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-2 px-4 py-3 border-b border-white/5">
              {[
                ['Matched', results.filter((r) => r.status.includes('MATCH') || r.status.includes('INCLUDED')).length, 'text-emerald-400'],
                ['Missing', unmatchedPages.filter((r) => r.status.includes('MISSING')).length, 'text-rose-400'],
                ['Extra', unmatchedPages.filter((r) => r.status.includes('EXTRA')).length, 'text-amber-400'],
                ['Sorted pages', sortedPages.length, 'text-sky-400'],
              ].map(([label, val, color]) => (
                <div key={String(label)} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
                  <div className={`text-xl font-semibold tabular-nums ${color}`}>{val}</div>
                </div>
              ))}
            </div>

            <div className="flex-1 min-h-0 overflow-auto p-4">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-black z-10">
                  <tr className="text-text-secondary uppercase tracking-wider border-b border-white/10">
                    <th className="text-left py-2 px-2">Status</th>
                    <th className="text-left py-2 px-2">#</th>
                    <th className="text-left py-2 px-2">Tracking / ID</th>
                    <th className="text-left py-2 px-2">Original page</th>
                    <th className="text-left py-2 px-2">Output page</th>
                    <th className="text-left py-2 px-2">Notes</th>
                    <th className="text-left py-2 px-2">Detected codes</th>
                  </tr>
                </thead>
                <tbody>
                  {[...results, ...unmatchedPages]
                    .filter((r) => {
                      if (verifyFilter === 'all') return true;
                      if (verifyFilter === 'match') return r.status.includes('MATCH') || r.status.includes('INCLUDED');
                      if (verifyFilter === 'missing') return r.status.includes('MISSING');
                      if (verifyFilter === 'extra') return r.status.includes('EXTRA');
                      return true;
                    })
                    .map((r, i) => {
                      const page =
                        typeof r.originalPage === 'number'
                          ? pages.find((pg) => pg.id === (r.originalPage as number) - 1)
                          : undefined;
                      return (
                        <tr
                          key={`${r.id}-${i}`}
                          className={`border-b border-white/[0.05] ${
                            r.status.includes('MISSING')
                              ? 'bg-rose-500/5'
                              : r.status.includes('EXTRA')
                                ? 'bg-amber-500/5'
                                : 'bg-emerald-500/[0.03]'
                          }`}
                        >
                          <td className="py-2 px-2 whitespace-nowrap">{r.status}</td>
                          <td className="py-2 px-2 tabular-nums text-text-secondary">{r.sequenceOrder || '–'}</td>
                          <td className="py-2 px-2 font-mono text-accent-sky">{r.id}</td>
                          <td className="py-2 px-2">{r.originalPage}</td>
                          <td className="py-2 px-2">{r.outputPage}</td>
                          <td className="py-2 px-2 text-text-secondary">{r.notes}</td>
                          <td className="py-2 px-2 font-mono text-[10px] text-text-secondary max-w-[14rem] truncate">
                            {page?.codes?.join(', ') || '—'}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>

            <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-t border-white/10">
              <p className="text-[11px] text-text-secondary">
                Compare target sequence against detected page codes. Edit targets and re-run Scan &amp; Sort if needed.
              </p>
              <button
                type="button"
                onClick={() => setVerifyOpen(false)}
                className="px-4 py-2 text-xs font-semibold rounded-md bg-accent-sky text-void"
              >
                Done
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Extracted Pages Preview removed */}
    </div>
  );
}
