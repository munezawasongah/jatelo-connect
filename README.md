# Jatelo Connect

ISP & WiFi hotspot management platform for Burundi, by Jatelo Technologies.
Operators sell hotspot vouchers and PPPoE subscriptions, collect payment by Lumicash and EcoCash,
and run their MikroTik routers from one dashboard.

## Repository layout

| Path | What it is |
| --- | --- |
| `db/migrations/` | PostgreSQL schema, RADIUS decision functions, row-level security, roles |
| `radius/` | FreeRADIUS 3.2 configuration and Dockerfile |
| `api/` | Node.js API (Express): auth, routers, vouchers, subscribers, agents, staff |
| `api/src/portal/` | Captive portal, PPPoE renewal and sign-up pages (French, Kirundi, English) |
| `api/src/worker.js` | Background worker: SMS delivery, expiries, reminders, router health, bandwidth, account status |
| `caddy/Caddyfile` | HTTPS for the dashboard, API and portal domains; walled-subscriber redirect |
| `docker-compose.yml` | Production stack: PostgreSQL, API, worker, FreeRADIUS, Caddy |

## How access works

1. Every MikroTik router connects to the platform through its own WireGuard tunnel (`10.88.0.0/16`, hub `10.88.0.1`).
2. Hotspot logins and PPPoE logins go to FreeRADIUS over that tunnel.
3. FreeRADIUS asks PostgreSQL (`jc_radius_check` / `jc_radius_reply`) who may log in and with what speed, time and data limits.
4. Accounting updates usage on vouchers and subscriptions; a voucher whose data runs out is marked `exhausted`.
5. Expired PPPoE subscribers stay connected but are walled to the payment page (`jc-expired` address list).

Non-MikroTik devices (Ruijie, Omada, UniFi) send RADIUS from a fixed public IP and are matched through the `nas` table.

## How customers pay (before wallet API approval)

1. On the portal the customer picks a package, chooses Lumicash or EcoCash and enters their phone number.
2. They pay the operator's merchant number from their phone (USSD), adding the reference shown.
3. The operator's merchant phone runs the **SMS Gateway for Android** app (sms-gate.app). It forwards the wallet's
   confirmation SMS to `POST /api/sms-gateway/<token>/inbound`.
4. The platform reads amount, payer phone and transaction id. Same phone + same amount + recent = paid automatically.
   Otherwise the customer types the transaction id from their SMS on the portal.
5. The voucher code appears on screen, the phone logs in automatically, and the code + a recovery PIN arrive by SMS.

The same gateway phone sends all outgoing SMS (receipts, reminders, OTP). PPPoE subscribers renew the same way:
reminder and expiry SMS include the amount, merchant number and a reference, and paying from their own phone renews them.

## API overview

All tenant routes need `Authorization: Bearer <access_token>`.

| Area | Routes |
| --- | --- |
| Auth | `POST /api/auth/signup`, `/login`, `/refresh`, `/logout`, `GET /me`, phone verification, password reset by SMS |
| Account | `GET/PATCH /api/settings`, `/api/staff`, `GET /api/audit` |
| Network | `/api/sites`, `/api/routers` (+ `/setup` script, `/refresh`, `/reboot`) |
| Catalogue | `/api/packages` (hotspot), `/api/plans` (PPPoE) |
| Hotspot | `/api/vouchers` (batches, export CSV, counter sale, disable/enable, reset devices, extend) |
| Resellers | `/api/agents` (float top-up, ledger), `/api/agent` (agent self-service) |
| Subscribers | `/api/customers`, `/api/subscriptions` (create, renew, suspend, resume, cancel, disconnect) |
| Payments | `/api/payments` (list, confirm by transaction id or by hand, cancel, inbound SMS), `/api/payment-channels/:wallet` |
| SMS | `/api/sms-gateways` (webhook URL shown once, test send) |
| Requests | `/api/service-requests` (from the public sign-up page) |
| Public | `/h/:routerId` portal, `/renew`, `/join/:slug`, `/portal-api/*`, `/api/sms-gateway/:token/inbound` |
| Routers only | `/internal/routers/register`, `/internal/routers/hotspot-file/:name` (tunnel source only) |

## Development

```bash
cd api
npm install
cp ../.env.example ../.env   # then edit
node src/migrate.js
npm test                     # integration tests against a real PostgreSQL
npm run dev
```

## Roles

`owner` (everything) · `manager` (no staff management) · `technician` (routers, subscribers) ·
`cashier` (vouchers, payments) · `agent` (own voucher float only) · `platform_admin` (Jatelo staff).
