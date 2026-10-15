// Jatelo Connect API server.
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ownerPool, closePools } from './db.js';
import { migrate, setRolePasswords } from './migrate.js';
import { HttpError } from './lib/http.js';
import { requireAuth, requireTenant, requireRole } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import routerRoutes from './routes/routers.js';
import internalRoutes from './routes/internal.js';
import { sites, packages, plans } from './routes/catalog.js';
import { vouchers, agents, agentSelf } from './routes/vouchers.js';
import { customers, subscriptions } from './routes/subscribers.js';
import { settings, staff, auditLog } from './routes/account.js';
import { portalPages, portalApi } from './routes/portal.js';
import { payments, paymentChannels, smsGateways, serviceRequests, smsWebhook } from './routes/payments.js';
import { dashboard, sessions, alerts, reports, events, routerTraffic } from './routes/dashboard.js';
import { admin } from './routes/admin.js';
import { syncAllPeers } from './services/wireguard.js';
import { ensureListener } from './services/events.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'res.headers["set-cookie"]'],
});

export function createApp() {
  const app = express();
  app.set('trust proxy', 'loopback'); // Caddy runs on the same host
  app.disable('x-powered-by');

  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({
    origin: [config.DASHBOARD_URL, config.PORTAL_URL],
    credentials: true,
    maxAge: 86400,
  }));

  // Router-only endpoints (tunnel source check inside)
  app.use('/internal', internalRoutes);

  // Public: captive portal, renewal and sign-up pages, their JSON API, and the SMS gateway webhook
  app.use('/portal-api', portalApi);
  app.use('/api/sms-gateway', smsWebhook);
  app.use(portalPages);

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', async (_req, res) => {
    try {
      await ownerPool.query('SELECT 1');
      res.json({ ok: true, service: 'jatelo-connect-api', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use('/api/auth', authRoutes);

  // EventSource cannot send headers: the stream takes its access token from the query string
  app.use('/api/events', (req, _res, next) => {
    if (req.query.access_token && !req.headers.authorization) req.headers.authorization = `Bearer ${req.query.access_token}`;
    if (req.query.tenant && !req.headers['x-tenant-id']) req.headers['x-tenant-id'] = String(req.query.tenant); // honoured for Jatelo staff only
    next();
  });

  app.use('/api/admin', requireAuth, requireRole(), admin); // platform_admin only

  const tenant = express.Router();
  tenant.use(requireAuth, requireTenant);
  // Agents only see their own voucher float and sales
  tenant.use((req, _res, next) => (req.user.role === 'agent' && !req.path.startsWith('/agent')
    ? next(new HttpError(403, 'forbidden', 'Agents can only use the agent space')) : next()));
  tenant.use('/dashboard', dashboard);
  tenant.use('/sessions', sessions);
  tenant.use('/alerts', alerts);
  tenant.use('/reports', reports);
  tenant.use('/events', events);
  tenant.get('/routers/:id/traffic', routerTraffic);
  tenant.use('/settings', settings);
  tenant.use('/staff', staff);
  tenant.use('/audit', auditLog);
  tenant.use('/sites', sites);
  tenant.use('/routers', routerRoutes);
  tenant.use('/packages', packages);
  tenant.use('/plans', plans);
  tenant.use('/vouchers', vouchers);
  tenant.use('/agents', agents);
  tenant.use('/customers', customers);
  tenant.use('/subscriptions', subscriptions);
  tenant.use('/payments', payments);
  tenant.use('/payment-channels', paymentChannels);
  tenant.use('/sms-gateways', smsGateways);
  tenant.use('/service-requests', serviceRequests);
  tenant.use('/agent', requireRole('agent'), agentSelf);
  app.use('/api', tenant);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Not found')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_json', message: 'Invalid JSON body' } });
    }
    req.log.error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong. Please try again.' } });
  });

  return app;
}

async function main() {
  if (process.env.RUN_MIGRATIONS !== 'false') await migrate(config.DATABASE_OWNER_URL, logger);
  await setRolePasswords(config.DATABASE_OWNER_URL);
  await syncAllPeers(logger).catch((e) => logger.error({ err: e.message }, 'wireguard sync failed'));
  await ensureListener(logger).catch((e) => logger.error({ err: e.message }, 'event listener failed'));
  const app = createApp();
  const server = app.listen(config.PORT, () => logger.info(`Jatelo Connect API listening on :${config.PORT}`));
  const stop = () => {
    logger.info('shutting down');
    server.close(() => closePools().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { logger.fatal(e); process.exit(1); });
}
