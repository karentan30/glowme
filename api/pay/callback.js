/**
 * POST /api/pay/callback — Lumee Hub webhook on payment complete.
 * Verifies X-Sign HMAC before trusting payload; marks order paid.
 * Register in Hub as: HUB_CALLBACK_SCENEME = https://<sceneme-domain>/api/pay/callback
 * Env: HUB_SECRET_GLOWME
 */
'use strict';

const { createHmac } = require('crypto');

const HUB_SECRET = process.env.HUB_SECRET_GLOWME || '';
const PROJECT_ID = 'glowme';

function hubSign(secret, payload) {
  return createHmac('sha256', secret)
    .update(typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload)
    .digest('hex');
}

if (!global.__gmOrderStore) global.__gmOrderStore = new Map();
const store = global.__gmOrderStore;

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!HUB_SECRET) {
    console.error('[pay/callback] HUB_SECRET_GLOWME not set');
    return res.status(503).json({ error: 'not configured' });
  }

  let rawBuffer;
  try { rawBuffer = await readBody(req); }
  catch (e) { return res.status(400).json({ error: 'could not read body' }); }

  const receivedSign = (req.headers['x-sign'] || '').toLowerCase().trim();
  const receivedPid = (req.headers['x-project-id'] || '').trim();
  const expectedSign = hubSign(HUB_SECRET, rawBuffer);

  if (!receivedSign || receivedPid !== PROJECT_ID || receivedSign !== expectedSign) {
    console.warn('[pay/callback] Signature mismatch');
    return res.status(401).json({ error: 'invalid signature' });
  }

  let payload;
  try { payload = JSON.parse(rawBuffer.toString('utf-8')); }
  catch { return res.status(400).json({ error: 'invalid json' }); }

  const orderNo = (payload.order_no || '').toString();
  const status = (payload.status || '').toString();
  if (!orderNo.startsWith('GM')) return res.status(400).json({ error: 'unrecognized order prefix' });

  if (status === 'paid') {
    const existing = store.get(orderNo);
    if (existing) existing.status = 'paid';
    else store.set(orderNo, { orderNo, status: 'paid', createdAt: Date.now() });
    console.log(`[pay/callback] order ${orderNo} paid`);
  }
  return res.status(200).json({ ok: true });
};
