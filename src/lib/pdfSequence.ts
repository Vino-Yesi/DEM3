export type PdfMarketplace = 'ozon' | 'yandex-market' | 'wildberries';

export interface SequencedPdfPage {
  id: number;
  codes: string[];
}

/** Accept a pasted column, CSV/TSV selection, or one ID per line. */
export function parseTrackingSequence(text: string): string[] {
  return text
    .split(/[\r\n\t,;]+/)
    .map((value) => value.trim().replace(/^(["'])(.*)\1$/, '$2').trim())
    .filter(Boolean);
}

/** Normalize harmless display separators; preserve letters and leading zeroes. */
export function normalizeTrackingId(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase().replace(/[\s-]+/g, '');
}

/**
 * Extract likely shipment IDs from a PDF text layer. Page matching below is
 * exact after normalization so an SKU or a short numeric substring cannot
 * accidentally steal a tracking ID's page.
 */
export function extractTrackingIds(text: string, marketplace: PdfMarketplace): string[] {
  const patterns: RegExp[] = [];
  if (marketplace === 'ozon') {
    // Ozon labels may show posting IDs with hyphens, spaces, or no separators.
    patterns.push(/\b\d{6,15}(?:[-\s]+\d{3,5})[-\s]+\d{1,2}\b/g, /\b\d{8,15}\b/g);
  } else if (marketplace === 'yandex-market') {
    patterns.push(/\b[A-Z0-9][A-Z0-9._/-]{6,30}[A-Z0-9]\b/gi, /\b\d{8,20}\b/g);
  } else {
    patterns.push(/\bWB[A-Z0-9]{10,24}\b/gi, /\b\d{9,15}\b/g, /\b[A-Z0-9][A-Z0-9._/-]{8,30}[A-Z0-9]\b/gi);
  }

  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0]?.trim();
      if (value) found.add(value);
    }
  }
  return [...found];
}

/** Match each pasted ID to one unused PDF page, in the pasted order. */
export function matchTrackingSequence<T extends SequencedPdfPage>(
  trackingIds: string[],
  pages: T[],
): (T | undefined)[] {
  const byCode = new Map<string, T[]>();
  for (const page of pages) {
    for (const code of page.codes) {
      const normalized = normalizeTrackingId(code);
      if (!normalized) continue;
      const candidates = byCode.get(normalized) || [];
      candidates.push(page);
      byCode.set(normalized, candidates);
    }
  }

  const usedPageIds = new Set<number>();
  return trackingIds.map((trackingId) => {
    const target = normalizeTrackingId(trackingId);
    if (!target) return undefined;
    const page = (byCode.get(target) || []).find((candidate) => !usedPageIds.has(candidate.id));
    if (page) usedPageIds.add(page.id);
    return page;
  });
}
