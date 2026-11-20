import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ORDERS = 100;
const MAX_INVENTORY = 1_000;
const MAX_API_ORDERS = 5_000;
const OZONE_API = 'https://api-seller.ozon.ru';
const YANDEX_API = 'https://api.partner.market.yandex.ru';
const WILDBERRIES_API = 'https://marketplace-api.wildberries.ru';

const CONFIG_REQUIREMENTS = {
  ozon: {
    orders: ['OZON_CLIENT_ID', 'OZON_API_KEY'],
    stock: ['OZON_CLIENT_ID', 'OZON_API_KEY', 'OZON_WAREHOUSE_ID'],
    dispatch: ['OZON_CLIENT_ID', 'OZON_API_KEY'],
  },
  'yandex-market': {
    orders: ['YANDEX_API_KEY', 'YANDEX_BUSINESS_ID', 'YANDEX_CAMPAIGN_ID'],
    stock: ['YANDEX_API_KEY', 'YANDEX_BUSINESS_ID', 'YANDEX_PARTNER_WAREHOUSE_ID'],
    dispatch: ['YANDEX_API_KEY', 'YANDEX_CAMPAIGN_ID', 'YANDEX_DELIVERY_SERVICE_ID'],
  },
  wildberries: {
    orders: ['WILDBERRIES_API_KEY'],
    stock: ['WILDBERRIES_API_KEY', 'WILDBERRIES_WAREHOUSE_ID'],
    dispatch: ['WILDBERRIES_API_KEY'],
  },
};

class UpstreamError extends Error {
  constructor(provider, status = 502) {
    super(`${provider} API request failed`);
    this.provider = provider;
    this.status = status;
  }
}

function jsonResponse(statusCode, value) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(value),
  };
}

function constantTimeTokenMatch(candidate, expected) {
  if (!candidate || !expected) return false;
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest) && candidate.length === expected.length;
}

function hasConfig(provider, capability) {
  const required = CONFIG_REQUIREMENTS[provider][capability];
  const missing = required.filter((name) => !process.env[name]?.trim());
  return { ready: missing.length === 0, missing };
}

function getGatewayStatus() {
  const providers = Object.fromEntries(Object.keys(CONFIG_REQUIREMENTS).map((provider) => [
    provider,
    Object.fromEntries(Object.keys(CONFIG_REQUIREMENTS[provider]).map((capability) => [
      capability,
      hasConfig(provider, capability),
    ])),
  ]));
  return { gatewayReady: true, providers };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw Object.assign(new Error('Request is too large.'), { statusCode: 413 });
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 });
  }
}

function stringValue(value, maxLength = 240) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function objectValue(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function upstreamJson(provider, url, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/json', ...(init.headers || {}) },
    });
  } catch {
    throw new UpstreamError(provider, 502);
  }
  if (!response.ok) throw new UpstreamError(provider, response.status);
  if (response.status === 204) return {};
  try {
    return await response.json();
  } catch {
    throw new UpstreamError(provider, 502);
  }
}

function ozonHeaders() {
  return {
    'Content-Type': 'application/json',
    'Client-Id': process.env.OZON_CLIENT_ID.trim(),
    'Api-Key': process.env.OZON_API_KEY.trim(),
  };
}

function yandexHeaders() {
  return {
    'Content-Type': 'application/json',
    'Api-Key': process.env.YANDEX_API_KEY.trim(),
  };
}

function wbHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: process.env.WILDBERRIES_API_KEY.trim(),
  };
}

function safeProducts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => {
    const product = objectValue(item);
    const offerId = stringValue(product.offer_id ?? product.offerId ?? product.shopSku ?? product.article, 100);
    return {
      offer_id: offerId,
      sku: offerId,
      quantity: Math.max(1, Math.min(200, Number.parseInt(product.quantity ?? product.count, 10) || 1)),
    };
  }).filter((product) => product.sku);
}

function parseYandexDate(value) {
  const text = stringValue(value, 80);
  if (!text) return '';
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  const match = text.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return '';
  const [, day, month, year, hour, minute, second] = match;
  // Yandex Market's legacy date string is Moscow time (UTC+03:00).
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 3, Number(minute), Number(second))).toISOString();
}

function normalizeOzonPosting(value) {
  const posting = objectValue(value);
  const delivery = objectValue(posting.delivery_method);
  return {
    posting_number: stringValue(posting.posting_number, 160),
    order_id: posting.order_id,
    status: stringValue(posting.status, 80),
    created_at: stringValue(posting.in_process_at ?? posting.created_at ?? posting.shipment_date, 80),
    tracking_number: stringValue(posting.tracking_number, 120),
    carrier: stringValue(delivery.tpl_provider ?? delivery.name, 100),
    products: safeProducts(posting.products),
    __marketplace: { providerOrderId: stringValue(posting.order_id, 160) },
  };
}

function normalizeYandexOrder(value) {
  const order = objectValue(value);
  const delivery = objectValue(order.delivery);
  const shipments = Array.isArray(delivery.shipments) ? delivery.shipments : [];
  const shipment = objectValue(shipments[0]);
  const legacyTrack = Array.isArray(shipment.tracks) ? objectValue(shipment.tracks[0]) : {};
  const businessTrack = Array.isArray(delivery.tracks) ? objectValue(delivery.tracks[0]) : {};
  const items = Array.isArray(order.items) ? order.items.slice(0, 100).map((entry) => {
    const item = objectValue(entry);
    return {
      offerId: stringValue(item.offerId ?? item.shopSku, 100),
      offerName: stringValue(item.offerName, 160),
      count: Math.max(1, Math.min(200, Number.parseInt(item.count, 10) || 1)),
    };
  }).filter((item) => item.offerId) : [];
  const providerStatus = stringValue(order.status, 80);
  const substatus = stringValue(order.substatus, 80);
  const status = providerStatus === 'PROCESSING' && substatus === 'READY_TO_SHIP' ? substatus : providerStatus;
  const orderId = order.orderId ?? order.id;
  return {
    orderId,
    status,
    substatus,
    creationDate: parseYandexDate(order.creationDate),
    trackingNumber: stringValue(businessTrack.trackCode ?? legacyTrack.trackCode ?? shipment.trackCode, 120),
    carrier: stringValue(delivery.serviceName ?? objectValue(delivery.deliveryService).name, 100),
    items,
    __marketplace: { providerOrderId: stringValue(orderId, 160) },
  };
}

function normalizeWbOrder(value) {
  const order = objectValue(value);
  const supplierStatus = stringValue(order.supplierStatus, 80).toLowerCase();
  const wbStatus = stringValue(order.wbStatus, 80).toLowerCase();
  const isCancel = order.isCancel === true || supplierStatus.startsWith('cancel') || wbStatus.startsWith('cancel');
  const status = isCancel ? 'Cancelled' : supplierStatus === 'complete' ? 'Shipped' : supplierStatus;
  return {
    id: order.id,
    status,
    supplierStatus,
    wbStatus,
    createdAt: stringValue(order.createdAt, 80),
    article: stringValue(order.article ?? order.supplierArticle, 100),
    supplierArticle: stringValue(order.article ?? order.supplierArticle, 100),
    nmId: order.nmId,
    isCancel,
    quantity: Math.max(1, Math.min(200, Number.parseInt(order.quantity, 10) || 1)),
    __marketplace: { providerOrderId: stringValue(order.id, 160) },
  };
}

async function fetchOzonOrders() {
  const now = Date.now();
  const from = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
  const orders = [];
  let offset = 0;
  while (orders.length < MAX_API_ORDERS) {
    const result = await upstreamJson('Ozon', `${OZONE_API}/v3/posting/fbs/unfulfilled/list`, {
      method: 'POST',
      headers: ozonHeaders(),
      body: JSON.stringify({
        dir: 'DESC',
        filter: { cutoff_from: from, cutoff_to: to },
        limit: 1_000,
        offset,
        with: { analytics_data: false, barcodes: true, financial_data: false, legal_info: false, translit: false },
      }),
    });
    const postings = Array.isArray(result?.result?.postings) ? result.result.postings : [];
    orders.push(...postings.map(normalizeOzonPosting));
    if (postings.length < 1_000) break;
    offset += postings.length;
  }
  return orders.slice(0, MAX_API_ORDERS);
}

async function fetchYandexOrders() {
  const businessId = Number(process.env.YANDEX_BUSINESS_ID);
  const campaignId = Number(process.env.YANDEX_CAMPAIGN_ID);
  if (!Number.isSafeInteger(businessId) || businessId < 1) {
    throw Object.assign(new Error('Yandex Market business id is not configured correctly.'), { statusCode: 503 });
  }
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) {
    throw Object.assign(new Error('Yandex Market campaign id is not configured correctly.'), { statusCode: 503 });
  }
  const encodedBusinessId = encodeURIComponent(String(businessId));
  const orders = [];
  const seenTokens = new Set();
  let pageToken = '';
  for (let page = 0; page < 10 && orders.length < 500; page++) {
    const url = new URL(`${YANDEX_API}/v1/businesses/${encodedBusinessId}/orders`);
    url.searchParams.set('limit', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const result = await upstreamJson('Yandex Market', url, {
      method: 'POST',
      headers: yandexHeaders(),
      body: JSON.stringify({ campaignIds: [campaignId], statuses: ['PROCESSING', 'DELIVERY'] }),
    });
    const pageOrders = Array.isArray(result?.orders) ? result.orders : [];
    orders.push(...pageOrders.map(normalizeYandexOrder));
    const nextToken = stringValue(result?.paging?.nextPageToken, 500);
    if (!nextToken || seenTokens.has(nextToken) || pageOrders.length === 0) break;
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }
  return orders.slice(0, 500);
}

async function fetchWbOrders(knownOrderIds = []) {
  const headers = wbHeaders();
  const result = await upstreamJson('Wildberries', `${WILDBERRIES_API}/api/v3/orders/new`, { headers });
  const byId = new Map();
  const newOrders = Array.isArray(result?.orders) ? result.orders : [];
  for (const order of newOrders) {
    const normalized = normalizeWbOrder(order);
    if (normalized.id !== undefined) byId.set(String(normalized.id), normalized);
  }

  const ids = [...new Set(knownOrderIds.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 1_000);
  if (ids.length) {
    const statusResult = await upstreamJson('Wildberries', `${WILDBERRIES_API}/api/v3/orders/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orders: ids }),
    });
    const statuses = Array.isArray(statusResult?.orders) ? statusResult.orders : [];
    for (const order of statuses) {
      const normalized = normalizeWbOrder(order);
      if (normalized.id !== undefined) {
        const previous = byId.get(String(normalized.id));
        byId.set(String(normalized.id), previous ? { ...previous, ...normalized } : normalized);
      }
    }
  }
  return [...byId.values()].slice(0, MAX_API_ORDERS);
}

async function getMarketplaceOrders(provider, body) {
  const config = hasConfig(provider, 'orders');
  if (!config.ready) return jsonResponse(503, { error: `${provider} order API is not configured on the server.`, missing: config.missing });
  let orders;
  if (provider === 'ozon') orders = await fetchOzonOrders();
  else if (provider === 'yandex-market') orders = await fetchYandexOrders();
  else orders = await fetchWbOrders(Array.isArray(body.knownOrderIds) ? body.knownOrderIds : []);
  return jsonResponse(200, { orders, received: orders.length, fetchedAt: new Date().toISOString() });
}

function sanitizeInventory(value) {
  if (!Array.isArray(value)) throw Object.assign(new Error('Inventory must be an array.'), { statusCode: 400 });
  if (value.length > MAX_INVENTORY) throw Object.assign(new Error(`Sync at most ${MAX_INVENTORY} inventory rows per request.`), { statusCode: 413 });
  return value.map((entry) => {
    const item = objectValue(entry);
    const sku = stringValue(item.sku, 100);
    const stock = Number(item.stock);
    const chrtIdValue = Number(item.wildberriesChrtId);
    return {
      sku,
      barcode: stringValue(item.barcode, 100),
      ozonOfferId: stringValue(item.ozonOfferId, 100),
      yandexSku: stringValue(item.yandexSku, 100),
      wildberriesChrtId: Number.isSafeInteger(chrtIdValue) && chrtIdValue > 0 ? chrtIdValue : 0,
      stock: Number.isFinite(stock) ? Math.max(0, Math.min(2_000_000_000, Math.floor(stock))) : -1,
    };
  }).filter((item) => item.sku && item.stock >= 0);
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

async function syncOzonStock(items) {
  const warehouseId = Number(process.env.OZON_WAREHOUSE_ID);
  if (!Number.isSafeInteger(warehouseId) || warehouseId < 1) return jsonResponse(503, { error: 'Ozon warehouse id is not configured correctly.' });
  const duplicateOfferIds = findDuplicates(items.map((item) => item.ozonOfferId || item.sku));
  if (duplicateOfferIds.length) return jsonResponse(400, { error: `Ozon offer IDs must be unique in a stock request: ${duplicateOfferIds.slice(0, 5).join(', ')}.` });
  const productMap = new Map();
  for (let start = 0; start < items.length; start += 100) {
    const chunk = items.slice(start, start + 100);
    const info = await upstreamJson('Ozon', `${OZONE_API}/v3/product/info/list`, {
      method: 'POST',
      headers: ozonHeaders(),
      body: JSON.stringify({ offer_id: chunk.map((item) => item.ozonOfferId || item.sku) }),
    });
    for (const product of Array.isArray(info?.items) ? info.items : []) {
      const offerId = stringValue(product.offer_id, 100);
      const productId = Number(product.id ?? product.product_id);
      if (offerId && Number.isSafeInteger(productId) && productId > 0) productMap.set(offerId, productId);
    }
  }
  const matched = items.filter((item) => productMap.has(item.ozonOfferId || item.sku));
  const unmatched = items.filter((item) => !productMap.has(item.ozonOfferId || item.sku));
  if (!matched.length) return jsonResponse(200, { updated: 0, skipped: unmatched.length, failed: 0, unmatchedSkus: unmatched.slice(0, 20).map((item) => item.sku) });
  const updated = [];
  let failed = 0;
  for (let start = 0; start < matched.length; start += 1_000) {
    const chunk = matched.slice(start, start + 1_000);
    const result = await upstreamJson('Ozon', `${OZONE_API}/v2/products/stocks`, {
      method: 'POST',
      headers: ozonHeaders(),
      body: JSON.stringify({ stocks: chunk.map((item) => ({
        offer_id: item.ozonOfferId || item.sku,
        product_id: productMap.get(item.ozonOfferId || item.sku),
        stock: item.stock,
        warehouse_id: warehouseId,
        quant_size: 1,
      })) }),
    });
    const perItem = Array.isArray(result?.result) ? result.result : [];
    if (!perItem.length) {
      // A successful HTTP response without item results is accepted by Ozon;
      // count it as an accepted update rather than claiming an item-level result.
      updated.push(...chunk);
      continue;
    }
    updated.push(...perItem.filter((item) => item?.updated === true && !item?.errors?.length));
    failed += perItem.filter((item) => item?.updated !== true || item?.errors?.length).length;
    failed += Math.max(0, chunk.length - perItem.length);
  }
  return jsonResponse(200, {
    updated: updated.length,
    skipped: unmatched.length,
    failed,
    unmatchedSkus: unmatched.slice(0, 20).map((item) => item.sku),
  });
}

async function syncYandexStock(items) {
  const businessId = encodeURIComponent(process.env.YANDEX_BUSINESS_ID.trim());
  const warehouseId = Number(process.env.YANDEX_PARTNER_WAREHOUSE_ID);
  if (!Number.isSafeInteger(warehouseId) || warehouseId < 1) return jsonResponse(503, { error: 'Yandex Market partner warehouse id is not configured correctly.' });
  const duplicateSkus = findDuplicates(items.map((item) => item.yandexSku || item.sku));
  if (duplicateSkus.length) return jsonResponse(400, { error: `Yandex seller SKUs must be unique for the configured warehouse: ${duplicateSkus.slice(0, 5).join(', ')}.` });
  let updated = 0;
  let failed = 0;
  for (let start = 0; start < items.length; start += 2_000) {
    const chunk = items.slice(start, start + 2_000);
    const result = await upstreamJson('Yandex Market', `${YANDEX_API}/v3/businesses/${businessId}/offers/stocks/update`, {
      method: 'POST',
      headers: yandexHeaders(),
      body: JSON.stringify({ skuItems: chunk.map((item) => ({
        sku: item.yandexSku || item.sku,
        partnerWarehouseId: warehouseId,
        count: item.stock,
        updatedAt: new Date().toISOString(),
      })) }),
    });
    const errors = Array.isArray(result?.errors) ? result.errors.length : 0;
    failed += errors;
    updated += Math.max(0, chunk.length - errors);
  }
  return jsonResponse(200, { updated, skipped: 0, failed });
}

async function syncWbStock(items) {
  const warehouseIdValue = Number(process.env.WILDBERRIES_WAREHOUSE_ID);
  if (!Number.isSafeInteger(warehouseIdValue) || warehouseIdValue < 1) return jsonResponse(503, { error: 'Wildberries warehouse id is not configured correctly.' });
  const warehouseId = String(warehouseIdValue);
  const mapped = items.filter((item) => item.wildberriesChrtId > 0);
  const unmatched = items.filter((item) => item.wildberriesChrtId < 1);
  const aboveStockLimit = mapped.filter((item) => item.stock > 100_000);
  const eligible = mapped.filter((item) => item.stock <= 100_000);
  const byChrtId = new Map();
  for (const item of mapped) {
    if (byChrtId.has(item.wildberriesChrtId)) {
      return jsonResponse(400, { error: `Wildberries chrtId ${item.wildberriesChrtId} is mapped more than once. Each size id must be unique.` });
    }
    byChrtId.set(item.wildberriesChrtId, item);
  }
  if (!mapped.length) return jsonResponse(200, {
    updated: 0,
    skipped: unmatched.length,
    failed: 0,
    unmatchedSkus: unmatched.slice(0, 20).map((item) => item.sku),
    message: 'Wildberries stock requires the product size chrtId; a barcode is not a substitute.',
  });
  if (!eligible.length) return jsonResponse(200, {
    updated: 0,
    skipped: unmatched.length,
    failed: aboveStockLimit.length,
    unmatchedSkus: unmatched.slice(0, 20).map((item) => item.sku),
    failedSkus: aboveStockLimit.slice(0, 20).map((item) => item.sku),
    message: 'Wildberries inventory amounts over 100,000 are not sent; review those SKUs instead of silently clamping them.',
  });
  let updated = 0;
  for (let start = 0; start < eligible.length; start += 1_000) {
    const chunk = eligible.slice(start, start + 1_000);
    await upstreamJson('Wildberries', `${WILDBERRIES_API}/api/v3/stocks/${warehouseId}`, {
      method: 'PUT',
      headers: wbHeaders(),
      body: JSON.stringify({ stocks: chunk.map((item) => ({ chrtId: item.wildberriesChrtId, amount: item.stock })) }),
    });
    updated += chunk.length;
  }
  return jsonResponse(200, {
    updated,
    skipped: unmatched.length,
    failed: aboveStockLimit.length,
    unmatchedSkus: unmatched.slice(0, 20).map((item) => item.sku),
    failedSkus: aboveStockLimit.slice(0, 20).map((item) => item.sku),
  });
}

async function updateMarketplaceStock(provider, body) {
  const config = hasConfig(provider, 'stock');
  if (!config.ready) return jsonResponse(503, { error: `${provider} stock sync is not configured on the server.`, missing: config.missing });
  const items = sanitizeInventory(body.inventory);
  if (!items.length) return jsonResponse(400, { error: 'No valid local inventory SKUs were supplied.' });
  if (provider === 'ozon') return syncOzonStock(items);
  if (provider === 'yandex-market') return syncYandexStock(items);
  return syncWbStock(items);
}

function validateDispatchOrders(body) {
  if (!Array.isArray(body.orders) || body.orders.length === 0) throw Object.assign(new Error('Choose at least one packed or ready-to-ship order.'), { statusCode: 400 });
  if (body.orders.length > MAX_ORDERS) throw Object.assign(new Error(`Dispatch at most ${MAX_ORDERS} orders per request.`), { statusCode: 413 });
  return body.orders.map((entry) => {
    const order = objectValue(entry);
    return {
      marketplaceOrderId: stringValue(order.marketplaceOrderId, 160),
      status: stringValue(order.status, 40),
      trackingNumber: stringValue(order.trackingNumber, 120),
      marketplaceData: stringValue(order.marketplaceData, 1_000),
    };
  }).filter((order) => order.marketplaceOrderId && (order.status === 'Packed' || order.status === 'ReadyToShip'));
}

async function dispatchOzon(orders) {
  const results = [];
  for (const order of orders) {
    const postingNumber = order.marketplaceOrderId;
    try {
      const details = await upstreamJson('Ozon', `${OZONE_API}/v3/posting/fbs/get`, {
        method: 'POST', headers: ozonHeaders(), body: JSON.stringify({ posting_number: postingNumber }),
      });
      const posting = objectValue(details?.result);
      const status = stringValue(posting.status, 80);
      if (status === 'awaiting_deliver' || status === 'delivering' || status === 'driver_pickup') {
        results.push({ marketplaceOrderId: postingNumber, success: true, alreadyDispatched: true });
        continue;
      }
      if (status !== 'awaiting_packaging') {
        results.push({ marketplaceOrderId: postingNumber, success: false, message: `Ozon posting is in ${status || 'an unknown'} status; it was not dispatched.` });
        continue;
      }
      const products = Array.isArray(posting.products) ? posting.products.map((entry) => {
        const product = objectValue(entry);
        return { product_id: Number(product.sku ?? product.product_id), quantity: Number(product.quantity) };
      }).filter((product) => Number.isSafeInteger(product.product_id) && product.product_id > 0 && Number.isSafeInteger(product.quantity) && product.quantity > 0) : [];
      if (!products.length) {
        results.push({ marketplaceOrderId: postingNumber, success: false, message: 'Ozon did not return dispatchable product ids. Re-sync the order from the live OMS API.' });
        continue;
      }
      await upstreamJson('Ozon', `${OZONE_API}/v4/posting/fbs/ship`, {
        method: 'POST', headers: ozonHeaders(), body: JSON.stringify({ posting_number: postingNumber, packages: [{ products }] }),
      });
      await upstreamJson('Ozon', `${OZONE_API}/v2/posting/fbs/awaiting-delivery`, {
        method: 'POST', headers: ozonHeaders(), body: JSON.stringify({ posting_number: [postingNumber] }),
      });
      results.push({ marketplaceOrderId: postingNumber, success: true });
    } catch (error) {
      const step = error instanceof UpstreamError && error.status === 502 ? 'The request timed out or could not reach Ozon.' : 'Ozon rejected the dispatch request or the gateway could not complete it.';
      results.push({ marketplaceOrderId: postingNumber, success: false, message: step });
    }
  }
  return jsonResponse(200, { results, dispatched: results.filter((item) => item.success).length, failed: results.filter((item) => !item.success).length });
}

async function dispatchYandex(orders) {
  const campaignId = encodeURIComponent(process.env.YANDEX_CAMPAIGN_ID.trim());
  const deliveryServiceId = Number(process.env.YANDEX_DELIVERY_SERVICE_ID);
  if (!Number.isSafeInteger(deliveryServiceId) || deliveryServiceId < 1) return jsonResponse(503, { error: 'Yandex Market delivery service id is not configured correctly.' });
  const results = [];
  for (const order of orders) {
    const orderId = Number(order.marketplaceOrderId);
    if (!Number.isSafeInteger(orderId) || orderId < 1 || !order.trackingNumber || order.trackingNumber.startsWith('LOCAL-DEMO-')) {
      results.push({ marketplaceOrderId: order.marketplaceOrderId, success: false, message: 'Yandex dispatch needs a numeric order id and a genuine carrier tracking number.' });
      continue;
    }
    try {
      const base = `${YANDEX_API}/v2/campaigns/${campaignId}/orders/${orderId}`;
      await upstreamJson('Yandex Market', `${base}/delivery/track`, {
        method: 'POST', headers: yandexHeaders(), body: JSON.stringify({ trackCode: order.trackingNumber, deliveryServiceId }),
      });
      await upstreamJson('Yandex Market', `${base}/status`, {
        method: 'PUT', headers: yandexHeaders(), body: JSON.stringify({ order: { status: 'DELIVERY' } }),
      });
      results.push({ marketplaceOrderId: order.marketplaceOrderId, success: true });
    } catch (error) {
      results.push({ marketplaceOrderId: order.marketplaceOrderId, success: false, message: error instanceof UpstreamError && error.status === 502 ? 'Yandex Market timed out before confirming dispatch.' : 'Yandex Market did not accept the tracking/status update.' });
    }
  }
  return jsonResponse(200, { results, dispatched: results.filter((item) => item.success).length, failed: results.filter((item) => !item.success).length });
}

async function createWbSupply(body, orders) {
  const config = hasConfig('wildberries', 'dispatch');
  if (!config.ready) return jsonResponse(503, { error: 'Wildberries supply dispatch is not configured on the server.', missing: config.missing });
  const parsed = orders.map((order) => {
    let metadata = {};
    try { metadata = objectValue(JSON.parse(order.marketplaceData || '{}')); } catch { /* invalid local metadata is handled below */ }
    const providerOrderId = Number(metadata.providerOrderId);
    return { ...order, providerOrderId };
  });
  if (parsed.some((order) => !Number.isSafeInteger(order.providerOrderId) || order.providerOrderId < 1)) {
    return jsonResponse(400, { error: 'Wildberries needs a numeric order id from a live OMS sync. Re-sync those orders before creating a supply.' });
  }
  if (parsed.some((order) => {
    try { return Boolean(objectValue(JSON.parse(order.marketplaceData || '{}')).wbSupplyId); }
    catch { return false; }
  })) {
    return jsonResponse(409, { error: 'At least one selected order is already assigned to a Wildberries supply.' });
  }
  const name = stringValue(body.supplyName, 128) || `YESI-${new Date().toISOString().slice(0, 10)}`;
  const supply = await upstreamJson('Wildberries', `${WILDBERRIES_API}/api/v3/supplies`, {
    method: 'POST', headers: wbHeaders(), body: JSON.stringify({ name }),
  });
  const supplyId = stringValue(supply.id, 128);
  if (!supplyId) throw new UpstreamError('Wildberries', 502);
  try {
    await upstreamJson('Wildberries', `${WILDBERRIES_API}/api/marketplace/v3/supplies/${encodeURIComponent(supplyId)}/orders`, {
      method: 'PATCH', headers: wbHeaders(), body: JSON.stringify({ orders: parsed.map((order) => order.providerOrderId) }),
    });
  } catch {
    return jsonResponse(200, {
      supplyId,
      attached: false,
      attachedOrderIds: [],
      failed: parsed.length,
      message: 'Wildberries created an empty supply, but adding orders failed. Keep the supply id for manual recovery.',
    });
  }
  return jsonResponse(200, {
    supplyId,
    attached: true,
    attachedOrderIds: parsed.map((order) => order.marketplaceOrderId),
    attachedCount: parsed.length,
    handoffRequired: true,
  });
}

async function dispatchMarketplaceOrders(provider, body) {
  const config = hasConfig(provider, 'dispatch');
  if (!config.ready) return jsonResponse(503, { error: `${provider} dispatch is not configured on the server.`, missing: config.missing });
  const orders = validateDispatchOrders(body);
  if (!orders.length) return jsonResponse(400, { error: 'No packed or ready-to-ship orders were supplied.' });
  if (provider === 'ozon') return dispatchOzon(orders);
  if (provider === 'yandex-market') return dispatchYandex(orders);
  return createWbSupply(body, orders);
}

async function deliverWbSupply(body) {
  const config = hasConfig('wildberries', 'dispatch');
  if (!config.ready) return jsonResponse(503, { error: 'Wildberries supply dispatch is not configured on the server.', missing: config.missing });
  const supplyId = stringValue(body.supplyId, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(supplyId)) return jsonResponse(400, { error: 'Enter a valid Wildberries supply id.' });
  await upstreamJson('Wildberries', `${WILDBERRIES_API}/api/v3/supplies/${encodeURIComponent(supplyId)}/deliver`, {
    method: 'PATCH', headers: wbHeaders(),
  });
  return jsonResponse(200, { supplyId, delivered: true });
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Use POST for Marketplace Gateway requests.' });
  const expected = process.env.MARKETPLACE_GATEWAY_TOKEN?.trim() || '';
  if (expected.length < 32) return jsonResponse(503, { error: 'Marketplace Gateway is not configured. Set a 32-character server-side gateway token.' });
  const authorization = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const candidate = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
  if (!constantTimeTokenMatch(candidate, expected)) return jsonResponse(401, { error: 'Marketplace Gateway access was denied.' });

  let body;
  try {
    body = objectValue(parseBody(event));
  } catch (error) {
    return jsonResponse(error.statusCode || 400, { error: error.message || 'Invalid request.' });
  }

  const action = stringValue(body.action, 40);
  if (action === 'status') return jsonResponse(200, getGatewayStatus());
  if (action === 'deliver-supply') {
    try { return await deliverWbSupply(body); }
    catch (error) { return jsonResponse(error instanceof UpstreamError ? 502 : 400, { error: 'Wildberries could not hand off that supply. Check its state in the WB portal.', upstreamStatus: error instanceof UpstreamError ? error.status : undefined }); }
  }

  const provider = stringValue(body.marketplace, 40);
  if (!Object.hasOwn(CONFIG_REQUIREMENTS, provider)) return jsonResponse(400, { error: 'Choose Ozon, Yandex Market or Wildberries.' });
  try {
    if (action === 'orders') return await getMarketplaceOrders(provider, body);
    if (action === 'stock') return await updateMarketplaceStock(provider, body);
    if (action === 'dispatch') return await dispatchMarketplaceOrders(provider, body);
    return jsonResponse(400, { error: 'Unknown Marketplace Gateway action.' });
  } catch (error) {
    if (error instanceof UpstreamError) {
      const statusCode = error.status === 429 ? 429 : 502;
      return jsonResponse(statusCode, {
        error: `${error.provider} API request failed. Verify server credentials, account permissions and provider availability.`,
        upstreamStatus: error.status,
      });
    }
    return jsonResponse(error.statusCode || 500, { error: error.message || 'Marketplace Gateway request failed.' });
  }
}
