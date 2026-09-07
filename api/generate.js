/**
 * POST /api/generate   body: { scene, image, orderNo }
 * 人像写真:验证已付款订单才调火山出图(每单 GENS_PER_ORDER 张)·堵烧钱。
 * Env: ARK_API_KEY, LUMEE_HUB, HUB_SECRET_GLOWME, GENS_PER_ORDER(默认20)
 */
'use strict';

const { createHmac } = require('crypto');

const ARK_KEY = process.env.ARK_API_KEY || '';
const HUB_BASE = (process.env.LUMEE_HUB || '').replace(/\/$/, '');
const HUB_SECRET = process.env.HUB_SECRET_GLOWME || '';
const PROJECT_ID = 'glowme';
const GENS_PER_ORDER = parseInt(process.env.GENS_PER_ORDER || '20', 10);
const MODEL = 'doubao-seedream-4-0-250828';

const PRE = '真实照片质感的写真,保持输入照片里这个人完全相同的脸和五官身份(眼距鼻子嘴巴脸型一致),自然柔光;';
const SUF = '。真实照片质感,时尚写真大片,优雅高级,不要卡通不要3D渲染不要塑料皮肤不要过曝不要幼态化不要多余手指不要文字不要其他人脸不要真实名人。';
const SCENES = {
  wedding:   '穿白色齐地缎面婚纱在庄严教堂逆光中捧花回眸浅笑,精致盘发妆容,唯美婚纱大片(可换不同款婚纱与礼堂)',
  maldives:  '穿香槟色度假长裙,马尔代夫碧蓝海水白沙水上别墅前走动回眸,海风吹发阳光明媚,旅拍度假大片',
  bali:      '穿白色棉麻长裙,巴厘岛丛林无边泳池边回眸浅笑,阳光度假旅拍',
  hawaii:    '穿花朵印花长裙,夏威夷海边棕榈树夕阳下张开双臂,度假旅拍大片',
  redcarpet: '穿香槟色缎面红毯礼服,颁奖典礼红毯追光下侧身回眸,明星气场(不出现真实名人或品牌logo)',
  socialite: '穿老钱风高级定制套装,城市露台或高级酒店大堂,名媛下午茶气质,时尚杂志质感',
};

function hubSign(secret, payload) { return createHmac('sha256', secret).update(Buffer.from(payload, 'utf-8')).digest('hex'); }
if (!global.__gmOrderGens) global.__gmOrderGens = new Map();
const orderGens = global.__gmOrderGens;

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => { let raw=''; req.on('data',c=>raw+=c);
    req.on('end',()=>{ try{resolve(JSON.parse(raw||'{}'))}catch{resolve({})} }); req.on('error',()=>resolve({})); });
}
async function isOrderPaid(orderNo) {
  if (!HUB_BASE || !HUB_SECRET) return false;
  const payload = `project_id=${PROJECT_ID}&order_no=${orderNo}`;
  const sign = hubSign(HUB_SECRET, payload);
  try {
    const r = await fetch(`${HUB_BASE}/hub/pay/status?project_id=${PROJECT_ID}&order_no=${encodeURIComponent(orderNo)}`,
      { headers: { 'X-Project-Id': PROJECT_ID, 'X-Sign': sign }, cache: 'no-store' });
    const j = await r.json(); return (j?.status === 'paid');
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!ARK_KEY) return res.status(503).json({ error: 'Image engine not configured.' });

  const body = await readBody(req);
  const scene = SCENES[body.scene] ? body.scene : null;
  const image = typeof body.image === 'string' && body.image.startsWith('data:') ? body.image : null;
  const orderNo = (body.orderNo || '').toString();
  if (!scene || !image) return res.status(400).json({ error: 'Missing scene or image.' });

  if (!orderNo.startsWith('GM')) return res.status(402).json({ error: 'Payment required.', code: 'PAY' });
  const paid = await isOrderPaid(orderNo);
  if (!paid) return res.status(402).json({ error: 'Payment not confirmed yet.', code: 'PAY' });
  const used = orderGens.get(orderNo) || 0;
  if (used >= GENS_PER_ORDER) return res.status(402).json({ error: 'This pack is used up.', code: 'QUOTA' });

  const prompt = PRE + SCENES[scene] + SUF;
  let arkRes, arkJson;
  try {
    arkRes = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + ARK_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, image, size: '1536x2048', response_format: 'url', watermark: false }),
    });
    arkJson = await arkRes.json();
  } catch (e) { console.error('[generate] ARK unreachable', e); return res.status(502).json({ error: 'Image service temporarily unavailable.' }); }

  const url = arkJson?.data?.[0]?.url;
  if (!arkRes.ok || !url) { console.error('[generate] ARK error', arkRes.status, JSON.stringify(arkJson).slice(0,300)); return res.status(502).json({ error: 'Generation failed, please try again.' }); }

  orderGens.set(orderNo, used + 1);
  return res.status(200).json({ url, remaining: Math.max(0, GENS_PER_ORDER - used - 1) });
};
