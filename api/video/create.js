/**
 * POST /api/video/create   body: { scene, image, orderNo }
 *   图生视频(i2v):把已生成的写真图(用户传 data:image/... base64)动起来,出一条 ~5s 竖屏静默动图。
 *   必须验证 orderNo 已付款(同 generate.js 那套 HMAC 验签)→ 提交 SiliconFlow Wan i2v → 返回 { requestId }。
 *   成本控制:每个付款订单最多出 VIDS_PER_ORDER 条(默认2),global Map 计数(同 generate.js 的 orderGens 模式)。
 *   ⚠️ i2v 约 90s,Vercel serverless 有超时 → 本接口只提交拿 requestId,前端轮询 /api/video/status。
 * Env: SILICONFLOW_API_KEY, LUMEE_HUB, HUB_SECRET_GLOWME, VIDS_PER_ORDER(默认2)
 */
'use strict';

const { createHmac } = require('crypto');

const SF_KEY = (process.env.SILICONFLOW_API_KEY || '').trim();
const HUB_BASE = (process.env.LUMEE_HUB || '').replace(/\/$/, '');
const HUB_SECRET = process.env.HUB_SECRET_GLOWME || '';
const PROJECT_ID = 'glowme';
const VIDS_PER_ORDER = parseInt(process.env.VIDS_PER_ORDER || '2', 10);
const SF_MODEL = 'Wan-AI/Wan2.2-I2V-A14B';

const NEG = ',镜头轻柔缓慢,画面稳定,人物的脸和五官身份始终一致,不变形不糊不多手指,自然真实';
const SCENES = {
  wedding:   '这个人穿婚纱在教堂逆光中微微回眸浅笑,精致盘发,发丝和捧花随微风轻轻飘动,裙摆缓缓摆动,镜头极缓推近',
  maldives:  '这个人穿度假长裙在马尔代夫海边微微回眸,海风吹动长发和裙摆,身后碧蓝海水缓缓起伏波光闪动,镜头缓缓横移',
  bali:      '这个人穿白色棉麻长裙在巴厘岛无边泳池边微微回眸浅笑,发丝和裙裾随风轻摆,水面泛起细波,镜头缓缓推近',
  hawaii:    '这个人穿花朵印花长裙在夏威夷海边夕阳下微微张开双臂,长发和裙摆随海风飘动,棕榈叶轻轻晃动,镜头缓缓上移',
  redcarpet: '这个人穿缎面礼服在红毯追光下微微侧身回眸,礼服反光流动,背景闪光灯星星点点闪烁,镜头缓缓推近',
  socialite: '这个人穿老钱风套装在高级酒店露台微微转头浅笑,发丝随微风轻拂,茶杯热气袅袅上升,镜头极缓推近',
};

// scene → TikTok 文案(不接 LLM·预写模板·省钱)
const CAPTIONS = {
  wedding:   { caption: "the wedding shoot I never had to book ✨",  tags: "#weddingdress #aiphotos #glowup #fyp #dreamshoot" },
  maldives:  { caption: "POV: soft launch of my Maldives era 🌊",     tags: "#maldives #vacationmode #aiphotos #fyp #glowup" },
  bali:      { caption: "Bali villa energy 🌴 didn't even pack a bag", tags: "#bali #travelgirl #aiphotos #fyp #glowup" },
  hawaii:    { caption: "Hawaii golden hour hits different 🌺",        tags: "#hawaii #goldenhour #aiphotos #fyp #glowup" },
  redcarpet: { caption: "main character on the red carpet 🎬✨",       tags: "#redcarpet #glam #aiphotos #fyp #maincharacter" },
  socialite: { caption: "old money afternoon, no notes 🥂",           tags: "#oldmoney #quietluxury #aiphotos #fyp #glowup" },
};

function hubSign(secret, payload) {
  return createHmac('sha256', secret).update(Buffer.from(payload, 'utf-8')).digest('hex');
}

if (!global.__gmOrderVids) global.__gmOrderVids = new Map();
const orderVids = global.__gmOrderVids;

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let raw=''; req.on('data',c=>raw+=c);
    req.on('end',()=>{ try{resolve(JSON.parse(raw||'{}'))}catch{resolve({})} });
    req.on('error',()=>resolve({}));
  });
}

async function isOrderPaid(orderNo) {
  if (!HUB_BASE || !HUB_SECRET) return false;
  const payload = `project_id=${PROJECT_ID}&order_no=${orderNo}`;
  const sign = hubSign(HUB_SECRET, payload);
  try {
    const r = await fetch(`${HUB_BASE}/hub/pay/status?project_id=${PROJECT_ID}&order_no=${encodeURIComponent(orderNo)}`,
      { headers: { 'X-Project-Id': PROJECT_ID, 'X-Sign': sign }, cache: 'no-store' });
    const j = await r.json();
    return (j?.status === 'paid');
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!SF_KEY) return res.status(503).json({ error: 'Video engine not configured.' });

  const body = await readBody(req);
  const scene = SCENES[body.scene] ? body.scene : null;
  const image = typeof body.image === 'string' && body.image.startsWith('data:') ? body.image : null;
  const orderNo = (body.orderNo || '').toString();
  if (!scene || !image) return res.status(400).json({ error: 'Missing scene or image.' });

  // 🔒 付费门:必须已付款订单 + 未超本单视频额度(堵烧钱)
  if (!orderNo.startsWith('GM')) return res.status(402).json({ error: 'Payment required.', code: 'PAY' });
  const paid = await isOrderPaid(orderNo);
  if (!paid) return res.status(402).json({ error: 'Payment not confirmed yet.', code: 'PAY' });
  const usedThisOrder = orderVids.get(orderNo) || 0;
  if (usedThisOrder >= VIDS_PER_ORDER) {
    return res.status(402).json({ error: 'Video limit reached for this pack.', code: 'QUOTA' });
  }

  const prompt = SCENES[scene] + NEG;
  let sfRes, sfJson;
  try {
    sfRes = await fetch('https://api.siliconflow.cn/v1/video/submit', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SF_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SF_MODEL, prompt, image, image_size: '720x1280' }),
    });
    sfJson = await sfRes.json();
  } catch (e) {
    console.error('[video/create] SiliconFlow unreachable', e);
    return res.status(502).json({ error: 'Video service temporarily unavailable.' });
  }

  const requestId = sfJson?.requestId;
  if (!sfRes.ok || !requestId) {
    console.error('[video/create] SF error', sfRes.status, JSON.stringify(sfJson).slice(0, 300));
    return res.status(502).json({ error: 'Video generation failed to start, please try again.' });
  }

  orderVids.set(orderNo, usedThisOrder + 1);
  const cap = CAPTIONS[scene] || { caption: '', tags: '' };
  return res.status(200).json({
    requestId,
    caption: cap.caption,
    tags: cap.tags,
    remaining: Math.max(0, VIDS_PER_ORDER - usedThisOrder - 1),
  });
};
