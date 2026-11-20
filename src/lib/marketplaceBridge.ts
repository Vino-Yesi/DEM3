import Papa from 'papaparse';
import { db, type InventoryItem, type Order } from '@/lib/db';

export type MarketplaceId = 'ozon' | 'yandex-market' | 'wildberries';

export const MARKETPLACES: { id: MarketplaceId; label: string; shortLabel: string }[] = [
  { id: 'ozon', label: 'Ozon', shortLabel: 'OZON' },
  { id: 'yandex-market', label: 'Yandex Market', shortLabel: 'YANDEX' },
  { id: 'wildberries', label: 'Wildberries', shortLabel: 'WB' },
];

export interface MarketplaceImportResult {
  imported: number;
  updated: number;
  skipped: number;
  invalid: number;
  totalRows: number;
}

export interface MarketplaceOrderData {
  /** Provider's numeric/API order id when it differs from the public order/posting number. */
  providerOrderId?: string;
  /** Wildberries supply id after its assembly orders have been assigned to a supply. */
  wbSupplyId?: string;
}

export interface MarketplaceSkuMapping {
  ozonOfferId?: string;
  yandexSku?: string;
  wildberriesArticle?: string;
  /** WB catalog size identifier (chrtId), not the barcode or seller article. */
  wildberriesChrtId?: string;
}

const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5_000;
const MAX_EXTERNAL_ID_LENGTH = 160;
const MAX_SKU_COUNT = 200;

const ORDER_ID_FIELDS: Record<MarketplaceId, string[]> = {
  ozon: ['posting_number', 'postingNumber', 'posting_id', 'postingId', 'order_number', 'orderNumber', 'order_id', 'orderId', 'shipment_id', 'shipmentId', 'id'],
  'yandex-market': ['orderId', 'order_id', 'orderNumber', 'order_number', 'shipmentId', 'shipment_id', 'id'],
  // WB API order id is the numeric id required by its supply API. srid/rid are
  // retained as file-import fallbacks for older portal exports.
  wildberries: ['id', 'orderId', 'order_id', 'srid', 'rid', 'orderNumber', 'order_number', 'gNumber'],
};

const SKU_FIELDS: Record<MarketplaceId, string[]> = {
  ozon: ['localSku', 'offer_id', 'offerId', 'shop_sku', 'shopSku', 'sku', 'article', 'vendorCode', 'vendor_code', 'barcode', 'barcodeValue'],
  'yandex-market': ['localSku', 'offerId', 'offer_id', 'shopSku', 'shop_sku', 'sku', 'article', 'vendorCode', 'vendor_code', 'barcode'],
  // WB article/supplierArticle is the seller SKU; nmId is only a catalog id.
  wildberries: ['localSku', 'article', 'supplierArticle', 'supplier_article', 'vendorCode', 'vendor_code', 'offer_id', 'offerId', 'sku', 'nmId', 'nm_id', 'barcode'],
};
const ITEM_LIST_FIELDS = ['items', 'products', 'orderItems', 'order_items', 'orderLines', 'order_lines', 'lines', 'positions'];
const QUANTITY_FIELDS = ['quantity', 'count', 'qty', 'amount', 'units', 'totalQuantity'];
const STATUS_FIELDS = ['status', 'orderStatus', 'order_status', 'postingStatus', 'posting_status', 'supplierStatus', 'wbStatus', 'state', 'shipmentStatus'];
const TRACKING_FIELDS = ['trackingNumber', 'tracking_number', 'trackingId', 'tracking_id', 'trackNumber', 'track_number', 'shipmentTrackingId', 'shipment_tracking_id', 'trackCode', 'track_code', 'track'];
const CARRIER_FIELDS = ['carrier', 'deliveryService', 'delivery_service', 'deliveryCompany', 'delivery_company', 'courier', 'provider'];
const PRIORITY_FIELDS = ['priority', 'urgency', 'isUrgent'];
const CREATED_FIELDS = ['createdAt', 'created_at', 'creationDate', 'creation_date', 'orderDate', 'order_date', 'date'];
const SKU_LIST_FIELDS = ['requiredSkus', 'required_skus', 'skuList', 'sku_list', 'articles'];

function normalizedKey(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getRecordValue(record: Record<string, unknown>, aliases: string[]): unknown {
  const wanted = new Set(aliases.map(normalizedKey));
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(normalizedKey(key)) && value !== null && value !== undefined && value !== '') return value;
  }
  return undefined;
}

function safeString(value: unknown, maxLength = 240): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\p{Cc}/gu, ' ').trim().slice(0, maxLength);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findRowArray(value: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (depth >= 5) return null;
  const object = objectRecord(value);
  if (!object) return null;
  const preferred = ['orders', 'postings', 'shipments', 'rows', 'items', 'data', 'result', 'results', 'ordersList'];
  for (const wanted of preferred) {
    const entry = Object.entries(object).find(([key]) => normalizedKey(key) === normalizedKey(wanted));
    if (entry) {
      const found = findRowArray(entry[1], depth + 1);
      if (found) return found;
    }
  }
  for (const entry of Object.values(object)) {
    const found = findRowArray(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseFileRows(text: string, fileName: string): Record<string, unknown>[] {
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error('The JSON file could not be read. Check that it is valid JSON.');
    }
    const rows = findRowArray(parsed) ?? [parsed];
    if (rows.length > MAX_IMPORT_ROWS) throw new Error(`This file has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows. Split it into smaller files.`);
    return rows.map(objectRecord).filter((row): row is Record<string, unknown> => row !== null);
  }

  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    delimiter: extension === 'tsv' ? '\t' : '',
    transformHeader: (header) => header.trim(),
  });
  if (result.errors.length && !result.data.length) {
    throw new Error('The CSV/TSV file could not be read. Check its header row and separators.');
  }
  if (result.data.length > MAX_IMPORT_ROWS) throw new Error(`This file has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows. Split it into smaller files.`);
  return result.data.filter((row) => Object.values(row).some((value) => safeString(value)));
}

function parseQuantity(value: unknown): number {
  const number = Number.parseInt(safeString(value), 10);
  return Number.isFinite(number) ? Math.max(1, Math.min(number, MAX_SKU_COUNT)) : 1;
}

function mapOrderStatus(value: unknown): Order['status'] {
  const status = safeString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!status) return 'Pending';
  if (/(cancel|canceled|cancelled|is_cancel|отмен|отказ)/i.test(status)) return 'Cancelled';
  if (/(return|refund|возврат)/i.test(status)) return 'Returned';
  if (/(awaiting_deliver|ready_to_ship|ready_for_shipment|packed|packaged|упакован|готов.*отправ)/i.test(status)) return 'ReadyToShip';
  if (/(pick|assembly|confirm|sorting|сборк)/i.test(status)) return 'Picking';
  if (/(shipped|dispatch|complete|completed|delivering|in_transit|delivered|delivery|доставлен|передан.*курьер|отправлен)/i.test(status)) return 'Shipped';
  if (/(quality|hold|problem|exception|провер)/i.test(status)) return 'QCHold';
  return 'Pending';
}

function parseCreatedAt(value: unknown, fallback: string): string {
  const text = safeString(value, 80);
  if (!text) return fallback;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function extractSkuCounts(record: Record<string, unknown>, marketplace: MarketplaceId): Map<string, number> {
  const counts = new Map<string, number>();
  const addSku = (value: unknown, quantityValue?: unknown) => {
    const sku = safeString(value, 100);
    if (!sku) return;
    const count = parseQuantity(quantityValue);
    counts.set(sku, Math.min(MAX_SKU_COUNT, (counts.get(sku) || 0) + count));
  };

  const listedItems = getRecordValue(record, ITEM_LIST_FIELDS);
  if (Array.isArray(listedItems)) {
    for (const item of listedItems) {
      const itemRecord = objectRecord(item);
      if (itemRecord) addSku(getRecordValue(itemRecord, SKU_FIELDS[marketplace]), getRecordValue(itemRecord, QUANTITY_FIELDS));
      else if (typeof item === 'string' || typeof item === 'number') addSku(item);
    }
  }

  addSku(getRecordValue(record, SKU_FIELDS[marketplace]), getRecordValue(record, QUANTITY_FIELDS));
  const skuList = safeString(getRecordValue(record, SKU_LIST_FIELDS), 4_000);
  for (const sku of skuList.split(/[,;|\n]+/).map((value) => value.trim()).filter(Boolean)) addSku(sku);
  return counts;
}

function parseMarketplaceData(row: Record<string, unknown>, marketplace: MarketplaceId): MarketplaceOrderData {
  const explicit = objectRecord(row.__marketplace) || objectRecord(row.marketplaceData) || {};
  const rawProviderId = explicit.providerOrderId ?? explicit.orderId ?? (marketplace === 'wildberries' ? row.id : undefined);
  const providerOrderId = safeString(rawProviderId, MAX_EXTERNAL_ID_LENGTH);
  const wbSupplyId = marketplace === 'wildberries' ? safeString(explicit.wbSupplyId, 128) : '';
  return {
    ...(providerOrderId ? { providerOrderId } : {}),
    ...(wbSupplyId ? { wbSupplyId } : {}),
  };
}

export function readMarketplaceOrderData(serialized: string | undefined): MarketplaceOrderData {
  if (!serialized) return {};
  try {
    const parsed = objectRecord(JSON.parse(serialized) as unknown);
    if (!parsed) return {};
    const providerOrderId = safeString(parsed.providerOrderId, MAX_EXTERNAL_ID_LENGTH);
    const wbSupplyId = safeString(parsed.wbSupplyId, 128);
    return {
      ...(providerOrderId ? { providerOrderId } : {}),
      ...(wbSupplyId ? { wbSupplyId } : {}),
    };
  } catch {
    return {};
  }
}

export function readMarketplaceSkuMapping(serialized: string | undefined): MarketplaceSkuMapping {
  if (!serialized) return {};
  try {
    const parsed = objectRecord(JSON.parse(serialized) as unknown);
    if (!parsed) return {};
    const ozonOfferId = safeString(parsed.ozonOfferId, 100);
    const yandexSku = safeString(parsed.yandexSku, 100);
    const wildberriesArticle = safeString(parsed.wildberriesArticle, 100);
    const chrtId = safeString(parsed.wildberriesChrtId, 32);
    const wildberriesChrtId = /^\d{1,20}$/.test(chrtId) ? chrtId : '';
    return {
      ...(ozonOfferId ? { ozonOfferId } : {}),
      ...(yandexSku ? { yandexSku } : {}),
      ...(wildberriesArticle ? { wildberriesArticle } : {}),
      ...(wildberriesChrtId ? { wildberriesChrtId } : {}),
    };
  } catch {
    return {};
  }
}

function applyInventorySkuMappings(
  rows: Record<string, unknown>[],
  marketplace: MarketplaceId,
  inventory: InventoryItem[],
): Record<string, unknown>[] {
  const sourceField: Record<MarketplaceId, keyof MarketplaceSkuMapping> = {
    ozon: 'ozonOfferId',
    'yandex-market': 'yandexSku',
    wildberries: 'wildberriesArticle',
  };
  const providerSkuToLocalSku = new Map<string, string>();
  for (const item of inventory) {
    const providerSku = readMarketplaceSkuMapping(item.marketplaceData)[sourceField[marketplace]];
    if (providerSku && !providerSkuToLocalSku.has(providerSku.toLowerCase())) {
      providerSkuToLocalSku.set(providerSku.toLowerCase(), item.sku);
    }
  }
  if (!providerSkuToLocalSku.size) return rows;

  const mapItem = (value: unknown): unknown => {
    const record = objectRecord(value);
    if (!record) return value;
    const providerSku = safeString(getRecordValue(record, SKU_FIELDS[marketplace]), 100);
    const localSku = providerSkuToLocalSku.get(providerSku.toLowerCase());
    return localSku ? { ...record, localSku } : record;
  };

  return rows.map((row) => {
    const next = { ...row };
    const topLevelSku = safeString(getRecordValue(row, SKU_FIELDS[marketplace]), 100);
    const localSku = providerSkuToLocalSku.get(topLevelSku.toLowerCase());
    if (localSku) next.localSku = localSku;

    const itemKey = Object.keys(row).find((key) =>
      ITEM_LIST_FIELDS.some((field) => normalizedKey(field) === normalizedKey(key)) && Array.isArray(row[key]),
    );
    if (itemKey && Array.isArray(row[itemKey])) next[itemKey] = (row[itemKey] as unknown[]).map(mapItem);
    return next;
  });
}

function mergeMarketplaceData(current: string | undefined, incoming: MarketplaceOrderData): string | undefined {
  const previous = readMarketplaceOrderData(current);
  const merged = {
    ...(previous.providerOrderId || incoming.providerOrderId ? { providerOrderId: incoming.providerOrderId || previous.providerOrderId } : {}),
    ...(previous.wbSupplyId || incoming.wbSupplyId ? { wbSupplyId: incoming.wbSupplyId || previous.wbSupplyId } : {}),
  };
  return Object.keys(merged).length ? JSON.stringify(merged) : current;
}

interface GroupedOrder {
  externalId: string;
  status: Order['status'];
  statusRank: number;
  skuCounts: Map<string, number>;
  trackingNumber: string;
  carrier: string;
  priority: Order['priority'];
  createdAt: string;
  marketplaceData: MarketplaceOrderData;
}

const STATUS_RANK: Record<Order['status'], number> = {
  Pending: 0,
  QCHold: 0,
  CrossDock: 1,
  Picking: 2,
  Packed: 3,
  ReadyToShip: 4,
  Shipped: 5,
  Returned: 6,
  Cancelled: 6,
};

function parsePriority(value: unknown): Order['priority'] {
  const text = safeString(value).toLowerCase();
  if (/urgent|express|сроч/i.test(text)) return 'urgent';
  if (/high|повыш/i.test(text)) return 'high';
  return 'normal';
}

function normalizeRows(rows: Record<string, unknown>[], marketplace: MarketplaceId): { orders: GroupedOrder[]; invalid: number } {
  const grouped = new Map<string, GroupedOrder>();
  let invalid = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const externalId = safeString(getRecordValue(row, ORDER_ID_FIELDS[marketplace]), MAX_EXTERNAL_ID_LENGTH);
    if (!externalId) {
      invalid++;
      continue;
    }
    const isCancelled = row.isCancel === true || row.is_cancel === true;
    const status = isCancelled ? 'Cancelled' : mapOrderStatus(getRecordValue(row, STATUS_FIELDS));
    const itemCounts = extractSkuCounts(row, marketplace);
    const marketplaceData = parseMarketplaceData(row, marketplace);
    const existing = grouped.get(externalId);
    if (existing) {
      for (const [sku, count] of itemCounts) existing.skuCounts.set(sku, Math.min(MAX_SKU_COUNT, (existing.skuCounts.get(sku) || 0) + count));
      if (STATUS_RANK[status] > existing.statusRank) {
        existing.status = status;
        existing.statusRank = STATUS_RANK[status];
      }
      existing.trackingNumber ||= safeString(getRecordValue(row, TRACKING_FIELDS), 120);
      existing.carrier ||= safeString(getRecordValue(row, CARRIER_FIELDS), 80);
      existing.marketplaceData = {
        providerOrderId: marketplaceData.providerOrderId || existing.marketplaceData.providerOrderId,
        wbSupplyId: marketplaceData.wbSupplyId || existing.marketplaceData.wbSupplyId,
      };
      continue;
    }
    grouped.set(externalId, {
      externalId,
      status,
      statusRank: STATUS_RANK[status],
      skuCounts: itemCounts,
      trackingNumber: safeString(getRecordValue(row, TRACKING_FIELDS), 120),
      carrier: safeString(getRecordValue(row, CARRIER_FIELDS), 80),
      priority: parsePriority(getRecordValue(row, PRIORITY_FIELDS)),
      createdAt: parseCreatedAt(getRecordValue(row, CREATED_FIELDS), now),
      marketplaceData,
    });
  }
  return { orders: [...grouped.values()], invalid };
}

function mergeStatus(current: Order['status'], incoming: Order['status']): Order['status'] {
  if (current === 'Shipped' || current === 'Returned' || current === 'Cancelled') return current;
  if (incoming === 'Returned' || incoming === 'Cancelled') return incoming;
  return STATUS_RANK[incoming] >= STATUS_RANK[current] ? incoming : current;
}

async function importRows(marketplace: MarketplaceId, rows: Record<string, unknown>[]): Promise<MarketplaceImportResult> {
  if (rows.length === 0) throw new Error('No order rows were found.');
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`This import has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows. Split it into smaller files.`);
  const inventory = await db.inventory.toArray();
  const mappedRows = applyInventorySkuMappings(rows, marketplace, inventory);
  const { orders: normalized, invalid } = normalizeRows(mappedRows, marketplace);
  if (normalized.length === 0) throw new Error('No valid order IDs were found. Check the marketplace export headers.');

  let imported = 0;
  let updated = 0;
  const now = new Date().toISOString();
  const existingOrders = await db.orders.toArray();
  const byMarketplaceId = new Map<string, Order>();
  const byOrderId = new Map<string, Order>();
  for (const order of existingOrders) {
    byOrderId.set(order.orderId.toUpperCase(), order);
    if (order.sourceMarketplace === marketplace && order.marketplaceOrderId) {
      byMarketplaceId.set(order.marketplaceOrderId.toUpperCase(), order);
    }
  }

  await db.transaction('rw', db.orders, async () => {
    for (const incoming of normalized) {
      const existing = byMarketplaceId.get(incoming.externalId.toUpperCase()) || byOrderId.get(incoming.externalId.toUpperCase());
      const requiredSkus = [...incoming.skuCounts.entries()]
        .flatMap(([sku, quantity]) => Array.from({ length: quantity }, () => sku))
        .join(', ');

      if (existing?.id !== undefined) {
        const marketplaceData = mergeMarketplaceData(existing.marketplaceData, incoming.marketplaceData);
        const nextStatus = mergeStatus(existing.status, incoming.status);
        const updates: Partial<Order> = {
          sourceMarketplace: marketplace,
          marketplaceOrderId: incoming.externalId,
          requiredSkus: requiredSkus || existing.requiredSkus,
          status: nextStatus,
          priority: incoming.priority === 'normal' ? existing.priority : incoming.priority,
          carrier: incoming.carrier || existing.carrier,
          trackingNumber: incoming.trackingNumber || existing.trackingNumber,
          updatedAt: now,
        };
        if (marketplaceData) updates.marketplaceData = marketplaceData;
        await db.orders.update(existing.id, updates);
        Object.assign(existing, updates);
        byMarketplaceId.set(incoming.externalId.toUpperCase(), existing);
        updated++;
        continue;
      }

      const internalOrderId = `${marketplace.toUpperCase()}:${incoming.externalId}`;
      const status = incoming.skuCounts.size === 0 && incoming.status === 'Pending' ? 'QCHold' : incoming.status;
      const newOrder: Order = {
        orderId: internalOrderId,
        sourceMarketplace: marketplace,
        marketplaceOrderId: incoming.externalId,
        status,
        requiredSkus,
        priority: incoming.priority,
        createdAt: incoming.createdAt,
        updatedAt: now,
        carrier: incoming.carrier || undefined,
        trackingNumber: incoming.trackingNumber || undefined,
        ...(Object.keys(incoming.marketplaceData).length ? { marketplaceData: JSON.stringify(incoming.marketplaceData) } : {}),
      };
      const id = await db.orders.add(newOrder);
      newOrder.id = id;
      existingOrders.push(newOrder);
      byMarketplaceId.set(incoming.externalId.toUpperCase(), newOrder);
      byOrderId.set(internalOrderId.toUpperCase(), newOrder);
      imported++;
    }
  });

  return { imported, updated, skipped: invalid, invalid, totalRows: rows.length };
}

/** Import a marketplace CSV/TSV/JSON export into local OMS orders, idempotently. */
export async function importMarketplaceOrders(marketplace: MarketplaceId, file: File): Promise<MarketplaceImportResult> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error(`Files must be 15 MB or smaller. This file is ${(file.size / (1024 * 1024)).toFixed(1)} MB.`);
  const extension = file.name.toLowerCase().split('.').pop();
  if (!['csv', 'tsv', 'txt', 'json'].includes(extension || '')) throw new Error('Choose a CSV, TSV, TXT or JSON marketplace export.');
  return importRows(marketplace, parseFileRows(await file.text(), file.name));
}

/** Import server-normalized marketplace API records using the same idempotent OMS path. */
export async function importMarketplaceRows(marketplace: MarketplaceId, inputRows: unknown[]): Promise<MarketplaceImportResult> {
  if (inputRows.length > MAX_IMPORT_ROWS) throw new Error(`This import has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows. Narrow the marketplace date range.`);
  const rows = inputRows.map(objectRecord).filter((row): row is Record<string, unknown> => row !== null);
  return importRows(marketplace, rows);
}

/**
 * Creates a local handoff manifest only. It is not a provider API request or
 * a guarantee that the JSON matches the marketplace portal's bulk-import format.
 */
export async function createMarketplaceTrackingExport(marketplace: MarketplaceId): Promise<{ fileName: string; content: string; count: number }> {
  const allOrders = await db.orders.toArray();
  const orders = allOrders.filter((order) =>
    order.sourceMarketplace === marketplace &&
    (order.status === 'Shipped' || order.status === 'ReadyToShip') &&
    Boolean(order.trackingNumber) &&
    !order.trackingNumber?.startsWith('LOCAL-DEMO-'),
  );
  const records = orders.map((order) => ({
    marketplaceOrderId: order.marketplaceOrderId || order.orderId,
    wmsOrderId: order.orderId,
    status: order.status,
    trackingNumber: order.trackingNumber,
    carrier: order.carrier,
    service: order.service,
    updatedAt: order.updatedAt,
  }));

  return {
    fileName: `${marketplace}-tracking-manifest-${new Date().toISOString().slice(0, 10)}.json`,
    content: JSON.stringify({ marketplace, exportedAt: new Date().toISOString(), records }, null, 2),
    count: records.length,
  };
}
