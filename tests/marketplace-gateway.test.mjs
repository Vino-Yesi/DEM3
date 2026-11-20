import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../netlify/functions/marketplace.mjs';

const ENV_KEYS = [
  'MARKETPLACE_GATEWAY_TOKEN',
  'OZON_CLIENT_ID',
  'OZON_API_KEY',
  'OZON_WAREHOUSE_ID',
  'YANDEX_API_KEY',
  'YANDEX_CAMPAIGN_ID',
  'YANDEX_BUSINESS_ID',
  'YANDEX_PARTNER_WAREHOUSE_ID',
  'YANDEX_DELIVERY_SERVICE_ID',
  'WILDBERRIES_API_KEY',
  'WILDBERRIES_WAREHOUSE_ID',
];
const TOKEN = 'marketplace-gateway-test-token-0123456789abcdef';
let originalEnv;
let originalFetch;

beforeEach(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.MARKETPLACE_GATEWAY_TOKEN = TOKEN;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  globalThis.fetch = originalFetch;
});

function gatewayEvent(body, { method = 'POST', token = TOKEN } = {}) {
  return {
    httpMethod: method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

async function send(body, options) {
  const response = await handler(gatewayEvent(body, options));
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

test('requires a configured server token and rejects unauthenticated requests', async () => {
  delete process.env.MARKETPLACE_GATEWAY_TOKEN;
  const noServerToken = await send({ action: 'status' });
  assert.equal(noServerToken.statusCode, 503);

  process.env.MARKETPLACE_GATEWAY_TOKEN = TOKEN;
  const denied = await send({ action: 'status' }, { token: '' });
  assert.equal(denied.statusCode, 401);

  const wrongToken = await send({ action: 'status' }, { token: 'wrong-token'.padEnd(32, 'x') });
  assert.equal(wrongToken.statusCode, 401);
});

test('status reports configured capabilities without returning provider secrets', async () => {
  process.env.OZON_CLIENT_ID = 'ozon-client-test';
  process.env.OZON_API_KEY = 'ozon-secret-test';
  process.env.YANDEX_API_KEY = 'yandex-secret-test';
  const result = await send({ action: 'status' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.providers.ozon.orders.ready, true);
  assert.equal(result.body.providers.ozon.stock.ready, false);
  assert.ok(result.body.providers.ozon.stock.missing.includes('OZON_WAREHOUSE_ID'));
  assert.equal(result.body.providers['yandex-market'].orders.ready, false);
  assert.equal(JSON.stringify(result.body).includes('ozon-secret-test'), false);
  assert.equal(JSON.stringify(result.body).includes('yandex-secret-test'), false);
});

test('normalizes Ozon postings while keeping provider authentication server-side', async () => {
  process.env.OZON_CLIENT_ID = 'ozon-client-test';
  process.env.OZON_API_KEY = 'ozon-secret-test';
  let requestBody;
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).pathname, '/v3/posting/fbs/unfulfilled/list');
    assert.equal(init.headers['Client-Id'], 'ozon-client-test');
    assert.equal(init.headers['Api-Key'], 'ozon-secret-test');
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ result: { postings: [{
      posting_number: '00010-0042-1',
      order_id: 7042,
      status: 'awaiting_deliver',
      in_process_at: '2026-11-18T10:30:00Z',
      delivery_method: { tpl_provider: 'Local demo provider' },
      products: [{ offer_id: 'SELLER-SKU-1', quantity: 2 }],
    }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await send({ action: 'orders', marketplace: 'ozon' });
  assert.equal(result.statusCode, 200);
  assert.equal(requestBody.limit, 1_000);
  assert.equal(result.body.orders[0].posting_number, '00010-0042-1');
  assert.equal(result.body.orders[0].__marketplace.providerOrderId, '7042');
  assert.equal(result.body.orders[0].products[0].quantity, 2);
  assert.equal(JSON.stringify(result.body).includes('ozon-secret-test'), false);
});

test('Yandex stock adapter sends mapped seller SKUs to the partner warehouse API', async () => {
  process.env.YANDEX_API_KEY = 'yandex-secret-test';
  process.env.YANDEX_BUSINESS_ID = '12345';
  process.env.YANDEX_PARTNER_WAREHOUSE_ID = '67890';
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).pathname, '/v3/businesses/12345/offers/stocks/update');
    assert.equal(init.headers['Api-Key'], 'yandex-secret-test');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.skuItems, [{
      sku: 'YM-OFFER-7', partnerWarehouseId: 67890, count: 9, updatedAt: body.skuItems[0].updatedAt,
    }]);
    return new Response(JSON.stringify({ errors: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await send({
    action: 'stock',
    marketplace: 'yandex-market',
    inventory: [{ sku: 'LOCAL-7', yandexSku: 'YM-OFFER-7', stock: 9 }],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.updated, 1);
  assert.equal(result.body.failed, 0);
});

test('Wildberries stock adapter uses numeric chrtId, never an EAN barcode', async () => {
  process.env.WILDBERRIES_API_KEY = 'wb-secret-test';
  process.env.WILDBERRIES_WAREHOUSE_ID = '555001';
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/v3/stocks/555001');
    assert.equal(init.headers.Authorization, 'wb-secret-test');
    assert.deepEqual(JSON.parse(init.body), { stocks: [{ chrtId: 600123, amount: 4 }] });
    return new Response(null, { status: 204 });
  };
  const result = await send({
    action: 'stock',
    marketplace: 'wildberries',
    inventory: [{ sku: 'LOCAL-1', barcode: '4601234567890', wildberriesChrtId: '600123', stock: 4 }],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.updated, 1);
  assert.equal(result.body.skipped, 0);
});

test('Wildberries stock without a chrtId is reported as skipped, not falsely sent by barcode', async () => {
  process.env.WILDBERRIES_API_KEY = 'wb-secret-test';
  process.env.WILDBERRIES_WAREHOUSE_ID = '555001';
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response(null, { status: 204 }); };
  const result = await send({
    action: 'stock',
    marketplace: 'wildberries',
    inventory: [{ sku: 'LOCAL-1', barcode: '4601234567890', stock: 4 }],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.updated, 0);
  assert.equal(result.body.skipped, 1);
  assert.equal(called, false);
});

test('Yandex dispatch refuses synthetic tracking and sends genuine track/status calls in order', async () => {
  process.env.YANDEX_API_KEY = 'yandex-secret-test';
  process.env.YANDEX_CAMPAIGN_ID = '111';
  process.env.YANDEX_DELIVERY_SERVICE_ID = '222';
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (calls === 1) {
      assert.equal(new URL(url).pathname, '/v2/campaigns/111/orders/78/delivery/track');
      assert.deepEqual(JSON.parse(init.body), { trackCode: 'REAL-TRACK-001', deliveryServiceId: 222 });
    } else {
      assert.equal(new URL(url).pathname, '/v2/campaigns/111/orders/78/status');
      assert.deepEqual(JSON.parse(init.body), { order: { status: 'DELIVERY' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await send({
    action: 'dispatch', marketplace: 'yandex-market',
    orders: [
      { marketplaceOrderId: '78', status: 'ReadyToShip', trackingNumber: 'LOCAL-DEMO-1' },
      { marketplaceOrderId: '78', status: 'ReadyToShip', trackingNumber: 'REAL-TRACK-001' },
    ],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(result.body.results[0].success, false);
  assert.equal(result.body.results[1].success, true);
});

test('Ozon stock resolves mapped offer IDs before sending stock to the configured warehouse', async () => {
  process.env.OZON_CLIENT_ID = 'ozon-client-test';
  process.env.OZON_API_KEY = 'ozon-secret-test';
  process.env.OZON_WAREHOUSE_ID = '123';
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: JSON.parse(init.body) });
    if (path === '/v3/product/info/list') {
      return new Response(JSON.stringify({ items: [{ offer_id: 'OZON-OFFER', id: 999 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ result: [{ offer_id: 'OZON-OFFER', updated: true, errors: [] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await send({
    action: 'stock', marketplace: 'ozon',
    inventory: [{ sku: 'LOCAL-SKU', ozonOfferId: 'OZON-OFFER', stock: 5 }],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.updated, 1);
  assert.equal(requests[0].path, '/v3/product/info/list');
  assert.deepEqual(requests[0].body.offer_id, ['OZON-OFFER']);
  assert.equal(requests[1].path, '/v2/products/stocks');
  assert.deepEqual(requests[1].body.stocks[0], {
    offer_id: 'OZON-OFFER', product_id: 999, stock: 5, warehouse_id: 123, quant_size: 1,
  });
});

test('Yandex order pull uses the business API, paginates and normalizes READY_TO_SHIP orders', async () => {
  process.env.YANDEX_API_KEY = 'yandex-secret-test';
  process.env.YANDEX_BUSINESS_ID = '13579';
  process.env.YANDEX_CAMPAIGN_ID = '2468';
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(url);
    requests.push({ url: requestUrl, init });
    assert.equal(requestUrl.pathname, '/v1/businesses/13579/orders');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Api-Key'], 'yandex-secret-test');
    assert.deepEqual(JSON.parse(init.body), { campaignIds: [2468], statuses: ['PROCESSING', 'DELIVERY'] });
    if (requests.length === 1) {
      assert.equal(requestUrl.searchParams.get('limit'), '50');
      assert.equal(requestUrl.searchParams.has('pageToken'), false);
      return new Response(JSON.stringify({
        orders: [{
          orderId: 735,
          status: 'PROCESSING',
          substatus: 'READY_TO_SHIP',
          creationDate: '2026-11-18T10:30:00+03:00',
          delivery: { serviceName: 'Test courier', tracks: [{ trackCode: 'REAL-YM-TRACK' }] },
          items: [{ offerId: 'YM-OFFER', count: 2 }],
        }],
        paging: { nextPageToken: 'page-2' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    assert.equal(requestUrl.searchParams.get('pageToken'), 'page-2');
    return new Response(JSON.stringify({
      orders: [{ orderId: 736, status: 'DELIVERY', substatus: 'SHIPPED', items: [{ offerId: 'YM-OFFER-2', count: 1 }] }],
      paging: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await send({ action: 'orders', marketplace: 'yandex-market' });
  assert.equal(result.statusCode, 200);
  assert.equal(requests.length, 2);
  assert.equal(result.body.orders.length, 2);
  assert.equal(result.body.orders[0].orderId, 735);
  assert.equal(result.body.orders[0].status, 'READY_TO_SHIP');
  assert.equal(result.body.orders[0].items[0].count, 2);
  assert.equal(result.body.orders[0].trackingNumber, 'REAL-YM-TRACK');
  assert.equal(result.body.orders[0].carrier, 'Test courier');
  assert.equal(result.body.orders[0].__marketplace.providerOrderId, '735');
  assert.match(result.body.orders[0].creationDate, /^2026-11-18T07:30:00\.000Z$/);
  assert.equal(result.body.orders[1].status, 'DELIVERY');
});

test('Ozon dispatch checks provider state and runs ship then awaiting-delivery transitions', async () => {
  process.env.OZON_CLIENT_ID = 'ozon-client-test';
  process.env.OZON_API_KEY = 'ozon-secret-test';
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: JSON.parse(init.body) });
    if (path === '/v3/posting/fbs/get') {
      return new Response(JSON.stringify({ result: { status: 'awaiting_packaging', products: [{ sku: 789, quantity: 2 }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await send({
    action: 'dispatch', marketplace: 'ozon',
    orders: [{ marketplaceOrderId: 'POST-42', status: 'Packed' }],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.results[0].success, true);
  assert.deepEqual(requests.map((request) => request.path), [
    '/v3/posting/fbs/get', '/v4/posting/fbs/ship', '/v2/posting/fbs/awaiting-delivery',
  ]);
  assert.deepEqual(requests[1].body.packages[0].products, [{ product_id: 789, quantity: 2 }]);
});

test('Wildberries supply creation, order assignment and delivery handoff are separate actions', async () => {
  process.env.WILDBERRIES_API_KEY = 'wb-secret-test';
  const paths = [];
  globalThis.fetch = async (url, init) => {
    paths.push(`${init.method} ${new URL(url).pathname}`);
    if (paths.length === 1) return new Response(JSON.stringify({ id: 'WB-GI-12345' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    return new Response(null, { status: 204 });
  };

  const create = await send({
    action: 'dispatch', marketplace: 'wildberries', supplyName: 'YESI-TEST',
    orders: [{ marketplaceOrderId: 'ext-1', status: 'Packed', marketplaceData: JSON.stringify({ providerOrderId: '789' }) }],
  });
  assert.equal(create.statusCode, 200);
  assert.equal(create.body.supplyId, 'WB-GI-12345');
  assert.equal(create.body.attached, true);
  assert.deepEqual(paths, [
    'POST /api/v3/supplies',
    'PATCH /api/marketplace/v3/supplies/WB-GI-12345/orders',
  ]);

  const handoff = await send({ action: 'deliver-supply', supplyId: 'WB-GI-12345' });
  assert.equal(handoff.statusCode, 200);
  assert.equal(handoff.body.delivered, true);
  assert.equal(paths.at(-1), 'PATCH /api/v3/supplies/WB-GI-12345/deliver');
});

test('rejects malformed and oversized JSON before contacting provider APIs', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  const malformed = await handler(gatewayEvent('{bad json'));
  assert.equal(malformed.statusCode, 400);
  const oversized = await handler(gatewayEvent(`{"action":"status","padding":"${'x'.repeat(1024 * 1024)}"}`));
  assert.equal(oversized.statusCode, 413);
  assert.equal(called, false);
});
