import type { Order, InventoryItem } from './db';

export interface MappedOzonOrder {
  orderId: string;
  postingId?: string;
  skus: string[];
  skuQty: Record<string, number>;
  product?: string;
  status: string;
  trackingNumber?: string;
  city?: string;
  priority: 'normal' | 'high' | 'urgent';
  raw: Record<string, string>;
  sheetRowHash: string;
}

const COLUMN_ALIASES: Record<string, string[]> = {
  orderId: ['order id', 'orderid', 'order', 'ord', 'posting id', 'posting', 'номер отправления', 'отправление', 'shipment'],
  sku: ['sku', 'артикул', 'article', 'product sku', 'код товара'],
  product: ['product', 'name', 'title', 'товар', 'наименование', 'description'],
  quantity: ['qty', 'quantity', 'количество', 'кол-во', 'count', 'amount'],
  status: ['status', 'статус', 'state', 'warehouse status', 'fulfillment'],
  tracking: ['tracking', 'tracking number', 'трек', 'трекинг', 'track id', 'ozon id'],
  city: ['city', 'город', 'location', 'warehouse', 'склад'],
  priority: ['priority', 'приоритет', 'urgent'],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z\u0400-\u04FF0-9]+/g, ' ').trim();
}

function headerTokens(norm: string): string[] {
  return norm.split(/\s+/).filter(Boolean);
}

// Broad aliases such as bare "id" / "item" were removed above: they match
// unrelated columns (e.g. a line-item "id" or "item name") and can select the
// wrong spreadsheet column. Matching is whole-token based so a header like
// "order date" can no longer be claimed by the "order" alias.
function findColumn(headers: string[], field: keyof typeof COLUMN_ALIASES): string | null {
  const aliases = COLUMN_ALIASES[field];
  for (const h of headers) {
    const tokens = headerTokens(normalizeHeader(h));
    if (aliases.some((a) => tokens.includes(a))) return h;
  }
  return null;
}

function rowHash(row: Record<string, string>): string {
  return Object.entries(row).sort().map(([k, v]) => `${k}:${v}`).join('|');
}

function mapStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (/ship|отправ|deliver|готов/.test(s)) return 'ReadyToShip';
  if (/pick|сбор|pack|упак/.test(s)) return 'Picking';
  if (/cancel|отмен/.test(s)) return 'Cancelled';
  if (/return|возврат/.test(s)) return 'Returned';
  if (/qc|hold|блок/.test(s)) return 'QCHold';
  return 'Pending';
}

function mapPriority(raw: string, status: string): 'normal' | 'high' | 'urgent' {
  const p = raw.toLowerCase();
  if (/urgent|сроч|express/.test(p)) return 'urgent';
  if (/high|высок/.test(p) || status === 'Picking') return 'high';
  return 'normal';
}

export function detectColumnMapping(headers: string[]): Record<string, string | null> {
  return {
    orderId: findColumn(headers, 'orderId'),
    sku: findColumn(headers, 'sku'),
    product: findColumn(headers, 'product'),
    quantity: findColumn(headers, 'quantity'),
    status: findColumn(headers, 'status'),
    tracking: findColumn(headers, 'tracking'),
    city: findColumn(headers, 'city'),
    priority: findColumn(headers, 'priority'),
  };
}

export function mapRowsToOzonOrders(
  rows: Record<string, string>[],
  headers: string[],
  customMapping?: Partial<Record<string, string>>
): MappedOzonOrder[] {
  const mapping = { ...detectColumnMapping(headers), ...customMapping };
  const orderCol = mapping.orderId;
  const skuCol = mapping.sku;

  if (!orderCol && !skuCol) {
    throw new Error('Could not detect Order ID or SKU columns. Map columns manually or check sheet headers.');
  }

  // Group rows by order, keeping every row's hash so the group-level
  // sheetRowHash reflects changes to ANY line in the order (not just the
  // first row). This makes the sync's duplicate check catch later edits.
  const grouped = new Map<string, { order: MappedOzonOrder; rowHashes: string[] }>();

  for (const row of rows) {
    const orderId = (orderCol ? row[orderCol] : '') || (skuCol ? `OZON-${row[skuCol]}` : '');
    if (!orderId?.trim()) continue;

    const key = orderId.trim().toUpperCase();
    const sku = skuCol ? row[skuCol]?.trim() : '';
    const qty = parseQuantity(mapping.quantity ? row[mapping.quantity] : undefined);
    const statusRaw = mapping.status ? row[mapping.status] : '';
    const status = mapStatus(statusRaw);
    const priority = mapPriority(mapping.priority ? row[mapping.priority] || '' : '', status);

    if (!grouped.has(key)) {
      grouped.set(key, {
        order: {
          orderId: key,
          postingId: key,
          skus: [],
          skuQty: {},
          product: mapping.product ? row[mapping.product] : undefined,
          status,
          trackingNumber: mapping.tracking ? row[mapping.tracking] : undefined,
          city: mapping.city ? row[mapping.city] : undefined,
          priority,
          raw: row,
          sheetRowHash: '', // computed once all rows for the group are seen
        },
        rowHashes: [],
      });
    }

    const group = grouped.get(key)!;
    group.rowHashes.push(rowHash(row));

    const order = group.order;
    if (sku) {
      order.skus.push(sku);
      order.skuQty[sku] = (order.skuQty[sku] || 0) + qty;
    }
    if (mapping.tracking && row[mapping.tracking]) order.trackingNumber = row[mapping.tracking];
    if (mapping.status) order.status = mapStatus(row[mapping.status] || statusRaw);
  }

  return Array.from(grouped.values()).map(({ order, rowHashes }) => ({
    ...order,
    skus: [...new Set(order.skus)],
    // Group-level hash: any change to any line of the order changes the hash,
    // so the sync duplicate check will not miss later edits.
    sheetRowHash: hashString(rowHashes.slice().sort().join('||')),
  }));
}

/** Parse a quantity cell, rejecting negatives / zero / NaN and capping absurd values. */
const MAX_QTY = 10_000;
function parseQuantity(raw: string | undefined): number {
  const parsed = raw == null ? NaN : parseInt(String(raw).trim() || '1', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1; // negative / zero / non-numeric -> minimum
  return Math.min(parsed, MAX_QTY); // cap excessive values
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(8, '0');
}

export function toDbOrder(mapped: MappedOzonOrder): Omit<Order, 'id'> {
  const skuList = Object.entries(mapped.skuQty)
    .flatMap(([sku, qty]) => Array(qty).fill(sku))
    .join(', ');

  return {
    orderId: mapped.orderId,
    status: mapped.status as Order['status'],
    requiredSkus: skuList || mapped.skus.join(', '),
    priority: mapped.priority,
    carrier: 'Ozon',
    trackingNumber: mapped.trackingNumber,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function toInventoryUpdates(mapped: MappedOzonOrder[]): Partial<InventoryItem>[] {
  const skuProducts = new Map<string, string>();
  for (const o of mapped) {
    if (o.product && o.skus[0]) skuProducts.set(o.skus[0], o.product);
  }
  return Array.from(skuProducts.entries()).map(([sku, product]) => ({
    sku,
    product,
    stock: 0,
    location: 'SHEET-IMPORT',
    updatedAt: new Date().toISOString(),
  }));
}