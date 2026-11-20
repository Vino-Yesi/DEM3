import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { db, logAction, type IntegrationEndpoint } from '@/lib/db';
import { useAuth } from '@/lib/auth';
import { useAppStore } from '@/lib/store';
import { runSheetSync } from '@/lib/ozonSheetSync';
import MarketplaceExchange from '@/components/MarketplaceExchange';
import {
  Plug, Server, Cloud, CloudCog, RefreshCw, AlertTriangle,
  CheckCircle, XCircle, Globe, ShoppingCart, Truck, Database,
  Settings, Plus, Activity, Layers,
  Zap, Clock, Ban, X, Play, Pause, Trash2,
  FileText, Wifi, Loader2
} from 'lucide-react';

/* ─── Type helpers ─────────────────────────────────────────── */

type EndpointType = IntegrationEndpoint['type'];
type EndpointStatus = IntegrationEndpoint['status'];
type EndpointAuthType = 'api_key' | 'oauth2' | 'basic';

interface IntegrationConfig { endpoint?: string; authType?: EndpointAuthType }

interface FlowNode {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
  color: string;
}

interface FlowEdge {
  from: string;
  to: string;
  label: string;
  color: string;
  dataType: string;
}

/* ─── Constants ──────────────────────────────────────────── */

const TYPE_ICONS: Record<EndpointType, React.ComponentType<{ className?: string }>> = {
  erp: Database,
  oms: ShoppingCart,
  tms: Truck,
  wms: Server,
  marketplace: Globe,
  carrier: Cloud,
  custom: CloudCog,
};

const TYPE_LABELS: Record<EndpointType, string> = {
  erp: 'ERP',
  oms: 'OMS',
  tms: 'TMS',
  wms: 'WMS',
  marketplace: 'Marketplace',
  carrier: 'Carrier',
  custom: 'Custom',
};

const STATUS_STYLES: Record<EndpointStatus, { dot: string; bg: string; text: string; label: string }> = {
  active:   { dot: 'bg-accent-green',   bg: 'bg-accent-green/10',   text: 'text-accent-green',   label: 'Enabled (manual)' },
  inactive: { dot: 'bg-text-secondary', bg: 'bg-white/5',           text: 'text-text-secondary', label: 'Inactive' },
  error:    { dot: 'bg-accent-red',     bg: 'bg-accent-red/10',     text: 'text-accent-red',     label: 'Error' },
  syncing:  { dot: 'bg-accent-yellow',  bg: 'bg-accent-yellow/10',  text: 'text-accent-yellow',  label: 'Syncing' },
};

/* ─── Component ────────────────────────────────────────────── */

export default function IntegrationHub() {
  const { user } = useAuth();
  const addNotification = useAppStore((s) => s.addNotification);
  const operator = user?.displayName || 'System';

  /* Data */
  const [endpoints, setEndpoints] = useState<IntegrationEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /* Modals */
  const [showAdd, setShowAdd] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [selected, setSelected] = useState<IntegrationEndpoint | null>(null);

  /* Real Ozon Sheets sync state; unsupported connectors are reported honestly. */
  const [syncMessage, setSyncMessage] = useState('');
  const [syncComplete, setSyncComplete] = useState(false);
  const [syncResult, setSyncResult] = useState<'success' | 'warning' | 'error'>('warning');

  /* Form */
  const [form, setForm] = useState({
    name: '',
    type: 'erp' as EndpointType,
    provider: '',
    endpointUrl: '',
    authType: 'api_key' as EndpointAuthType,
    syncInterval: 60,
  });

  /* Load data */
  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await db.integrationEndpoints.toArray();
      setEndpoints(data);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadInitial = async () => {
      try {
        const data = await db.integrationEndpoints.toArray();
        if (!cancelled) setEndpoints(data);
      } catch (error) {
        console.error('Failed to load connector profiles', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadInitial();
    return () => { cancelled = true; };
  }, []);

  /* ─── Stats ─────────────────────────────────────────────── */
  const total = endpoints.length;
  const active = endpoints.filter(e => e.status === 'active').length;
  const errors = endpoints.filter(e => e.status === 'error').length;
  const totalRecordsSynced = endpoints.reduce((s, e) => s + (e.recordsSynced || 0), 0);

  /* ─── Actions ───────────────────────────────────────────── */

  const resetForm = () => {
    setForm({ name: '', type: 'erp', provider: '', endpointUrl: '', authType: 'api_key', syncInterval: 60 });
  };

  const openAdd = () => { setFormError(null); resetForm(); setShowAdd(true); };

  const openEdit = (ep: IntegrationEndpoint) => {
    const cfg = parseConfig(ep.config);
    setFormError(null);
    setForm({
      name: ep.name,
      type: ep.type,
      provider: ep.provider,
      endpointUrl: cfg.endpoint || '',
      authType: cfg.authType || 'api_key',
      syncInterval: ep.syncInterval,
    });
    setSelected(ep);
    setShowEdit(true);
  };

  const parseConfig = (json: string): IntegrationConfig => {
    try {
      const value = JSON.parse(json) as unknown;
      if (!value || typeof value !== 'object') return {};
      const config = value as Record<string, unknown>;
      const authType = config.authType;
      return {
        endpoint: typeof config.endpoint === 'string' ? config.endpoint : '',
        authType: authType === 'oauth2' || authType === 'basic' ? authType : 'api_key',
      };
    } catch { return {}; }
  };

  const validateEndpoint = (value: string): string | null => {
    if (!value.trim()) return null;
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:') return 'Use an HTTPS endpoint. Plain HTTP can expose order data.';
      if (url.username || url.password) return 'Do not put a username or password in the endpoint URL.';
      if ([...url.searchParams.keys()].some((key) => /key|token|secret|password|auth/i.test(key))) {
        return 'Remove API keys or tokens from the URL. This profile is not a secret store.';
      }
      return null;
    } catch { return 'Enter a valid HTTPS URL or leave the endpoint blank.'; }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.provider.trim()) return;
    const endpointError = validateEndpoint(form.endpointUrl);
    if (endpointError) { setFormError(endpointError); return; }
    const config = JSON.stringify({ endpoint: form.endpointUrl.trim(), authType: form.authType });
    const now = new Date().toISOString();
    await db.integrationEndpoints.add({
      name: form.name.trim(),
      type: form.type,
      provider: form.provider.trim(),
      config,
      status: 'inactive',
      lastSync: undefined,
      nextSync: undefined,
      syncInterval: Math.min(1440, Math.max(1, form.syncInterval)),
      recordsSynced: 0,
      errorCount: 0,
      createdAt: now,
    });
    await logAction('INTEGRATION_ADD', `Added connector profile ${form.name.trim()}`, operator);
    setShowAdd(false);
    resetForm();
    load();
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected?.id || !form.name.trim() || !form.provider.trim()) return;
    const endpointError = validateEndpoint(form.endpointUrl);
    if (endpointError) { setFormError(endpointError); return; }
    const config = JSON.stringify({ endpoint: form.endpointUrl.trim(), authType: form.authType });
    await db.integrationEndpoints.update(selected.id, {
      name: form.name.trim(),
      type: form.type,
      provider: form.provider.trim(),
      config,
      syncInterval: Math.min(1440, Math.max(1, form.syncInterval)),
      nextSync: undefined,
    });
    await logAction('INTEGRATION_EDIT', `Edited connector profile ${form.name.trim()}`, operator);
    setShowEdit(false);
    setSelected(null);
    resetForm();
    load();
  };

  const handleToggle = async (ep: IntegrationEndpoint) => {
    if (!ep.id) return;
    const newStatus: EndpointStatus = ep.status === 'active' ? 'inactive' : 'active';
    await db.integrationEndpoints.update(ep.id, { status: newStatus });
    await logAction('INTEGRATION_TOGGLE', `${newStatus === 'active' ? 'Enabled' : 'Disabled'} ${ep.name}`, operator);
    load();
  };

  const handleSyncNow = async (ep: IntegrationEndpoint) => {
    if (!ep.id) return;
    setSelected(ep);
    setSyncMessage('Checking the configured connector…');
    setSyncComplete(false);
    setSyncResult('warning');
    setShowSync(true);

    const isOzon = ep.provider.toLowerCase().includes('ozon') || ep.name.toLowerCase().includes('ozon');
    if (!isOzon) {
      setSyncMessage('This saved connector profile is not bound to a provider adapter. Use the Marketplace Exchange above for configured live API actions or the file workflow. No records were changed.');
      setSyncComplete(true);
      setSyncResult('warning');
      return;
    }

    const config = (await db.sheetSyncConfigs.toArray())[0];
    if (!config) {
      setSyncMessage('Ozon Sheets is not configured yet. Open Ozon Sheets from the sidebar to set up an import source.');
      setSyncComplete(true);
      setSyncResult('warning');
      return;
    }
    if (config.fetchMethod === 'api') {
      setSyncMessage('This sheet is configured for API-key mode, but Integration Hub does not hold API keys. Open Ozon Sheets and run a manual API sync there. No records were changed.');
      setSyncComplete(true);
      setSyncResult('warning');
      return;
    }

    try {
      await db.integrationEndpoints.update(ep.id, { status: 'syncing', lastError: undefined });
      await load();
      setSyncMessage('Reading Ozon order rows from the configured sheet…');
      const result = await runSheetSync(config, operator);
      const recordsAdded = result.imported + result.updated;
      const syncDetail = `+${result.imported} new, ~${result.updated} updated`;
      const now = new Date().toISOString();
      await db.integrationEndpoints.update(ep.id, {
        status: result.errors.length ? 'error' : ep.status === 'active' ? 'active' : 'inactive',
        lastSync: now,
        nextSync: undefined,
        recordsSynced: (ep.recordsSynced || 0) + recordsAdded,
        errorCount: (ep.errorCount || 0) + result.errors.length,
        lastError: result.errors[0],
      });
      await logAction('INTEGRATION_SYNC', `Ozon Sheets ${ep.name} — ${syncDetail}`, operator);
      addNotification({ title: 'Ozon Sheet Sync', message: syncDetail, type: result.errors.length ? 'warning' : 'success' });
      setSyncMessage(`Sync complete: ${syncDetail}${result.errors.length ? ` · ${result.errors.length} row error(s)` : ''}.`);
      setSyncResult(result.errors.length ? 'warning' : 'success');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Sheet sync failed';
      await db.integrationEndpoints.update(ep.id, {
        status: 'error',
        lastSync: new Date().toISOString(),
        lastError: message,
        errorCount: (ep.errorCount || 0) + 1,
      });
      addNotification({ title: 'Ozon Sync Failed', message, type: 'error' });
      setSyncMessage(message);
      setSyncResult('error');
    } finally {
      setSyncComplete(true);
      await load();
    }
  };

  const closeSync = () => setShowSync(false);

  const handleViewLogs = async (ep: IntegrationEndpoint) => {
    setSelected(ep);
    setShowLogs(true);
  };

  const handleClearErrors = async () => {
    for (const ep of endpoints) {
      if (ep.id && ep.status === 'error') {
        await db.integrationEndpoints.update(ep.id, { status: 'inactive', lastError: undefined, errorCount: 0 });
      }
    }
    await logAction('INTEGRATION_CLEAR_ERRORS', 'Cleared all integration errors', operator);
    load();
  };

  const handleDelete = async (ep: IntegrationEndpoint) => {
    if (!ep.id) return;
    if (!confirm(`Delete integration "${ep.name}"? This cannot be undone.`)) return;
    await db.integrationEndpoints.delete(ep.id);
    await logAction('INTEGRATION_DELETE', `Deleted ${ep.name}`, operator);
    load();
  };

  /* ─── Flow Visualizer Data ──────────────────────────────── */
  const flowNodes: FlowNode[] = [
    { id: 'erp', label: 'ERP', icon: Database, count: endpoints.filter(e => e.type === 'erp').reduce((s, e) => s + e.recordsSynced, 0), color: 'text-accent-sky' },
    { id: 'wms', label: 'WMS', icon: Server, count: totalRecordsSynced, color: 'text-accent-green' },
    { id: 'oms', label: 'OMS', icon: ShoppingCart, count: endpoints.filter(e => e.type === 'oms').reduce((s, e) => s + e.recordsSynced, 0), color: 'text-accent-yellow' },
    { id: 'tms', label: 'TMS', icon: Truck, count: endpoints.filter(e => e.type === 'tms').reduce((s, e) => s + e.recordsSynced, 0), color: 'text-accent-sky' },
    { id: 'customer', label: 'Customer', icon: Globe, count: 0, color: 'text-text-primary' },
  ];

  const flowEdges: FlowEdge[] = [
    { from: 'erp', to: 'wms', label: 'Inv + POs', color: 'border-accent-sky', dataType: 'inventory' },
    { from: 'wms', to: 'oms', label: 'Orders', color: 'border-accent-yellow', dataType: 'orders' },
    { from: 'oms', to: 'tms', label: 'Shipments', color: 'border-accent-green', dataType: 'shipping' },
    { from: 'tms', to: 'customer', label: 'Tracking', color: 'border-accent-sky', dataType: 'tracking' },
  ];

  const errorEndpoints = endpoints.filter(e => e.lastError || e.status === 'error');

  /* ─── Render ────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-text-primary">Integration Hub</h1>
            <span className="rounded-full border border-accent-yellow/20 bg-accent-yellow/10 px-2 py-0.5 text-[10px] font-medium text-accent-yellow">Manual only</span>
          </div>
          <p className="text-sm text-text-secondary mt-1">
            Saved profiles are not live connections. Ozon Sheets supports on-demand import; Ozon, Yandex Market and Wildberries use local files.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className={`p-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-text-secondary hover:text-text-primary transition-all ${refreshing ? 'animate-spin' : ''}`}
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={openAdd}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent-sky text-void font-semibold text-xs hover:opacity-90 transition-all"
          >
            <Plus className="w-4 h-4" />
            Add Integration
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { label: 'Total Integrations', value: total, icon: Plug, color: 'text-text-primary', delay: 0 },
          { label: 'Enabled Profiles', value: active, icon: Wifi, color: 'text-accent-green', delay: 0.05 },
          { label: 'Sync Errors', value: errors, icon: AlertTriangle, color: 'text-accent-red', alert: errors > 0, delay: 0.1 },
          { label: 'Records Imported / Updated', value: totalRecordsSynced.toLocaleString(), icon: Database, color: 'text-accent-sky', delay: 0.15 },
          { label: 'Sync Mode', value: 'On demand', icon: Clock, color: 'text-accent-yellow', delay: 0.2 },
        ].map((kpi) => (
          <motion.div
            key={kpi.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: kpi.delay, duration: 0.3 }}
            className="glass-panel rounded-lg p-4"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-text-secondary uppercase tracking-widest">{kpi.label}</span>
              <kpi.icon className={`w-4 h-4 ${kpi.color}`} />
            </div>
            <div className={`text-2xl font-bold ${kpi.alert ? 'text-accent-red' : 'text-text-primary'}`}>
              {kpi.value}
            </div>
            {kpi.label === 'Sync Errors' && errors > 0 && (
              <div className="mt-1.5 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-red animate-pulse" />
                <span className="text-[10px] text-accent-red">Requires attention</span>
              </div>
            )}
          </motion.div>
        ))}
      </div>

      <MarketplaceExchange />

      {/* Data Flow Visualizer */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, duration: 0.3 }}
        className="glass-panel rounded-lg p-5"
      >
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-4 h-4 text-accent-sky" />
          <h3 className="text-sm font-semibold text-text-primary">Data Flow Visualizer</h3>
          <span className="ml-auto text-[10px] text-text-secondary">Local workflow map</span>
        </div>

        <div className="flex flex-col lg:flex-row items-center justify-center gap-2 lg:gap-0 py-4">
          {flowNodes.map((node, idx) => (
            <div key={node.id} className="flex items-center gap-2 lg:gap-0">
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.3 + idx * 0.1 }}
                className="relative flex flex-col items-center gap-1 px-4 py-3 rounded-lg bg-white/[0.03] border border-white/[0.08] min-w-[100px]"
              >
                <node.icon className={`w-5 h-5 ${node.color}`} />
                <span className="text-[10px] font-semibold text-text-primary">{node.label}</span>
                {node.count > 0 && (
                  <span className="text-[9px] text-text-secondary font-mono">{node.count.toLocaleString()}</span>
                )}
                {node.id === 'wms' && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-accent-green animate-pulse" />
                )}
              </motion.div>

              {idx < flowNodes.length - 1 && (
                <div className="flex flex-col items-center mx-2 lg:mx-4">
                  <div className={`relative w-8 lg:w-16 h-0 border-t-2 ${flowEdges[idx]?.color || 'border-white/10'} border-dashed`}>
                    <motion.div
                      animate={{ x: [0, 32, 0] }}
                      transition={{ repeat: Infinity, duration: 2, ease: 'linear' }}
                      className="absolute top-[-3px] left-0 w-1.5 h-1.5 rounded-full bg-accent-sky"
                    />
                  </div>
                  <span className="text-[9px] text-text-secondary mt-1">{flowEdges[idx]?.label}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center justify-center gap-4 mt-3 pt-3 border-t border-white/[0.06]">
          {[
            { label: 'Inventory / POs', color: 'bg-accent-sky' },
            { label: 'Orders', color: 'bg-accent-yellow' },
            { label: 'Shipping', color: 'bg-accent-green' },
          ].map(item => (
            <div key={item.label} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${item.color}`} />
              <span className="text-[10px] text-text-secondary">{item.label}</span>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Connected Systems Grid */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.3 }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-accent-sky" />
            <h3 className="text-sm font-semibold text-text-primary">Saved Connector Profiles</h3>
          </div>
          <span className="text-[10px] text-text-secondary">{active} enabled · {errors} sync errors</span>
        </div>

        {loading ? (
          <div className="glass-panel rounded-lg p-8 text-center">
            <Loader2 className="w-6 h-6 animate-spin text-accent-sky mx-auto mb-2" />
            <p className="text-xs text-text-secondary">Loading integrations…</p>
          </div>
        ) : endpoints.length === 0 ? (
          <div className="glass-panel rounded-lg p-8 text-center">
            <Plug className="w-8 h-8 text-text-secondary mx-auto mb-3" />
            <p className="text-sm text-text-primary font-medium">No integrations configured</p>
            <p className="text-xs text-text-secondary mt-1">Add a manual profile, or use the Marketplace Exchange above for configured live adapters and file workflows.</p>
            <button onClick={openAdd} className="mt-4 px-4 py-2 rounded-lg bg-accent-sky text-void text-xs font-semibold hover:opacity-90">
              Add Integration
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <AnimatePresence>
              {endpoints.map((ep, i) => {
                const TypeIcon = TYPE_ICONS[ep.type];
                const status = STATUS_STYLES[ep.status];
                return (
                  <motion.div
                    key={ep.id}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ delay: i * 0.04, duration: 0.25 }}
                    className="glass-panel rounded-lg p-4 hover:border-white/10 transition-all border border-transparent"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${status.bg}`}>
                          <TypeIcon className={`w-4 h-4 ${status.text}`} />
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-text-primary">{ep.name}</p>
                          <p className="text-[10px] text-text-secondary">{ep.provider} · {TYPE_LABELS[ep.type]}</p>
                        </div>
                      </div>
                      <span className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full ${status.bg} ${status.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${status.dot} ${ep.status === 'syncing' ? 'animate-pulse' : ''}`} />
                        {status.label}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div className="bg-white/[0.02] rounded-md p-2 text-center">
                        <p className="text-[10px] text-text-secondary">Records</p>
                        <p className="text-xs font-bold text-text-primary font-mono">{(ep.recordsSynced || 0).toLocaleString()}</p>
                      </div>
                      <div className="bg-white/[0.02] rounded-md p-2 text-center">
                        <p className="text-[10px] text-text-secondary">Errors</p>
                        <p className={`text-xs font-bold font-mono ${ep.errorCount > 0 ? 'text-accent-red' : 'text-text-primary'}`}>{ep.errorCount || 0}</p>
                      </div>
                      <div className="bg-white/[0.02] rounded-md p-2 text-center">
                        <p className="text-[10px] text-text-secondary">Run mode</p>
                        <p className="text-xs font-bold text-text-primary font-mono">Manual</p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-text-secondary mb-3">
                      <span>Last: {ep.lastSync ? new Date(ep.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Never'}</span>
                      <span>Next: Manual</span>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleSyncNow(ep)}
                        disabled={ep.status === 'syncing'}
                        className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-text-primary text-[10px] font-medium transition-all disabled:opacity-50"
                      >
                        {ep.status === 'syncing' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                        Sync Now
                      </button>
                      <button
                        onClick={() => openEdit(ep)}
                        className="px-2 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-text-secondary hover:text-text-primary transition-all"
                        title="Edit Config"
                      >
                        <Settings className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => handleViewLogs(ep)}
                        className="px-2 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-text-secondary hover:text-text-primary transition-all"
                        title="View Logs"
                      >
                        <FileText className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => handleToggle(ep)}
                        className={`px-2 py-1.5 rounded-md transition-all ${ep.status === 'active' ? 'bg-accent-green/10 text-accent-green hover:bg-accent-green/20' : 'bg-white/[0.04] text-text-secondary hover:bg-white/[0.08]'}`}
                        title={ep.status === 'active' ? 'Disable saved profile' : 'Enable saved profile'}
                      >
                        {ep.status === 'active' ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                      </button>
                      <button
                        onClick={() => handleDelete(ep)}
                        className="px-2 py-1.5 rounded-md bg-white/[0.04] hover:bg-accent-red/10 text-text-secondary hover:text-accent-red transition-all"
                        title="Delete"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </motion.div>

      {/* Error Log Panel */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.3 }}
        className="glass-panel rounded-lg p-5"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-accent-red" />
            <h3 className="text-sm font-semibold text-text-primary">Error Log</h3>
            {errorEndpoints.length > 0 && (
              <span className="text-[10px] bg-accent-red/20 text-accent-red px-2 py-0.5 rounded-full">{errorEndpoints.length} issues</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {errorEndpoints.length > 0 && (
              <>
                <button
                  onClick={handleClearErrors}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-white/[0.04] hover:bg-accent-red/10 text-text-secondary hover:text-accent-red text-[10px] transition-all"
                >
                  <Ban className="w-3 h-3" />
                  Dismiss All
                </button>
              </>
            )}
          </div>
        </div>

        {errorEndpoints.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-text-secondary">
            <CheckCircle className="w-4 h-4 text-accent-green" />
            <span className="text-xs">No stored connector errors</span>
          </div>
        ) : (
          <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
            {errorEndpoints.map((ep) => (
              <motion.div
                key={ep.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-center gap-3 p-3 bg-accent-red/5 border border-accent-red/10 rounded-md"
              >
                <div className="w-8 h-8 rounded-lg bg-accent-red/10 flex items-center justify-center shrink-0">
                  <XCircle className="w-4 h-4 text-accent-red" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-text-primary">{ep.name}</span>
                    <span className="text-[10px] text-text-secondary">{ep.provider}</span>
                  </div>
                  <p className="text-[10px] text-accent-red mt-0.5 truncate">{ep.lastError || 'Unknown error'}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[10px] text-text-secondary mt-0.5">Failures: {ep.errorCount || 0}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleSyncNow(ep)}
                  disabled={ep.status === 'syncing'}
                  className="px-2 py-1 rounded-md bg-white/[0.06] text-text-primary text-[10px] font-medium hover:bg-white/[0.1] transition-all disabled:opacity-50"
                >
                  Try sync
                </button>
              </motion.div>
            ))}
          </div>
        )}
      </motion.div>

      {/* ─── Modals ─────────────────────────────────────────── */}

      <AnimatePresence>
        {/* Add Integration Modal */}
        {showAdd && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          >
            <motion.div
              initial={{ scale: 0.95, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 10 }}
              className="glass-panel rounded-lg p-5 w-full max-w-md border border-white/[0.12]"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-text-primary">Add New Integration</h3>
                <button onClick={() => setShowAdd(false)} className="p-1 rounded-md hover:bg-white/[0.06] text-text-secondary">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <form onSubmit={handleAdd} className="space-y-3">
                <div>
                  <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Name</label>
                  <input
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                    placeholder="e.g. Shopify OMS"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Type</label>
                    <select
                      value={form.type}
                      onChange={e => setForm(f => ({ ...f, type: e.target.value as EndpointType }))}
                      className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                    >
                      {Object.entries(TYPE_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Provider</label>
                    <input
                      value={form.provider}
                      onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}
                      className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                      placeholder="e.g. Shopify"
                      required
                    />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Endpoint URL</label>
                  <input
                    value={form.endpointUrl}
                    onChange={e => { setForm(f => ({ ...f, endpointUrl: e.target.value })); setFormError(null); }}
                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                    placeholder="https://api.example.com/v1"
                  />
                </div>
                <p className="text-[10px] leading-4 text-text-secondary">This saves connector details only. Do not paste API secrets here; live sync credentials belong in a secure server-side connector.</p>
                {formError && <p role="alert" className="text-[10px] text-accent-red">{formError}</p>}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Auth Type</label>
                    <select
                      value={form.authType}
                      onChange={e => setForm(f => ({ ...f, authType: e.target.value as EndpointAuthType }))}
                      className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                    >
                      <option value="api_key">API Key</option>
                      <option value="oauth2">OAuth2</option>
                      <option value="basic">Basic Auth</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Sync Interval (min)</label>
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={form.syncInterval}
                      onChange={e => setForm(f => ({ ...f, syncInterval: parseInt(e.target.value) || 60 }))}
                      className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAdd(false)}
                    className="px-3 py-2 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-white/[0.04] transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-md bg-accent-sky text-void text-xs font-semibold hover:opacity-90 transition-all"
                  >
                    Save Integration
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}

        {/* Edit Integration Modal */}
        {showEdit && selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          >
            <motion.div
              initial={{ scale: 0.95, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 10 }}
              className="glass-panel rounded-lg p-5 w-full max-w-md border border-white/[0.12]"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-text-primary">Edit Integration</h3>
                <button onClick={() => setShowEdit(false)} className="p-1 rounded-md hover:bg-white/[0.06] text-text-secondary">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <form onSubmit={handleEdit} className="space-y-3">
                <div>
                  <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Name</label>
                  <input
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Type</label>
                    <select
                      value={form.type}
                      onChange={e => setForm(f => ({ ...f, type: e.target.value as EndpointType }))}
                      className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                    >
                      {Object.entries(TYPE_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Provider</label>
                    <input
                      value={form.provider}
                      onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}
                      className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                      required
                    />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Endpoint URL</label>
                  <input
                    value={form.endpointUrl}
                    onChange={e => { setForm(f => ({ ...f, endpointUrl: e.target.value })); setFormError(null); }}
                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                  />
                </div>
                <p className="text-[10px] leading-4 text-text-secondary">This saves connector details only. Do not paste API secrets here; live sync credentials belong in a secure server-side connector.</p>
                {formError && <p role="alert" className="text-[10px] text-accent-red">{formError}</p>}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Auth Type</label>
                    <select
                      value={form.authType}
                      onChange={e => setForm(f => ({ ...f, authType: e.target.value as EndpointAuthType }))}
                      className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                    >
                      <option value="api_key">API Key</option>
                      <option value="oauth2">OAuth2</option>
                      <option value="basic">Basic Auth</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-text-secondary uppercase tracking-wider mb-1 block">Sync Interval (min)</label>
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={form.syncInterval}
                      onChange={e => setForm(f => ({ ...f, syncInterval: parseInt(e.target.value) || 60 }))}
                      className="w-full bg-white/[0.03] border border-white/[0.08] rounded-md text-xs text-text-primary px-3 py-2 focus:outline-none focus:border-accent-sky/50"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowEdit(false)}
                    className="px-3 py-2 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-white/[0.04] transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-md bg-accent-sky text-void text-xs font-semibold hover:opacity-90 transition-all"
                  >
                    Save Changes
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}

        {/* Sync outcome modal */}
        {showSync && selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          >
            <motion.div
              initial={{ scale: 0.95, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 10 }}
              className="glass-panel w-full max-w-md rounded-lg border border-white/[0.12] p-5"
            >
              <div className="flex items-center gap-3">
                {!syncComplete ? <Loader2 className="h-5 w-5 animate-spin text-accent-sky" /> :
                  syncResult === 'success' ? <CheckCircle className="h-5 w-5 text-accent-green" /> :
                    <AlertTriangle className={`h-5 w-5 ${syncResult === 'error' ? 'text-accent-red' : 'text-accent-yellow'}`} />}
                <div>
                  <h3 className="text-sm font-bold text-text-primary">{syncComplete ? 'Sync result' : `Syncing ${selected.name}`}</h3>
                  <p className="mt-0.5 text-[10px] text-text-secondary">{selected.provider} · {TYPE_LABELS[selected.type]}</p>
                </div>
              </div>
              <p role={syncResult === 'error' ? 'alert' : 'status'} className="mt-4 rounded-md border border-white/[0.08] bg-white/[0.03] p-3 text-xs leading-5 text-text-secondary">
                {syncMessage}
              </p>
              <p className="mt-3 text-[10px] leading-5 text-text-secondary">
                Saved connector profiles do not execute APIs. Use the Marketplace Exchange above for the secured manual provider adapters; Ozon Sheets sync is separate, and carrier labels/tracking are not live here.
              </p>
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={closeSync}
                  disabled={!syncComplete}
                  className="rounded-md bg-accent-sky px-4 py-2 text-xs font-semibold text-void disabled:opacity-50"
                >
                  {syncComplete ? 'Close' : 'Working…'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {/* View Logs Modal */}
        {showLogs && selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          >
            <motion.div
              initial={{ scale: 0.95, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 10 }}
              className="glass-panel rounded-lg p-5 w-full max-w-lg border border-white/[0.12]"
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-bold text-text-primary">Integration Logs</h3>
                  <p className="text-[10px] text-text-secondary mt-0.5">{selected.name} · {selected.provider}</p>
                </div>
                <button onClick={() => setShowLogs(false)} className="p-1 rounded-md hover:bg-white/[0.06] text-text-secondary">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                {selected.lastSync && (
                  <div className="flex items-start gap-3 p-2.5 bg-white/[0.02] rounded-md border border-white/[0.04]">
                    {selected.lastError
                      ? <XCircle className="w-3.5 h-3.5 text-accent-red shrink-0 mt-0.5" />
                      : <CheckCircle className="w-3.5 h-3.5 text-accent-green shrink-0 mt-0.5" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-text-primary">{selected.lastError ? 'Last sync attempt failed' : 'Last sync attempt'}</p>
                      <p className="text-[10px] text-text-secondary">{selected.recordsSynced?.toLocaleString() || 0} total records imported or updated</p>
                    </div>
                    <span className="text-[10px] text-text-secondary font-mono shrink-0">{new Date(selected.lastSync).toLocaleTimeString()}</span>
                  </div>
                )}
                {selected.lastError && (
                  <div className="flex items-start gap-3 p-2.5 bg-accent-red/5 rounded-md border border-accent-red/10">
                    <XCircle className="w-3.5 h-3.5 text-accent-red shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-accent-red">Sync failed</p>
                      <p className="text-[10px] text-text-secondary">{selected.lastError}</p>
                    </div>
                    <span className="text-[10px] text-text-secondary font-mono shrink-0">{selected.lastSync ? new Date(selected.lastSync).toLocaleTimeString() : '—'}</span>
                  </div>
                )}
                <div className="flex items-start gap-3 p-2.5 bg-white/[0.02] rounded-md border border-white/[0.04]">
                  <Zap className="w-3.5 h-3.5 text-accent-yellow shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-text-primary">Saved profile — not a live connection</p>
                    <p className="text-[10px] text-text-secondary">Auth method: {parseConfig(selected.config).authType || 'api_key'} · no secret stored</p>
                  </div>
                  <span className="text-[10px] text-text-secondary font-mono shrink-0">{new Date(selected.createdAt).toLocaleTimeString()}</span>
                </div>
                {selected.errorCount > 0 && (
                  <div className="flex items-start gap-3 p-2.5 bg-accent-yellow/5 rounded-md border border-accent-yellow/10">
                    <AlertTriangle className="w-3.5 h-3.5 text-accent-yellow shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-text-primary">Multiple errors detected</p>
                      <p className="text-[10px] text-text-secondary">Total errors: {selected.errorCount}</p>
                    </div>
                  </div>
                )}
                {!selected.lastSync && !selected.lastError && (
                  <p className="text-xs text-text-secondary text-center py-4">No logs available yet</p>
                )}
              </div>

              <div className="flex items-center justify-end pt-3 mt-3 border-t border-white/[0.06]">
                <button
                  onClick={() => setShowLogs(false)}
                  className="px-4 py-2 rounded-md bg-white/[0.04] text-text-primary text-xs font-medium hover:bg-white/[0.08] transition-all"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
