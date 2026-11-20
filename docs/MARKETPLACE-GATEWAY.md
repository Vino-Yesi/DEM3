# Marketplace OMS / WMS / TMS Gateway

The Integration Hub's Marketplace Exchange uses a same-origin Netlify Function at `POST /api/marketplace`. Marketplace credentials stay in the server environment; the browser receives only normalized order/stock/dispatch results. The gateway token is an additional shared access secret for this server function. It is typed into the Integration Hub by a local administrator, held only in the page's React state, and never saved to Dexie or browser storage.

## Netlify setup

Set these values in Netlify's site environment variables (Functions runtime scope), then redeploy. Do **not** put marketplace keys in `VITE_*` variables, source code, saved connector profiles, or browser storage.

| Variable | Used for |
| --- | --- |
| `MARKETPLACE_GATEWAY_TOKEN` | Required for every gateway request; use at least 32 random characters. Generate one with `openssl rand -hex 32`. Share only with trusted site administrators. |
| `OZON_CLIENT_ID`, `OZON_API_KEY` | Ozon orders and dispatch |
| `OZON_WAREHOUSE_ID` | Ozon stock updates |
| `YANDEX_API_KEY`, `YANDEX_BUSINESS_ID`, `YANDEX_CAMPAIGN_ID` | Yandex Market order pulls use the business orders API filtered to this campaign; dispatch uses the configured campaign |
| `YANDEX_BUSINESS_ID`, `YANDEX_PARTNER_WAREHOUSE_ID` | Yandex Market stock updates |
| `YANDEX_DELIVERY_SERVICE_ID` | Yandex Market tracking/status dispatch |
| `WILDBERRIES_API_KEY` | Wildberries FBS orders, supplies and handoff |
| `WILDBERRIES_WAREHOUSE_ID` | Wildberries stock updates |

Capabilities are detected independently. Missing variables are shown in Marketplace Exchange; configure only the providers and operations you intend to use. If using the Netlify CLI locally, run the app through `netlify dev` so the function and `/api/marketplace` rewrite are both available. Vite's plain `npm run dev` does not run Netlify Functions.

## Current manual workflows

- **OMS pull:** Fetches provider orders and upserts them into the local Dexie order queue. Yandex Market order pulls use `POST /v1/businesses/{businessId}/orders`, filtered to the configured campaign and paged with `pageToken`. Wildberries status refreshes use the locally stored numeric assembly order IDs.
- **WMS stock push:** Sends SKU-level stock after subtracting active `reserved`/`allocated` inventory reservations. Stock sync is manual and chunked. Keep local/provider warehouse configuration aligned.
- **SKU mapping:** Ozon offer IDs and Yandex seller SKUs default to the local SKU. Wildberries order article mapping is separate from its inventory `chrtId` (size ID); an EAN barcode is not a substitute for `chrtId`.
- **Ozon dispatch:** Ships eligible FBS postings and requests the awaiting-delivery transition.
- **Yandex dispatch:** Requires a numeric order ID and genuine carrier tracking number, then sends tracking and delivery-status updates. The current track-code route is DBS-oriented in the research snapshot; verify it against the account's fulfillment/delivery model before use.
- **Wildberries dispatch:** Creates a supply, attaches up to 100 assembly orders, and stores the supply ID locally. A separate confirmation transfers the supply to delivery; do this only after the physical handoff.
- **Carrier TMS:** No carrier-label or live tracking adapter is configured. The Shipping page now blocks synthetic labels for marketplace orders; its clearly marked local demo preview is not a postage label or carrier booking. The JSON tracking manifest is a local handoff file, not a provider upload contract.

All provider requests are real actions. Review stock, provider account permissions, shipment state, warehouse IDs, and external order IDs before use. The app's local user login is not a server-side identity system; the shared gateway token is a bearer capability and anyone holding it can invoke configured operations. For a multi-user production deployment, put the function behind an authenticated server-side identity/role layer and restrict who can retrieve the token.

## API compatibility note

The route adapters were implemented from provider-shaped schemas and repository snapshots, not live credentials or a provider sandbox. Confirm the current official documentation, token scopes/categories, warehouse IDs, accepted status transitions, request limits, and business flow for each account before enabling production writes. In particular, the Yandex `GET /v2/campaigns/{campaignId}/orders` route is deprecated in the current repository reference snapshot (degradation from 18 January 2027; shutdown 12 April 2027); order pulls now use `POST /v1/businesses/{businessId}/orders`. Confirm these lifecycle dates against current official docs. Also verify the Ozon stock `quant_size` field/meaning and confirm the Yandex tracking route fits the account's delivery model (the track-code flow is DBS-oriented in the reference snapshot). Errors are surfaced without returning provider secrets; no live provider calls are part of the automated test suite.

Run focused offline checks with:

```sh
npm run test:marketplace
```
