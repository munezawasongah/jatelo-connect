// Central configuration, read once from the environment and validated at boot.
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  // Address the API also listens on inside the WireGuard tunnel (router registration)
  TUNNEL_LISTEN: z.string().default('10.88.0.1'),

  PUBLIC_API_URL: z.string().url().default('http://localhost:8080'),
  PORTAL_URL: z.string().url().default('http://localhost:8080'),
  DASHBOARD_URL: z.string().url().default('http://localhost:5173'),
  SERVER_PUBLIC_IP: z.string().default('127.0.0.1'),

  // Database: the app role (RLS enforced) and the owner role (migrations, workers)
  DATABASE_URL: z.string().min(1),
  DATABASE_OWNER_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32),
  MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'MASTER_KEY must be 64 hex chars (32 bytes)'),

  RADIUS_SECRET: z.string().min(16),
  RADIUS_HOST: z.string().default('10.88.0.1'),
  RADIUS_BACKUP_HOST: z.string().optional(),

  WG_INTERFACE: z.string().default('wg0'),
  WG_PORT: z.coerce.number().default(51820),
  WG_HUB_PUBLIC_KEY: z.string().default(''),
  WG_MANAGE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  TRIAL_DAYS: z.coerce.number().default(14),
  DEFAULT_CURRENCY: z.string().default('BIF'),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
