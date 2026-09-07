/**
 * GET /api/pay/status?order_no=SM...
 * Fast-path local store → else poll Lumee Hub (authoritative).
 * Env: LUMEE_HUB, HUB_SECRET_GLOWME
 */
'use strict';

const { createHmac } = require('crypto');

const HUB_BASE = (process.env.LUMEE_HUB || '').replace(/\/$/, '');
const HUB_SECRET = process.env.HUB_SECRET_GLOWME || '';
const PROJECT_ID = 'glowme';

function hubSign(secret, payload) {
  return createHmac('sha256', secret)
    .update(typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload)
    .digest('hex');
}

if (!global.__gmOrderStore) global.__gmOrderStore = new Map();
const store = global.__gmOrderStore;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const orderNo = url.searchParams.get('order_no') || '';
  if (!orderNo || !orderNo.startsWith('GM')) return res.status(400).json({ status: 'not_found' });

  const local = store.get(orderNo);
  if (local?.status === 'paid') return res.status(200).json({ status: 'paid', sku: local.sku });

  if (!HUB_BASE || !HUB_SECRET) {
    return res.status(200).json({ status: local ? 'pending' : 'not_found' });
  }

  const canonicalPayload = `project_id=${PROJECT_ID}&order_no=${orderNo}`;
  const sign = hubSign(HUB_SECRET, canonicalPayload);

  let hubRes;
  try {
    hubRes = await fetch(
      `${HUB_BASE}/hub/pay/status?project_id=${PROJECT_ID}&order_no=${encodeURIComponent(orderNo)}`,
      { headers: { 'X-Project-Id': PROJECT_ID, 'X-Sign': sign }, cache: 'no-store' }
    );
  } catch (e) {
    console.error('[pay/status] Hub unreachable', e);
    return res.status(200).json({ status: local ? local.status : 'pending' });
  }

  let hubJson;
  try { hubJson = await hubRes.json(); } catch { hubJson = {}; }

  if ((hubJson?.status || 'pending') === 'paid') {
    if (local) local.status = 'paid';
    else store.set(orderNo, { orderNo, status: 'paid', createdAt: Date.now() });
    return res.status(200).json({ status: 'paid', sku: local?.sku });
  }
  return res.status(200).json({ status: 'pending' });
};
