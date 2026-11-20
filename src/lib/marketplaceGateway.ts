import type { MarketplaceId } from './marketplaceBridge';

export type MarketplaceGatewayAction = 'status' | 'orders' | 'stock' | 'dispatch' | 'deliver-supply';

export interface GatewayInventoryRow {
  sku: string;
  barcode?: string;
  ozonOfferId?: string;
  yandexSku?: string;
  wildberriesChrtId?: string;
  stock: number;
}

export interface GatewayDispatchOrder {
  marketplaceOrderId: string;
  status: string;
  trackingNumber?: string;
  marketplaceData?: string;
}

export interface MarketplaceGatewayRequest {
  action: MarketplaceGatewayAction;
  marketplace?: MarketplaceId;
  inventory?: GatewayInventoryRow[];
  orders?: GatewayDispatchOrder[];
  knownOrderIds?: string[];
  supplyName?: string;
  supplyId?: string;
}

export class MarketplaceGatewayError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.name = 'MarketplaceGatewayError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Calls the same-origin Netlify Function; marketplace credentials never enter the browser. */
export async function callMarketplaceGateway<T extends object = Record<string, unknown>>(
  token: string,
  request: MarketplaceGatewayRequest,
): Promise<T> {
  const accessToken = token.trim();
  if (accessToken.length < 32) {
    throw new MarketplaceGatewayError('Enter the Marketplace Gateway access token configured by your site administrator.');
  }

  let response: Response;
  try {
    response = await fetch('/api/marketplace', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      cache: 'no-store',
      body: JSON.stringify(request),
    });
  } catch {
    throw new MarketplaceGatewayError('Marketplace API gateway is unreachable. Deploy the Netlify Function or use the file-based exchange.');
  }

  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = responseText ? JSON.parse(responseText) as unknown : {};
  } catch {
    throw new MarketplaceGatewayError('The Marketplace Gateway endpoint is not running here. Use a Netlify deployment or the file-based exchange.', response.status);
  }

  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : `Marketplace Gateway request failed (${response.status}).`;
    throw new MarketplaceGatewayError(message, response.status);
  }
  if (!isRecord(payload)) throw new MarketplaceGatewayError('The Marketplace Gateway returned an invalid response.', response.status);
  return payload as T;
}
