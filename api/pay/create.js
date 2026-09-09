/**
 * POST /api/pay/create   body: { sku }
 *
 * Signs the request with HUB_SECRET_GLOWME, calls Lumee Hub /hub/pay/create
 * (channel=stripe), returns { orderNo, url }.
 *
 * Amount is SERVER-AUTHORITATIVE via SKU whitelist — client only sends sku id.
 *
 * Env: LUMEE_HUB, HUB_SECRET_GLOWME
 */
'use strict';

const { createHmac, randomBytes } = require('crypto');

const HUB_BASE = (process.env.LUMEE_HUB || '').replace(/\/$/, '');
const HUB_SECRET = process.env.HUB_SECRET_GLOWME || '';
const PROJECT_ID = 'glowme';

// SKU whitelist — server-authoritative pricing (never trust client amount)
const SKUS = {
  shoot:  { amount: 12.99, product: 'Sceneme — Dream Shoot (20 photos)' },
  mini:   { amount: 4.99,  product: 'Sceneme — Mini (5 photos)' },
  studio: { amount: 24.99, product: 'Sceneme — Studio (60 photos)' },
};
const DEFAULT_SKU = 'shoot';
// 档位 → 订单号里的单字符标记(出图接口据此判每单能出几张·见下方 outTradeNo 注释)
const TIER_CHAR = { mini: 'm', shoot: 's', studio: 'd' };

function hubSign(secret, payload) {
  return createHmac('sha256', secret)
    .update(typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload)
    .digest('hex');
}

if (!global.__gmOrderStore) global.__gmOrderStore = new Map();
const store = global.__gmOrderStore;

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  if (!HUB_BASE || !HUB_SECRET) {
    console.error('[pay/create] Missing env LUMEE_HUB or HUB_SECRET_GLOWME');
    return res.status(503).json({ error: 'Payment not configured.' });
  }

  const body = await readBody(req);
  const sku = SKUS[body.sku] ? body.sku : DEFAULT_SKU;
  const { amount, product } = SKUS[sku];

  // 订单号自带档位标记 + 短签名:GM{ts14}{rand8}{档位1}{sig6} = 31 字符(微信 out_trade_no 上限 32)
  // 为什么这么做:出图接口只拿得到 orderNo,中台 /hub/pay/status 只回 paid/pending 不回金额,
  // 而档位原本只存在 pay/create 的进程内存 Map 里 —— 换个 serverless 实例就没了,
  // 于是三档全都按同一个 GENS_PER_ORDER(20) 发货:$4.99 买 5 张的给 20 张(每单多烧 3 倍出图成本),
  // $24.99 买 60 张的只给 20 张(货不对板,等着退款)。
  // 签名用 HUB_SECRET,客户端改不动档位字符 —— 服务端权威,且无需任何存储。
  const rand = randomBytes(4).toString('hex');
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const base = `GM${ts}${rand}${TIER_CHAR[sku]}`;
  const outTradeNo = `${base}${hubSign(HUB_SECRET, base).slice(0, 6)}`;

  const hubBody = { method: 'stripe', product, amount, out_ref: outTradeNo, currency: 'usd', return_url: 'https://glowme-fabulousslim.vercel.app/' };
  const rawBody = JSON.stringify(hubBody);
  const sign = hubSign(HUB_SECRET, rawBody);

  let hubRes;
  try {
    hubRes = await fetch(`${HUB_BASE}/hub/pay/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Project-Id': PROJECT_ID, 'X-Sign': sign },
      body: rawBody,
    });
  } catch (e) {
    console.error('[pay/create] Hub unreachable', e);
    return res.status(502).json({ error: 'Payment service temporarily unavailable.' });
  }

  let hubJson;
  try { hubJson = await hubRes.json(); } catch { hubJson = {}; }

  if (!hubRes.ok || !hubJson?.url) {
    console.error('[pay/create] Hub error', hubRes.status, hubJson);
    return res.status(502).json({ error: hubJson?.error || 'Failed to create checkout.' });
  }

  const hubOrderNo = hubJson.order_no || outTradeNo;
  store.set(hubOrderNo, { orderNo: hubOrderNo, sku, status: 'pending', createdAt: Date.now() });
  return res.status(200).json({ orderNo: hubOrderNo, url: hubJson.url, sku });
};
