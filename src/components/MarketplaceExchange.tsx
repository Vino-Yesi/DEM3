import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  Boxes,
  CheckCircle2,
  FileUp,
  KeyRound,
  PackageCheck,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Unplug,
} from 'lucide-react';
import { db, logAction, type InventoryItem, type InventoryReservation, type Order } from '@/lib/db';
import { useAuth } from '@/lib/auth';
import {
  createMarketplaceTrackingExport,
  importMarketplaceOrders,
  importMarketplaceRows,
  MARKETPLACES,
  readMarketplaceOrderData,
  readMarketplaceSkuMapping,
  type MarketplaceId,
  type MarketplaceSkuMapping,
} from '@/lib/marketplaceBridge';
import {
  callMarketplaceGateway,
  type GatewayDispatchOrder,
  type GatewayInventoryRow,
} from '@/lib/marketplaceGateway';

type BridgeMessage = { type: 'success' | 'warning' | 'error'; text: string };
type BusyAction = 'connect' | 'import' | 'export' | 'orders' | 'stock' | 'dispatch' | 'deliver' | 'mapping' | null;
type ApiCapability = { ready: boolean; missing?: string[] };
type ProviderCapabilities = Partial<Record<'orders' | 'stock' | 'dispatch', ApiCapability>>;
type GatewayStatus = {
  gatewayReady: boolean;
  providers?: Partial<Record<MarketplaceId, ProviderCapabilities>>;
};
type GatewayCountResult = { updated?: number; skipped?: number; failed?: number; unmatchedSkus?: string[] };
type GatewayDispatchResult = {
  results?: { marketplaceOrderId?: string; success?: boolean; alreadyDispatched?: boolean; message?: string }[];
  supplyId?: string;
  attached?: boolean;
  attachedOrderIds?: string[];
  attachedCount?: number;
  message?: string;
  delivered?: boolean;
};
type LocalSkuRow = {
  sku: string;
  product: string;
  onHand: number;
  available: number;
  barcode?: string;
  mapping: MarketplaceSkuMapping;
};

type MappingField = keyof MarketplaceSkuMapping;

const MAPPING_FIELDS: Record<MarketplaceId, { key: MappingField; label: string; numeric?: boolean }[]> = {
  ozon: [{ key: 'ozonOfferId', label: 'Ozon offer ID' }],
  'yandex-market': [{ key: 'yandexSku', label: 'Yandex seller SKU' }],
  wildberries: [
    { key: 'wildberriesArticle', label: 'WB supplier article' },
    { key: 'wildberriesChrtId', label: 'WB chrtId (size ID)', numeric: true },
  ],
};

function sanitizeSkuMapping(value: MarketplaceSkuMapping): MarketplaceSkuMapping {
  const clean = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry.trim().slice(0, 100) : ''])
      .filter(([, entry]) => Boolean(entry)),
  ) as MarketplaceSkuMapping;
  if (clean.wildberriesChrtId && !/^\d{1,20}$/.test(clean.wildberriesChrtId)) delete clean.wildberriesChrtId;
  return clean;
}

function aggregateInventory(items: InventoryItem[], reservations: InventoryReservation[]): LocalSkuRow[] {
  const bySku = new Map<string, LocalSkuRow>();
  for (const item of items) {
    const current = bySku.get(item.sku) || {
      sku: item.sku,
      product: item.product || item.sku,
      onHand: 0,
      available: 0,
      barcode: item.barcode,
      mapping: {},
    };
    current.onHand += Math.max(0, Number(item.stock) || 0);
    current.barcode ||= item.barcode;
    current.mapping = { ...readMarketplaceSkuMapping(item.marketplaceData), ...current.mapping };
    bySku.set(item.sku, current);
  }
  const reservedBySku = new Map<string, number>();
  for (const reservation of reservations) {
    if (reservation.status === 'reserved' || reservation.status === 'allocated') {
      reservedBySku.set(reservation.sku, (reservedBySku.get(reservation.sku) || 0) + reservation.quantity);
    }
  }
  return [...bySku.values()].map((row) => ({
    ...row,
    available: Math.max(0, row.onHand - (reservedBySku.get(row.sku) || 0)),
  }));
}

function marketplaceOrderKey(order: Order): string {
  return order.marketplaceOrderId || order.orderId;
}

export default function MarketplaceExchange() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [marketplace, setMarketplace] = useState<MarketplaceId>('ozon');
  const [orders, setOrders] = useState<Order[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [reservations, setReservations] = useState<InventoryReservation[]>([]);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState<BridgeMessage | null>(null);
  const [gatewayToken, setGatewayToken] = useState('');
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [mappingSearch, setMappingSearch] = useState('');
  const [mappingDrafts, setMappingDrafts] = useState<Record<string, MarketplaceSkuMapping>>({});
  const [selectedDispatchIds, setSelectedDispatchIds] = useState<Set<string>>(new Set());
  const [trackingDrafts, setTrackingDrafts] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshData = useCallback(async () => {
    const [nextOrders, nextInventory, nextReservations] = await Promise.all([
      db.orders.toArray(),
      db.inventory.toArray(),
      db.inventoryReservations.toArray(),
    ]);
    setOrders(nextOrders);
    setInventoryItems(nextInventory);
    setReservations(nextReservations);
  }, []);

  useEffect(() => {
    // Loading local Dexie records is an external data subscription, not render-derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshData().catch(() => {
      setMessage({ type: 'error', text: 'The local OMS/WMS data could not be loaded. Refresh and try again.' });
    });
  }, [refreshData]);

  const selectedOrders = useMemo(
    () => orders.filter((order) => order.sourceMarketplace === marketplace),
    [orders, marketplace],
  );
  const selectedCounts = useMemo(() => ({
    orders: selectedOrders.length,
    tracking: selectedOrders.filter((order) =>
      Boolean(order.trackingNumber) && (order.status === 'Shipped' || order.status === 'ReadyToShip'),
    ).length,
  }), [selectedOrders]);
  const localSkuRows = useMemo(() => aggregateInventory(inventoryItems, reservations), [inventoryItems, reservations]);
  const gatewayConnected = Boolean(gatewayStatus?.gatewayReady && gatewayToken.length >= 32);
  const capabilities = gatewayStatus?.providers?.[marketplace];
  const dispatchableOrders = useMemo(
    () => selectedOrders.filter((order) => (order.status === 'Packed' || order.status === 'ReadyToShip') && Boolean(order.marketplaceOrderId)),
    [selectedOrders],
  );
  const dispatchSelected = useMemo(
    () => dispatchableOrders.filter((order) => selectedDispatchIds.has(marketplaceOrderKey(order))),
    [dispatchableOrders, selectedDispatchIds],
  );
  const wildberriesSupplies = useMemo(() => {
    if (marketplace !== 'wildberries') return [];
    const bySupply = new Map<string, Order[]>();
    for (const order of selectedOrders) {
      const { wbSupplyId } = readMarketplaceOrderData(order.marketplaceData);
      if (wbSupplyId && order.status !== 'Shipped') {
        bySupply.set(wbSupplyId, [...(bySupply.get(wbSupplyId) || []), order]);
      }
    }
    return [...bySupply.entries()].map(([supplyId, supplyOrders]) => ({ supplyId, orders: supplyOrders }));
  }, [marketplace, selectedOrders]);
  const uniqueMappingRows = useMemo(() => {
    const needle = mappingSearch.trim().toLowerCase();
    return localSkuRows.filter((row) => !needle || row.sku.toLowerCase().includes(needle) || row.product.toLowerCase().includes(needle));
  }, [localSkuRows, mappingSearch]);
  const selectedLabel = MARKETPLACES.find((item) => item.id === marketplace)?.label || marketplace;

  const connectGateway = async () => {
    if (!isAdmin) {
      setMessage({ type: 'error', text: 'Only a local administrator can connect the Marketplace Gateway.' });
      return;
    }
    setBusy('connect');
    setMessage(null);
    try {
      const status = await callMarketplaceGateway<GatewayStatus>(gatewayToken, { action: 'status' });
      setGatewayStatus(status);
      setMessage({ type: 'success', text: 'Gateway connected. Provider capabilities reflect the server-side environment configuration.' });
    } catch (cause) {
      setGatewayStatus(null);
      setMessage({ type: 'error', text: cause instanceof Error ? cause.message : 'Could not connect to the Marketplace Gateway.' });
    } finally {
      setBusy(null);
    }
  };

  const disconnectGateway = () => {
    setGatewayToken('');
    setGatewayStatus(null);
    setSelectedDispatchIds(new Set());
    setTrackingDrafts({});
    setMessage({ type: 'warning', text: 'Gateway access token cleared from this page. It was not saved to the local database.' });
  };

  const handleFileImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy('import');
    setMessage(null);
    try {
      const result = await importMarketplaceOrders(marketplace, file);
      await logAction(
        'MARKETPLACE_OMS_IMPORT',
        `${marketplace}: ${result.imported} imported, ${result.updated} updated, ${result.skipped} skipped`,
        user?.displayName || 'System',
      );
      setMessage({
        type: result.invalid ? 'warning' : 'success',
        text: `${result.imported} new, ${result.updated} updated. ${result.invalid} row(s) without an order ID were skipped.`,
      });
      await refreshData();
    } catch (cause) {
      setMessage({ type: 'error', text: cause instanceof Error ? cause.message : 'Import failed. Check the file and try again.' });
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleApiOrderSync = async () => {
    setBusy('orders');
    setMessage(null);
    try {
      const knownOrderIds = marketplace === 'wildberries'
        ? selectedOrders.map((order) => readMarketplaceOrderData(order.marketplaceData).providerOrderId || '').filter((id) => /^\d+$/.test(id)).slice(0, 1_000)
        : undefined;
      const result = await callMarketplaceGateway<{ orders?: unknown[]; received?: number }>(gatewayToken, {
        action: 'orders',
        marketplace,
        knownOrderIds,
      });
      if (!Array.isArray(result.orders)) throw new Error('The gateway response did not include a marketplace order list.');
      const imported = await importMarketplaceRows(marketplace, result.orders);
      await logAction(
        'MARKETPLACE_OMS_API_SYNC',
        `${marketplace}: ${imported.imported} imported, ${imported.updated} updated, ${imported.skipped} invalid row(s)`,
        user?.displayName || 'System',
      );
      await refreshData();
      setMessage({
        type: imported.invalid ? 'warning' : 'success',
        text: `Live OMS sync complete: ${imported.imported} new, ${imported.updated} updated, ${imported.invalid} invalid row(s).`,
      });
    } catch (cause) {
      setMessage({ type: 'error', text: cause instanceof Error ? cause.message : 'Live order sync failed.' });
    } finally {
      setBusy(null);
    }
  };

  const handleStockSync = async () => {
    if (!localSkuRows.length) {
      setMessage({ type: 'warning', text: 'There are no local inventory SKUs to sync.' });
      return;
    }
    setBusy('stock');
    setMessage(null);
    const summary = { updated: 0, skipped: 0, failed: 0 };
    try {
      const inventory: GatewayInventoryRow[] = localSkuRows.map((row) => ({
        sku: row.sku,
        stock: row.available,
        ...(row.barcode ? { barcode: row.barcode } : {}),
        ...(row.mapping.ozonOfferId ? { ozonOfferId: row.mapping.ozonOfferId } : {}),
        ...(row.mapping.yandexSku ? { yandexSku: row.mapping.yandexSku } : {}),
        ...(row.mapping.wildberriesChrtId ? { wildberriesChrtId: row.mapping.wildberriesChrtId } : {}),
      }));
      for (let start = 0; start < inventory.length; start += 1_000) {
        const result = await callMarketplaceGateway<GatewayCountResult>(gatewayToken, {
          action: 'stock', marketplace, inventory: inventory.slice(start, start + 1_000),
        });
        summary.updated += Number(result.updated) || 0;
        summary.skipped += Number(result.skipped) || 0;
        summary.failed += Number(result.failed) || 0;
      }
      await logAction(
        'MARKETPLACE_WMS_STOCK_SYNC',
        `${marketplace}: ${summary.updated} accepted, ${summary.skipped} skipped, ${summary.failed} failed. Active reservations were subtracted.`,
        user?.displayName || 'System',
      );
      setMessage({
        type: summary.failed ? 'warning' : 'success',
        text: `Stock sync complete: ${summary.updated} accepted, ${summary.skipped} skipped, ${summary.failed} failed. Counts sent were on-hand minus active reservations.`,
      });
    } catch (cause) {
      const progress = summary.updated || summary.skipped || summary.failed
        ? ` Partial progress before the error: ${summary.updated} accepted, ${summary.skipped} skipped, ${summary.failed} failed.`
        : '';
      setMessage({ type: 'error', text: `${cause instanceof Error ? cause.message : 'Stock sync failed.'}${progress}` });
    } finally {
      setBusy(null);
    }
  };

  const handleDispatch = async () => {
    if (!dispatchSelected.length) {
      setMessage({ type: 'warning', text: 'Select at least one Packed or ReadyToShip marketplace order.' });
      return;
    }
    if (marketplace === 'wildberries' && dispatchSelected.length > 100) {
      setMessage({ type: 'warning', text: 'Wildberries supplies accept at most 100 orders at a time.' });
      return;
    }
    if (marketplace === 'yandex-market' && dispatchSelected.some((order) => {
      const track = trackingDrafts[marketplaceOrderKey(order)]?.trim() || order.trackingNumber || '';
      return !track || track.startsWith('LOCAL-DEMO-');
    })) {
      setMessage({ type: 'warning', text: 'Enter a genuine carrier tracking number for every selected Yandex order. Synthetic demo numbers are rejected.' });
      return;
    }
    const operation = marketplace === 'wildberries'
      ? 'Create a Wildberries supply and attach the selected orders? This does not hand the physical parcel to WB.'
      : `Send ${dispatchSelected.length} dispatch update(s) to ${selectedLabel}? Review the orders first.`;
    if (!window.confirm(operation)) return;

    setBusy('dispatch');
    setMessage(null);
    try {
      const gatewayOrders: GatewayDispatchOrder[] = dispatchSelected.map((order) => ({
        marketplaceOrderId: marketplaceOrderKey(order),
        status: order.status,
        trackingNumber: trackingDrafts[marketplaceOrderKey(order)]?.trim() || order.trackingNumber,
        marketplaceData: order.marketplaceData,
      }));
      const result = await callMarketplaceGateway<GatewayDispatchResult>(gatewayToken, {
        action: 'dispatch', marketplace, orders: gatewayOrders,
        supplyName: `YESI-${new Date().toISOString().slice(0, 10)}`,
      });

      if (marketplace === 'wildberries') {
        const supplyId = typeof result.supplyId === 'string' ? result.supplyId : '';
        if (supplyId && result.attached) {
          await db.transaction('rw', db.orders, async () => {
            for (const order of dispatchSelected) {
              if (order.id === undefined) continue;
              const metadata = readMarketplaceOrderData(order.marketplaceData);
              await db.orders.update(order.id, {
                marketplaceData: JSON.stringify({ ...metadata, wbSupplyId: supplyId }),
                updatedAt: new Date().toISOString(),
              });
            }
          });
          await logAction('MARKETPLACE_WB_SUPPLY_CREATE', `${supplyId}: attached ${dispatchSelected.length} Wildberries order(s)`, user?.displayName || 'System');
          await refreshData();
          setSelectedDispatchIds(new Set());
          setMessage({ type: 'success', text: `Wildberries supply ${supplyId} created and ${dispatchSelected.length} order(s) attached. Confirm the physical handoff before transferring it to delivery.` });
        } else {
          setMessage({
            type: 'warning',
            text: result.message || (supplyId ? `Supply ${supplyId} was created but orders were not attached. Keep the supply ID for manual recovery.` : 'Wildberries did not confirm the supply/order assignment.'),
          });
        }
        return;
      }

      const dispatchResults = Array.isArray(result.results) ? result.results : [];
      let succeeded = 0;
      for (const dispatchResult of dispatchResults) {
        if (!dispatchResult.success || !dispatchResult.marketplaceOrderId) continue;
        const localOrder = dispatchSelected.find((order) => marketplaceOrderKey(order) === dispatchResult.marketplaceOrderId);
        if (!localOrder?.id) continue;
        const updates: Partial<Order> = { status: 'Shipped', updatedAt: new Date().toISOString() };
        if (marketplace === 'yandex-market') {
          updates.trackingNumber = trackingDrafts[marketplaceOrderKey(localOrder)]?.trim() || localOrder.trackingNumber;
        }
        await db.orders.update(localOrder.id, updates);
        succeeded++;
      }
      const failed = dispatchResults.filter((entry) => !entry.success);
      await logAction(
        'MARKETPLACE_TMS_DISPATCH',
        `${marketplace}: ${succeeded} dispatched, ${failed.length} failed`,
        user?.displayName || 'System',
      );
      await refreshData();
      setSelectedDispatchIds(new Set());
      setMessage({
        type: failed.length ? 'warning' : 'success',
        text: `${selectedLabel} dispatch: ${succeeded} accepted, ${failed.length} failed.${failed[0]?.message ? ` First error: ${failed[0].message}` : ''}`,
      });
    } catch (cause) {
      setMessage({ type: 'error', text: cause instanceof Error ? cause.message : 'Marketplace dispatch failed.' });
    } finally {
      setBusy(null);
    }
  };

  const handleDeliverSupply = async (supplyId: string, supplyOrders: Order[]) => {
    if (!window.confirm(`Transfer Wildberries supply ${supplyId} to delivery? Only do this after the physical handoff is complete.`)) return;
    setBusy('deliver');
    setMessage(null);
    try {
      const result = await callMarketplaceGateway<GatewayDispatchResult>(gatewayToken, { action: 'deliver-supply', supplyId });
      if (!result.delivered) throw new Error('Wildberries did not confirm the supply handoff.');
      const now = new Date().toISOString();
      await db.transaction('rw', db.orders, async () => {
        for (const order of supplyOrders) {
          if (order.id !== undefined) await db.orders.update(order.id, { status: 'Shipped', updatedAt: now });
        }
      });
      await logAction('MARKETPLACE_WB_SUPPLY_HANDOFF', `${supplyId}: marked ${supplyOrders.length} order(s) in delivery`, user?.displayName || 'System');
      await refreshData();
      setMessage({ type: 'success', text: `Wildberries supply ${supplyId} transferred to delivery. Local orders marked Shipped.` });
    } catch (cause) {
      setMessage({ type: 'error', text: cause instanceof Error ? cause.message : 'Wildberries supply handoff failed.' });
    } finally {
      setBusy(null);
    }
  };

  const handleSaveMapping = async (row: LocalSkuRow) => {
    const mapping = sanitizeSkuMapping(mappingDrafts[row.sku] || row.mapping);
    const serialized = Object.keys(mapping).length ? JSON.stringify(mapping) : undefined;
    setBusy('mapping');
    try {
      const matchingItems = inventoryItems.filter((item) => item.sku === row.sku && item.id !== undefined);
      await db.transaction('rw', db.inventory, async () => {
        for (const item of matchingItems) await db.inventory.update(item.id!, { marketplaceData: serialized });
      });
      setMappingDrafts((current) => ({ ...current, [row.sku]: mapping }));
      await logAction('MARKETPLACE_SKU_MAPPING', `Updated provider SKU mapping for ${row.sku}`, user?.displayName || 'System');
      await refreshData();
      setMessage({ type: 'success', text: `Marketplace identifiers saved for ${row.sku}.` });
    } catch (cause) {
      setMessage({ type: 'error', text: cause instanceof Error ? cause.message : `Could not save mappings for ${row.sku}.` });
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async () => {
    setBusy('export');
    setMessage(null);
    try {
      const result = await createMarketplaceTrackingExport(marketplace);
      if (result.count === 0) {
        setMessage({ type: 'warning', text: 'No ready or shipped orders with tracking numbers are available to export yet.' });
        return;
      }
      const blob = new Blob([result.content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      await logAction(
        'MARKETPLACE_TMS_EXPORT',
        `${marketplace}: exported ${result.count} tracking update(s)`,
        user?.displayName || 'System',
      );
      setMessage({ type: 'success', text: `Downloaded ${result.count} tracking update(s). This is a local handoff manifest—not a provider API update or verified upload payload.` });
    } catch (cause) {
      setMessage({ type: 'error', text: cause instanceof Error ? cause.message : 'Export failed. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const toggleDispatchOrder = (order: Order) => {
    const key = marketplaceOrderKey(order);
    setSelectedDispatchIds((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const capabilityText = (capability: ApiCapability | undefined) => {
    if (!gatewayConnected) return 'Gateway not connected';
    if (!capability) return 'Not configured';
    return capability.ready ? 'Configured' : `Missing: ${(capability.missing || []).join(', ')}`;
  };
  const readyCapability = (action: 'orders' | 'stock' | 'dispatch') => gatewayConnected && Boolean(capabilities?.[action]?.ready);
  const mappingForSku = (row: LocalSkuRow) => mappingDrafts[row.sku] || row.mapping;

  return (
    <section className="glass-panel space-y-4 rounded-xl border border-accent-sky/15 p-4 sm:p-5" aria-labelledby="marketplace-exchange-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-4 w-4 text-accent-sky" />
            <h2 id="marketplace-exchange-title" className="text-sm font-semibold text-text-primary">Ozon · Yandex Market · Wildberries</h2>
          </div>
          <p className="mt-1 text-xs text-text-secondary">Manual OMS sync, WMS inventory push and provider dispatch through a secured server-side gateway.</p>
        </div>
        <button type="button" onClick={() => void refreshData()} className="rounded-md p-2 text-text-secondary hover:bg-white/5 hover:text-text-primary" aria-label="Refresh marketplace and inventory counts">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="rounded-lg border border-white/[0.08] bg-black/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-accent-sky" />
            <h3 className="text-xs font-semibold text-text-primary">Server-side Marketplace Gateway</h3>
            {gatewayConnected && <span className="rounded-full bg-accent-green/10 px-2 py-0.5 text-[10px] font-medium text-accent-green">Connected</span>}
          </div>
          {gatewayConnected && isAdmin && (
            <button type="button" onClick={disconnectGateway} className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-text-secondary hover:bg-white/5 hover:text-text-primary">
              <Unplug className="h-3 w-3" /> Clear token
            </button>
          )}
        </div>
        {isAdmin ? (
          <>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={gatewayToken}
                onChange={(event) => { setGatewayToken(event.target.value); setGatewayStatus(null); }}
                onKeyDown={(event) => { if (event.key === 'Enter') void connectGateway(); }}
                placeholder="Gateway bearer token (32+ characters)"
                aria-label="Marketplace Gateway bearer token"
                className="min-w-0 flex-1 rounded-md border border-white/[0.1] bg-black/30 px-3 py-2 text-xs text-text-primary outline-none focus:border-accent-sky/50"
              />
              <button type="button" onClick={() => void connectGateway()} disabled={busy !== null || gatewayToken.trim().length < 32} className="rounded-md bg-accent-sky px-3 py-2 text-xs font-semibold text-void disabled:opacity-40">
                {busy === 'connect' ? 'Connecting…' : 'Connect'}
              </button>
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-4 text-text-secondary">
              <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-accent-green" />
              Enter the server gateway token—not a marketplace API key. It stays in this page's memory and is not saved to Dexie or browser storage. Provider API keys belong only in Netlify environment variables.
            </p>
          </>
        ) : (
          <p className="mt-2 text-[10px] text-text-secondary">Live API controls are restricted to the local administrator. File exchange remains available below.</p>
        )}
        {gatewayConnected && (
          <div className="mt-3 grid gap-2 sm:grid-cols-3" aria-label="Server capability status">
            {(['orders', 'stock', 'dispatch'] as const).map((action) => (
              <div key={action} className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-text-primary">{action === 'orders' ? 'OMS orders' : action === 'stock' ? 'WMS stock' : 'TMS dispatch'}</div>
                <div className={`mt-1 break-words text-[10px] ${capabilities?.[action]?.ready ? 'text-accent-green' : 'text-accent-yellow'}`}>{capabilityText(capabilities?.[action])}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Choose marketplace">
        {MARKETPLACES.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={marketplace === item.id}
            onClick={() => { setMarketplace(item.id); setMessage(null); setSelectedDispatchIds(new Set()); setTrackingDrafts({}); }}
            className={`rounded-lg border px-3 py-3 text-left transition-colors ${marketplace === item.id ? 'border-accent-sky/40 bg-accent-sky/10' : 'border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05]'}`}
          >
            <span className={`block text-xs font-semibold ${marketplace === item.id ? 'text-accent-sky' : 'text-text-primary'}`}>{item.label}</span>
            <span className="mt-1 block text-[10px] text-text-secondary">{orders.filter((order) => order.sourceMarketplace === item.id).length.toLocaleString()} local orders</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-3">
        <div className="flex min-w-[110px] items-center gap-2 text-xs text-text-primary"><ShoppingCart className="h-3.5 w-3.5 text-accent-yellow" /> {selectedLabel} OMS</div>
        <ArrowRight className="h-3.5 w-3.5 text-text-secondary" />
        <div className="flex min-w-[86px] items-center gap-2 text-xs text-text-primary"><span className="h-2 w-2 rounded-full bg-accent-green" /> YESI WMS</div>
        <ArrowRight className="h-3.5 w-3.5 text-text-secondary" />
        <div className="flex items-center gap-2 text-xs text-text-primary"><Truck className="h-3.5 w-3.5 text-accent-sky" /> TMS / handoff</div>
        <span className="ml-auto text-[10px] text-text-secondary">{selectedCounts.orders.toLocaleString()} orders · {selectedCounts.tracking.toLocaleString()} tracking-ready</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-3.5 w-3.5 text-accent-sky" />
            <h3 className="text-xs font-semibold text-text-primary">1. OMS · Import live orders</h3>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-text-secondary">Fetch orders from the provider API into the local WMS queue. SKU mappings are applied during import. This is a manual pull, not a background sync.</p>
          <button type="button" disabled={!isAdmin || busy !== null || !readyCapability('orders')} onClick={() => void handleApiOrderSync()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-accent-sky px-3 py-2 text-xs font-semibold text-void disabled:opacity-40">
            <RefreshCw className={`h-3.5 w-3.5 ${busy === 'orders' ? 'animate-spin' : ''}`} />
            {busy === 'orders' ? 'Syncing live orders…' : `Sync ${selectedLabel} orders`}
          </button>
          <p className="mt-2 text-[10px] text-text-secondary">{capabilityText(capabilities?.orders)}</p>
        </div>

        <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="flex items-center gap-2">
            <Boxes className="h-3.5 w-3.5 text-accent-green" />
            <h3 className="text-xs font-semibold text-text-primary">2. WMS · Push available stock</h3>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-text-secondary">Push grouped local SKU balances to the provider's configured warehouse. Active reserved/allocated quantities are excluded; provider identifiers can be maintained below.</p>
          <button type="button" disabled={!isAdmin || busy !== null || !readyCapability('stock')} onClick={() => void handleStockSync()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-accent-green/25 bg-accent-green/10 px-3 py-2 text-xs font-semibold text-accent-green disabled:opacity-40">
            <PackageCheck className="h-3.5 w-3.5" />
            {busy === 'stock' ? 'Pushing stock…' : `Sync ${selectedLabel} stock`}
          </button>
          <p className="mt-2 text-[10px] text-text-secondary">{capabilityText(capabilities?.stock)} · {localSkuRows.length.toLocaleString()} local SKU(s)</p>
        </div>
      </div>

      <details className="rounded-lg border border-white/[0.08] bg-white/[0.02]">
        <summary className="cursor-pointer list-none px-3 py-3 text-xs font-semibold text-text-primary">
          Marketplace SKU / size-ID mappings <span className="ml-1 font-normal text-text-secondary">({localSkuRows.length} local SKU(s))</span>
        </summary>
        <div className="border-t border-white/[0.06] p-3">
          <p className="mb-3 text-[10px] leading-4 text-text-secondary">
            Ozon offer IDs and Yandex seller SKUs default to the local SKU. Wildberries stock needs its numeric chrtId (size ID)—a barcode is not interchangeable. WB order article mapping is separate.
          </p>
          <label className="mb-3 flex items-center gap-2 rounded-md border border-white/[0.08] bg-black/20 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 text-text-secondary" />
            <input value={mappingSearch} onChange={(event) => setMappingSearch(event.target.value)} placeholder="Filter local SKU or product" className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none" aria-label="Filter inventory SKU mappings" />
          </label>
          {uniqueMappingRows.length === 0 ? (
            <p className="py-4 text-center text-xs text-text-secondary">No matching inventory SKUs.</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
              {uniqueMappingRows.slice(0, 250).map((row) => (
                <div key={row.sku} className="grid gap-2 rounded-md border border-white/[0.06] bg-black/10 p-2 sm:grid-cols-[minmax(100px,0.7fr)_minmax(140px,1fr)_minmax(140px,1fr)_auto]">
                  <div className="min-w-0 self-center">
                    <div className="truncate font-mono text-[11px] text-text-primary">{row.sku}</div>
                    <div className="truncate text-[10px] text-text-secondary">{row.product}</div>
                  </div>
                  {MAPPING_FIELDS[marketplace].map((field) => (
                    <label key={field.key} className="text-[9px] text-text-secondary">
                      <span className="mb-1 block">{field.label}</span>
                      <input
                        value={mappingForSku(row)[field.key] || ''}
                        onChange={(event) => setMappingDrafts((current) => ({
                          ...current,
                          [row.sku]: { ...mappingForSku(row), [field.key]: event.target.value },
                        }))}
                        inputMode={field.numeric ? 'numeric' : 'text'}
                        placeholder={field.key === 'ozonOfferId' || field.key === 'yandexSku' ? row.sku : 'Not mapped'}
                        className="w-full rounded border border-white/[0.1] bg-black/30 px-2 py-1.5 text-[10px] text-text-primary outline-none focus:border-accent-sky/50"
                      />
                    </label>
                  ))}
                  <button type="button" disabled={busy !== null} onClick={() => void handleSaveMapping(row)} className="flex items-center justify-center gap-1 self-end rounded border border-white/[0.1] px-2 py-1.5 text-[10px] text-text-secondary hover:text-text-primary disabled:opacity-40" aria-label={`Save marketplace mapping for ${row.sku}`}>
                    <Save className="h-3 w-3" /> Save
                  </button>
                </div>
              ))}
              {uniqueMappingRows.length > 250 && <p className="py-2 text-center text-[10px] text-text-secondary">Showing first 250 matches; filter to find a SKU.</p>}
            </div>
          )}
        </div>
      </details>

      <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Truck className="h-3.5 w-3.5 text-accent-sky" />
              <h3 className="text-xs font-semibold text-text-primary">3. TMS · Dispatch / supply handoff</h3>
            </div>
            <p className="mt-1 text-[11px] leading-5 text-text-secondary">
              Packed or ReadyToShip orders are eligible. Yandex requires genuine tracking and uses a DBS-oriented track-code route; verify your delivery model. WB creates/attaches a supply; physical handoff is a separate confirmed action.
            </p>
          </div>
          <span className="rounded-full border border-white/[0.08] px-2 py-1 text-[10px] text-text-secondary">{dispatchableOrders.length} ready</span>
        </div>
        {!isAdmin && <p className="mt-2 text-[10px] text-text-secondary">Live dispatch controls are admin-only.</p>}
        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="max-h-60 space-y-1 overflow-y-auto rounded-md border border-white/[0.06] bg-black/20 p-2">
            {dispatchableOrders.length === 0 ? (
              <p className="px-2 py-4 text-center text-[10px] text-text-secondary">No {selectedLabel} orders in Packed or ReadyToShip status. Complete WMS picking/packing first.</p>
            ) : dispatchableOrders.slice(0, 100).map((order) => {
              const orderKey = marketplaceOrderKey(order);
              const metadata = readMarketplaceOrderData(order.marketplaceData);
              return (
                <label key={order.orderId} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-white/[0.04]">
                  <input type="checkbox" checked={selectedDispatchIds.has(orderKey)} onChange={() => toggleDispatchOrder(order)} disabled={!isAdmin || busy !== null} className="mt-0.5 accent-sky-400" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 text-[10px] text-text-primary">
                      <span className="font-mono">{orderKey}</span>
                      {metadata.wbSupplyId && <span className="text-accent-yellow">Supply {metadata.wbSupplyId}</span>}
                    </span>
                    <span className="mt-0.5 block truncate text-[9px] text-text-secondary">{order.requiredSkus || 'No SKU mapped'} · {order.trackingNumber ? `Tracking ${order.trackingNumber}` : 'No tracking number'}</span>
                    {marketplace === 'yandex-market' && (
                      <span className="mt-1 block" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="text"
                          aria-label={`Genuine carrier tracking number for ${orderKey}`}
                          value={trackingDrafts[orderKey] ?? order.trackingNumber ?? ''}
                          onChange={(event) => setTrackingDrafts((current) => ({ ...current, [orderKey]: event.target.value }))}
                          onClick={(event) => event.stopPropagation()}
                          placeholder="Enter genuine carrier tracking"
                          disabled={!isAdmin || busy !== null}
                          className="w-full rounded border border-white/[0.1] bg-black/30 px-2 py-1 text-[9px] text-text-primary outline-none focus:border-accent-sky/50 disabled:opacity-50"
                        />
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            {dispatchableOrders.length > 100 && <p className="px-2 py-1 text-[9px] text-text-secondary">Select from the first 100 ready orders; dispatch batches are capped.</p>}
          </div>
          <button type="button" disabled={!isAdmin || busy !== null || !readyCapability('dispatch') || dispatchSelected.length === 0} onClick={() => void handleDispatch()} className="flex min-w-40 items-center justify-center gap-2 self-start rounded-md bg-accent-sky px-3 py-2 text-xs font-semibold text-void disabled:opacity-40">
            <Truck className="h-3.5 w-3.5" />
            {busy === 'dispatch' ? 'Sending…' : marketplace === 'wildberries' ? 'Create WB supply' : 'Dispatch selected'}
          </button>
        </div>
        <p className="mt-2 text-[10px] text-text-secondary">{capabilityText(capabilities?.dispatch)}</p>

        {marketplace === 'wildberries' && wildberriesSupplies.length > 0 && (
          <div className="mt-3 space-y-2 border-t border-white/[0.06] pt-3">
            <h4 className="text-[10px] font-semibold text-text-primary">Open Wildberries supplies</h4>
            {wildberriesSupplies.map((supply) => (
              <div key={supply.supplyId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/[0.06] bg-black/20 px-2.5 py-2">
                <div className="text-[10px] text-text-primary"><span className="font-mono">{supply.supplyId}</span> · {supply.orders.length} order(s)</div>
                <button type="button" disabled={!isAdmin || busy !== null || !readyCapability('dispatch')} onClick={() => void handleDeliverSupply(supply.supplyId, supply.orders)} className="rounded border border-accent-yellow/20 bg-accent-yellow/10 px-2.5 py-1.5 text-[10px] text-accent-yellow disabled:opacity-40">
                  {busy === 'deliver' ? 'Sending…' : 'Confirm physical handoff'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="flex items-center gap-2">
            <FileUp className="h-3.5 w-3.5 text-accent-sky" />
            <h3 className="text-xs font-semibold text-text-primary">File-based OMS import</h3>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-text-secondary">Import marketplace CSV, TSV or JSON exports. Re-import is duplicate-safe; local provider SKU mappings are applied.</p>
          <input ref={fileInputRef} type="file" accept=".csv,.tsv,.txt,.json" onChange={(event) => void handleFileImport(event)} className="hidden" />
          <button type="button" disabled={busy !== null} onClick={() => fileInputRef.current?.click()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-accent-sky/25 bg-accent-sky/10 px-3 py-2 text-xs font-semibold text-accent-sky disabled:opacity-50">
            <FileUp className="h-3.5 w-3.5" />
            {busy === 'import' ? 'Importing…' : `Import ${selectedLabel} file`}
          </button>
          <p className="mt-2 text-[10px] text-text-secondary">Up to 15 MB / 5,000 rows. Manual file workflow remains available if the gateway is offline.</p>
        </div>

        <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="flex items-center gap-2">
            <ArrowDownToLine className="h-3.5 w-3.5 text-accent-green" />
            <h3 className="text-xs font-semibold text-text-primary">Local TMS tracking manifest</h3>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-text-secondary">Prepare a local handoff file for review. It is not sent to a provider and is not guaranteed to match its portal bulk-upload format.</p>
          <button type="button" disabled={busy !== null} onClick={() => void handleExport()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-accent-green/25 bg-accent-green/10 px-3 py-2 text-xs font-semibold text-accent-green disabled:opacity-50">
            <ArrowDownToLine className="h-3.5 w-3.5" />
            {busy === 'export' ? 'Preparing manifest…' : `Download ${selectedLabel} manifest`}
          </button>
          <p className="mt-2 text-[10px] text-text-secondary">{selectedCounts.tracking.toLocaleString()} local order(s) have a tracking number.</p>
        </div>
      </div>

      <div className="rounded-lg border border-accent-yellow/15 bg-accent-yellow/[0.04] p-3 text-[10px] leading-4 text-text-secondary">
        <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-yellow" /><p>Marketplace API calls are real, manual operations. Review stock, warehouse, order status and credentials before running them. No carrier label or live carrier-tracking adapter is configured here. Provider routes and permissions should be confirmed against current official documentation before production use.</p></div>
      </div>

      {message && (
        <div role={message.type === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-md border p-2.5 text-xs ${message.type === 'success' ? 'border-accent-green/20 bg-accent-green/10 text-accent-green' : message.type === 'warning' ? 'border-accent-yellow/20 bg-accent-yellow/10 text-accent-yellow' : 'border-accent-red/20 bg-accent-red/10 text-accent-red'}`}>
          {message.type === 'success' ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}
    </section>
  );
}
