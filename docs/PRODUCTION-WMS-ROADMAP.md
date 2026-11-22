# Production WMS Executive Roadmap

## Executive decision

YESI-FULFILLMENT has a useful operator workflow and an unusually practical offline-first
starting point, but it is not yet a production-grade real-time WMS. The core decision is
**to evolve the existing application into a controlled, auditable integration platform**
rather than replacing it immediately or adding more dashboard features.

The proposed target is:

- **ERP**: system of record for purchasing, financials, item master, and replenishment;
- **OMS**: system of record for orders, fulfillment states, cancellations, and returns;
- **WMS**: system of record for physical stock, locations, lot/serial numbers, moves, and tasks;
- **TMS**: system of record for carriers, routes, manifests, labels, bookings, and tracking;
- **Marketplace adapters**: independently deployed source adapters for Ozon, Yandex Market,
  and Wildberries;
- **Operators**: PWA/Tauri clients that remain usable during network loss and synchronize
  through the server.

The current IndexedDB database must become an offline operational cache and event journal,
not the global source of truth.

## Skeptical executive review

### Why the idea can work

- It covers the complete physical workflow: receiving, putaway, inventory, allocation,
  picking, packing, shipping, serial tracking, cycle counting, and returns.
- The PWA/Tauri strategy is sensible for barcode-heavy Windows and mobile operators.
- The marketplace gateway already keeps Ozon, Yandex, and Wildberries credentials out of the
  browser.
- Provider mappings and normalized order models already exist, so duplication can be
  avoided.
- The code explicitly separates synthetic seed inventory from verified stock and blocks
  synthetic tracking numbers for marketplace orders.
- Reservation and movement concepts exist, which is stronger than an order-only inventory UI.

### Why it may fail

1. **Local database is not a distributed ledger.** IndexedDB can reconcile stale tabs, but
   it cannot enforce atomic inventory across devices or sites. Two warehouses or two
   operators can oversell if both use browser copies as authoritative state.
2. **Authentication is only suitable for a trusted single-device prototype.** Password
   hashes and idle sessions are client-side, while the gateway uses one shared bearer
   token. Any holder can invoke every configured provider capability.
3. **No durable integration event contract exists.** Pull/sync actions are direct calls
   without an outbox, idempotency key, dead-letter queue, replay, or provider event audit.
4. **Manual refresh is not real time.** There is no webhook receiver, event stream,
   server push, distributed cache, or authoritative sync protocol.
5. **Write actions are not fully protected.** There is no approval workflow, two-person
   check, immutable inventory ledger, or provider write compensation record.
6. **The stock model is not warehouse-scale.** A single location and aggregate SKU stock
   are insufficient for bin capacity, lot/serial FEFO, unit of measure, catch weight,
   quarantine, multi-site replenishment, or exact on-hand/allocated/available states.
7. **Carrier TMS remains a demo.** Local demo labels are intentionally not carrier
   bookings. Real carrier credentials, address validation, label cancellation, tracking
   webhooks, and service retry behavior are missing.
8. **Synthetic seed data can pollute operations.** Any deployment must fail closed until
   inventory is replaced or explicitly reconciled from counted or inbound stock.
9. **Provider API schemas are a moving target.** The repository adapters are useful
   prototypes, but live sandbox certification is mandatory for statuses, stock semantics,
   dispatch transitions, API quotas, and account configuration.
10. **"Realtime" is not equal to "immediate".** The system should target measurable event
    latency, durability, and reconciliation windows, not broadcast every UI state.

## System boundary

```text
Marketplace APIs          ERP / PIM / Finance
 Ozon / Yandex / WB             |
         |                      |
         v                      v
+----------------+     provider adapters
| Integration      |<-------------------+
| Control Plane    |                    |
+--------+---------+                    |
         | normalized events            |
         v                              |
+----------------+    commands/events   |
| OMS / Order     +--------------------+
| Orchestrator    |
+--------+---------+
         |
         v
+----------------+<---- ERP/UOM/location master
| WMS Core       |
| stock/tasks    |
+--------+---------+
         |
         v
+----------------+
| TMS / Carrier  |
+----------------+
         |
         v
Operators / PWA / Tauri / handheld / API
```

## Non-negotiable invariants

1. Never decrement physical stock without an immutable `inventory_movement` entry.
2. Never reserve, allocate, pick, or ship stock that is not available after reservations.
3. Never execute an external write twice. Every provider command has an idempotency key.
4. Never mark an order shipped in the WMS until provider/carrier evidence is accepted.
5. Never trust client role claims or browser state for authorization.
6. Never store provider secrets or ERP credentials in browser storage.
7. Never use a barcode, offer ID, article, NM ID, or GTIN interchangeably with a provider
   size ID. Each identifier has a typed mapping.
8. Never allow synthetic inventory or synthetic labels to be used for production writes.
9. Every state transition is append-only and attributable to user, device, integration,
   reason, and timestamp.
10. Every integration is replayable, rate-limited, monitored, and fails into a visible
    quarantine state rather than silently dropping work.

## Real-time architecture

### Authoritative services

- **Identity service**: OIDC/OAuth2, MFA, SSO, short-lived access tokens, rotating refresh
  tokens, device identity, and RBAC/ABAC.
- **OMS service**: provider order canonicalization, state machine, cancellation, SLA,
  customer promise, and WMS command creation.
- **WMS service**: inventory ledger, lot/serial balance, reservation, receiving, putaway,
  picking, packing, cycle count, and movement audit.
- **Integration service**: provider credentials via a secret manager, webhook verification,
  command queue, retry, idempotency, reconciliation, and provider audit log.
- **TMS service**: carrier rating, address validation, booking, label retrieval,
  cancellation, manifest, and carrier event ingestion.
- **ERP connector**: item/location/UOM master, purchase/transfer/receipt confirmation,
  cost, and financial posting boundaries.

### Event backbone

Use a durable broker or managed queue for at least:

- `order.received`
- `order.cancelled`
- `order.fulfillment_requested`
- `inventory.reserved`
- `inventory.reservation_released`
- `inventory.received`
- `inventory.adjusted`
- `pick.started`
- `pick.completed`
- `pack.completed`
- `shipment.booked`
- `shipment.dispatched`
- `shipment.tracking_updated`
- `provider.command_failed`

Use inbox/outbox tables or equivalent transactional event records. Commands should carry:

- a stable event ID;
- an idempotency key;
- provider or tenant ID;
- warehouse/location ID;
- source model and source revision;
- correlation and causation IDs;
- occurred-at and attempted-at timestamps;
- typed payload version.

### Realtime client behavior

- Server-sent events or WebSockets are appropriate for push; polling is a fallback.
- Clients receive tenant-scoped mutations and refresh their local cache.
- A service worker queues user-confirmed writes with an out-of-box event journal.
- On reconnect, the client submits pending events once, receives server versions, and
  applies conflict resolution. Conflicting inventory and shipment actions are never
  silently last-write-wins.
- Acknowledge UI actions only after server/WMS acceptance, while preserving `pending`,
  `accepted`, `confirmed`, and `failed` states separately.

## Integration configuration

### Marketplace tenants

The existing shared environment variables should become tenant records in an encrypted
configuration store. Each tenant needs:

- one marketplace account ID;
- one marketplace-specific credential reference;
- warehouse, campaign, business, partner, and/or supply mappings;
- SKU crosswalk version;
- enabled capabilities;
- API quota and polling policy;
- write mode: disabled, approval-required, or automatic;
- webhook secret and certificate;
- alert contacts and escalation policy;
- last reconciled cursor and provider checksum.

No API key belongs in a connector profile, Dexie, URL, log, or client environment variable.

### Recommended workflow

1. Receive provider webhook or poll missed changes.
2. Verify signature and provider tenant.
3. Normalize and validate the order.
4. Deduplicate by provider + provider order ID.
5. Create or update OMS order.
6. Reserve WMS stock if service level and ATP permit.
7. Generate WMS tasks.
8. On pack completion, create the provider dispatch command.
9. Execute the command through the outbox.
10. Store provider response and receipt identifier.
11. Update OMS/WMS/TMS states only from confirmed events.
12. Reconcile provider state on schedule and after every provider outage.

## Marketplace-specific requirements

### Ozon

- Certify FBS posting status transitions and warehouse stock semantics.
- Confirm `quant_size`, product ID, offer ID, stock warehouse, and available quantity rules.
- Keep posting number distinct from internal order ID and provider order ID.
- Support webhook/poll fallback and posting cancellation.
- Validate that FBS labels and awaiting-delivery transitions are performed in the account's
  required order.

### Yandex Market

- Confirm the business/campaign fulfillment model and official order route for the account.
- Keep business ID, campaign ID, partner warehouse ID, and delivery service ID separate.
- Reject tracking codes that are not accepted by the configured carrier/delivery model.
- Validate whether tracking/status calls apply to DBS or FBS and gate unsupported flows.
- Certify the deprecation and replacement route before the provider shutdown date.

### Wildberries

- Keep supplier article separate from NM ID and `chrtId`.
- Never derive `chrtId` from an EAN barcode.
- Enforce supply size limits and legal attach/detach rules.
- Separate supply creation, attachment, handoff, and delivery confirmation.
- Reconcile assembly order status by numeric provider ID and supply state.

## ERP/TMS/OMS boundaries

### ERP

Pull item master, UOM conversions, supplier master, purchase orders, transfers, cost,
substitution rules, and accounting dimensions. Push confirmed receipts, adjustments,
returns, shipment costs, and inventory valuation only through an approved posting interface.

### OMS

Own promise, cancellations, split orders, substitutions, routing, marketplace mapping,
backorders, returns, and customer-facing status. WMS tasks must be derived from an OMS
immutable allocation or request.

### TMS

Own carrier selection, route planning, dock appointment, load, dispatch, proof of delivery,
return route, freight cost, and carrier events. WMS should request shipment plans but never
invent carrier documentation.

## Security baseline

- Server-side OAuth/OIDC identity; no role derived from browser storage.
- MFA for administrators and operators performing high-risk writes.
- RBAC plus warehouse/tenant scope. Suggested roles: system admin, warehouse admin,
  supervisor, picker, packer, receiver, auditor, inventory controller, integration operator.
- Separate read, execute, cancel, adjust, and shipping permissions.
- Mutual TLS or signed provider webhooks where available.
- Secret manager, key rotation, and secret audit.
- TLS everywhere, CSP, CORS allowlist, CSRF protection for cookie sessions, secure cookies,
  and strict request-size/rate limits.
- Redact provider payloads and personal data from logs.
- Tamper-evident audit export and minimum 7-year retention policy based on regional/legal
  requirements.
- Penetration test, dependency scan, supply-chain signing, SBOM, and incident response.
- RPO and RTO targets for each warehouse/tenant; do not promise "zero loss" without
  backup/restore testing.

## Data model upgrade

Replace implicit aggregate SKU state with explicit entities:

- tenant / warehouse / zone / location / handling unit
- item / supplier item / UOM / pack / conversion
- inventory balance / lot / serial / expiry / quarantine
- inventory ledger / movement / reason / source document
- order / order line / promise / allocation / shipment
- reservation / task / task claim / task completion
- inbound / ASN / receiving line / putaway task
- return / inspection disposition
- cycle count / blind count / approval
- provider account / provider order / provider SKU mapping
- integration event / inbox / outbox / retry / dead letter
- carrier / service / shipment / tracking event
- warehouse device / operator session / device policy

Every warehouse write should use a database transaction and optimistic concurrency or a
versioned aggregate. The client cache should contain projections, not authoritative tables.

## Deployment plan

### Phase 0: safety and baseline

- Remove demo credentials and synthetic stock from production startup.
- Add environment separation and production-trust gates.
- Establish OIDC, RBAC, tenant scoping, and audit requirements.
- Convert all API writes to server-side commands.
- Set provider sandbox, TMS sandbox, ERP test, and load-test accounts.

### Phase 1: authoritative core

- Add PostgreSQL or equivalent server database and migrations.
- Implement inventory ledger, location balances, reservations, and atomic movements.
- Implement OMS order state machine and WMS task state machine.
- Replace direct browser Dexie authority with API/cache synchronization.
- Add outbox/inbox, idempotency, replay, and dead-letter handling.

### Phase 2: integration control plane

- Deploy signed webhook receivers and polling fallback.
- Implement per-provider credential and capability configuration.
- Certify Ozon, Yandex, and Wildberries in sandbox or pilot tenant.
- Add stock reconciliation, order reconciliation, provider status reconciliation, and
  automatic drift alerts.
- Add approval gates for destructive and high-volume writes.

### Phase 3: real-time operations

- Deploy event push and local network resilience.
- Add live task assignment, conflict detection, and operator presence.
- Add TMS carrier adapters, real labels, manifests, proof of delivery, and tracking webhooks.
- Connect ERP item, PO/receipt, cost, and financial posting flows.
- Add multi-warehouse and multi-tenant controls.

### Phase 4: controlled scaling

- Run warehouse shadow mode and dual-read reconciliation.
- Use canary deployment and freeze on reconciliation breach.
- Certify backup/restore, disaster recovery, and provider outage drills.
- Add SLOs, capacity tests, trace correlation, and on-call runbooks.
- Promote to production only after signed acceptance against operational scenarios.

## Measured acceptance gates

Do not approve production by feature count. Require evidence for:

- 99.95% successful accepted WMS writes;
- inventory reconciliation within 60 seconds for normal events;
- no overselling in concurrency tests;
- provider command replay creates exactly one provider effect;
- provider outage does not lose or silently duplicate orders;
- 95% of known operator actions deliver server acknowledgement within 2 seconds;
- PWA offline capture retains every accepted local event until server confirmation;
- critical event delivery SLO of 99.9%;
- no credentials in browser storage or source artifacts;
- RBAC negative tests pass for every role;
- reconcile 100% of stock, orders, and shipment states during shadow mode;
- disaster recovery meets declared RPO/RTO;
- all synthetic seed inventory and demo labels blocked at production trust level.

## Strategic recommendation

Do not launch with an integrated "realtime" claim. Launch a pilot as a **controlled
offline-capable WMS** with provider pull, stock reconciliation, manual approval, and a
documented service boundary. Promote integrations only after live sandbox certification,
atomic server inventory, replay-safe provider writes, and operator acceptance.

The biggest risk is not UI completeness. It is that two independent copies of stock or
shipment truth disagree. The winning strategy is to invest in server authority,
transactional events, reconciliation, and provider safety before adding more AI or
automation.
