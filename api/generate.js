/**
 * POST /api/generate
 *   单人 body: { scene, image, orderNo }
 *   双人 body: { sceneId, image, image2, orderNo }  image=左边人 image2=右边人
 * 人像写真:验证已付款订单才调火山出图·按订单金额判每单能出几张(5/20/60)·堵烧钱。
 * Env: ARK_API_KEY, LUMEE_HUB, HUB_SECRET_GLOWME, GENS_PER_ORDER(默认20)
 */
'use strict';

const { createHmac } = require('crypto');
const { COUPLE_BY_ID } = require('./couple-scenes.js');

const ARK_KEY = process.env.ARK_API_KEY || '';
const HUB_BASE = (process.env.LUMEE_HUB || '').replace(/\/$/, '');
const HUB_SECRET = process.env.HUB_SECRET_GLOWME || '';
const PROJECT_ID = 'glowme';
const GENS_PER_ORDER = parseInt(process.env.GENS_PER_ORDER || '20', 10);
const MODEL = 'doubao-seedream-4-0-250828';
// 双人合影另用 5.0 pro:多图参考(image 传数组)在这个模型上已验证可用
// (配方来自 marketing/scripts/slim-jiaozi/gen_image_seedream_ref.py,Karen 在另一台机器实测过)
const MODEL_COUPLE = 'doubao-seedream-5-0-pro-260628';

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
if (!global.__gmIpHits) global.__gmIpHits = new Map();
const ipHits = global.__gmIpHits;

// 金额(美元) → 这一档能出几张。必须和 index.html 付费墙上写的一致,
// 也和 pay/create.js 的 SKUS 金额一一对应:mini 5 / shoot 20 / studio 60。
// 金额由中台在下单时按 SKU 白名单服务端写死,查单时原样返回 —— 客户端碰不到,
// 所以档位是权威的,glowme 这边一个字节都不用存。
const AMOUNT_GENS = { '4.99': 5, '12.99': 20, '24.99': 60 };

/** 单 IP 滑窗限流。注意:和下面的 orderGens 一样是进程内存,
 *  Vercel 横向扩容时每个实例各算各的 —— 挡得住顺手薅,挡不住铁了心刷。
 *  真正扛得住的做法要中台落库,补丁见 docs/补丁-中台配额账本.md。 */
function ipAllowed(ip, limit, windowMs) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) { ipHits.set(ip, hits); return false; }
  hits.push(now); ipHits.set(ip, hits);
  if (ipHits.size > 5000) ipHits.clear();   // 防内存无限涨
  return true;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => { let raw=''; req.on('data',c=>raw+=c);
    req.on('end',()=>{ try{resolve(JSON.parse(raw||'{}'))}catch{resolve({})} }); req.on('error',()=>resolve({})); });
}
/** 向中台查单。回 { paid, amount } —— amount 用来判这一单能出几张。 */
async function lookupOrder(orderNo) {
  if (!HUB_BASE || !HUB_SECRET) return { paid: false, amount: null };
  const payload = `project_id=${PROJECT_ID}&order_no=${orderNo}`;
  const sign = hubSign(HUB_SECRET, payload);
  try {
    const r = await fetch(`${HUB_BASE}/hub/pay/status?project_id=${PROJECT_ID}&order_no=${encodeURIComponent(orderNo)}`,
      { headers: { 'X-Project-Id': PROJECT_ID, 'X-Sign': sign }, cache: 'no-store' });
    const j = await r.json();
    return { paid: j?.status === 'paid', amount: (typeof j?.amount === 'number' ? j.amount : null) };
  } catch { return { paid: false, amount: null }; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!ARK_KEY) return res.status(503).json({ error: 'Image engine not configured.' });

  const body = await readBody(req);
  const isDataUri = (v) => typeof v === 'string' && v.startsWith('data:');
  const image  = isDataUri(body.image)  ? body.image  : null;
  const image2 = isDataUri(body.image2) ? body.image2 : null;
  const orderNo = (body.orderNo || '').toString();

  // 双人合影:客户端只能传 sceneId,prompt 全在服务端(couple-scenes.js)
  const couple = body.sceneId ? COUPLE_BY_ID[body.sceneId] : null;
  const scene  = SCENES[body.scene] ? body.scene : null;
  if (body.sceneId && !couple) return res.status(400).json({ error: 'Unknown scene.' });
  if (!couple && !scene) return res.status(400).json({ error: 'Missing scene.' });
  if (!image) return res.status(400).json({ error: 'Missing photo.' });
  // 两张都要:少一张就串脸,不如直接挡住(文档里"第一张=左边人,第二张=右边人"是硬规格)
  if (couple && !image2) {
    return res.status(400).json({ error: 'Two photos required for couple scenes.', code: 'NEED_TWO' });
  }

  if (!orderNo.startsWith('GM')) return res.status(402).json({ error: 'Payment required.', code: 'PAY' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!ipAllowed(ip, 80, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests, please try again later.', code: 'RATE' });
  }

  const { paid, amount } = await lookupOrder(orderNo);
  if (!paid) return res.status(402).json({ error: 'Payment not confirmed yet.', code: 'PAY' });

  // 中台没回金额(老版本中台/老订单)→ 退回旧上限,不把已付费用户卡在门外
  const quota = AMOUNT_GENS[String(amount)] ?? GENS_PER_ORDER;
  const used = orderGens.get(orderNo) || 0;
  if (used >= quota) return res.status(402).json({ error: 'This pack is used up.', code: 'QUOTA' });

  // 单人:老配方(负面词拼在 prompt 尾巴里)。双人:场景库自带 prompt + 独立 negative_prompt。
  const payload = couple
    ? { model: MODEL_COUPLE, prompt: couple.prompt, negative_prompt: couple.negative,
        image: [image, image2],          // 顺序即画面左右,别调换
        size: '1536x2048', response_format: 'url', watermark: false }
    : { model: MODEL, prompt: PRE + SCENES[scene] + SUF,
        image, size: '1536x2048', response_format: 'url', watermark: false };
  let arkRes, arkJson;
  try {
    arkRes = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + ARK_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    arkJson = await arkRes.json();
  } catch (e) { console.error('[generate] ARK unreachable', e); return res.status(502).json({ error: 'Image service temporarily unavailable.' }); }

  const url = arkJson?.data?.[0]?.url;
  if (!arkRes.ok || !url) { console.error('[generate] ARK error', arkRes.status, JSON.stringify(arkJson).slice(0,300)); return res.status(502).json({ error: 'Generation failed, please try again.' }); }

  orderGens.set(orderNo, used + 1);
  return res.status(200).json({ url, remaining: Math.max(0, quota - used - 1) });
};
