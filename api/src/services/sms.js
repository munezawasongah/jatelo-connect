// Outbound SMS are queued in sms_messages; the worker delivers them through the
// configured provider (aggregator API or the Android SMS gateway app).
import { render } from '../lib/messages.js';

export async function queueSms(client, { tenantId = null, to, body, kind = 'general' }) {
  const { rows } = await client.query(
    `INSERT INTO sms_messages (tenant_id, to_phone, body, kind) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, to, body, kind],
  );
  return rows[0].id;
}

export async function queueTemplate(client, { tenantId = null, to, template, lang = 'fr', vars = {} }) {
  return queueSms(client, { tenantId, to, body: render(template, lang, vars), kind: template });
}
