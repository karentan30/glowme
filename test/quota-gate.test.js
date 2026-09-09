// glowme 配额闸真跑测试:调真 handler,只 mock 掉中台和火山的网络
process.env.HUB_SECRET_GLOWME = 'test_secret_abc';
process.env.LUMEE_HUB = 'https://hub.test';
process.env.ARK_API_KEY = 'test_ark';

const path = require("path").join(__dirname, "..", "api");
const createH = require(path + '/pay/create.js');
const genH    = require(path + '/generate.js');

let lastOutRef = null;
const ORDER_AMOUNT = {};   // 中台单号 → 下单时服务端写死的金额
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/hub/pay/create')) {
    const b = JSON.parse(opts.body);
    // 照中台真实行为:自己发号 GM+ts14+rand6,out_ref 只留作对账
    lastOutRef = b.out_ref;
    const oid = 'GM' + '20260909210000' + Math.random().toString(16).slice(2, 8);
    ORDER_AMOUNT[oid] = b.amount;
    return { ok: true, json: async () => ({ order_no: oid, url: 'https://checkout.test/x' }) };
  }
  if (u.includes('/hub/pay/status')) {
    const oid = decodeURIComponent(u.split('order_no=')[1] || '');
    return { ok: true, json: async () => ({ status: 'paid', amount: ORDER_AMOUNT[oid] ?? null, currency: 'usd' }) };
  }
  if (u.includes('ark.cn-beijing')) return { ok: true, json: async () => ({ data: [{ url: 'https://img.test/1.jpg' }] }) };
  throw new Error('unexpected fetch ' + u);
};

function mkRes() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const post = (h, body, ip) => { const res = mkRes();
  return h({ method:'POST', body, headers:{'x-forwarded-for': ip||'1.2.3.4'} }, res).then(()=>res); };

async function buyThenBurn(sku, label, ip) {
  const cRes = await post(createH, { sku });
  const orderNo = cRes.body.orderNo;
  let ok = 0, stop = null;
  for (let i = 0; i < 70; i++) {
    const g = await post(genH, { scene:'wedding', image:'data:image/jpeg;base64,x', orderNo }, ip);
    if (g.code === 200) ok++; else { stop = g.body.code; break; }
  }
  console.log(`${label.padEnd(26)} 订单号 ${orderNo} (${orderNo.length}字符)  实际出图 ${ok} 张  然后 ${stop}`);
  return ok;
}

(async () => {
  console.log('=== 三档各买一单,一直出到被拦 ===');
  const mini   = await buyThenBurn('mini',   'mini   $4.99 承诺 5 张',  '10.0.0.1');
  const shoot  = await buyThenBurn('shoot',  'shoot  $12.99 承诺 20 张','10.0.0.2');
  const studio = await buyThenBurn('studio', 'studio $24.99 承诺 60 张','10.0.0.3');

  console.log('\n=== 老订单(本次改动前已付款的·24字符无档位标记)===');
  const legacyRes = mkRes();
  let ok = 0;
  const legacy = 'GM20260909120000abcd1234';
  for (let i=0;i<25;i++){ const g = await post(genH,{scene:'wedding',image:'data:image/jpeg;base64,x',orderNo:legacy},'10.0.0.4');
    if (g.code===200) ok++; else break; }
  console.log(`老订单 ${legacy}  出图 ${ok} 张 (应=20 兜底,不能把已付费用户卡死)`);

  console.log('\n=== 有人拿 mini 的单号,想按 studio 的量白嫖 ===');
  const cRes = await post(createH, { sku: 'mini' });
  const tampered = cRes.body.orderNo;   // 单号是中台发的,金额也在中台,客户端改不动
  let ok2 = 0;
  for (let i=0;i<70;i++){ const g = await post(genH,{scene:'wedding',image:'data:image/jpeg;base64,x',orderNo:tampered},'10.0.0.5');
    if (g.code===200) ok2++; else break; }
  console.log(`改后订单号 ${tampered}  出图 ${ok2} 张 (金额在中台,客户端改不动→只能出5张)`);

  console.log('\n=== IP 限流(同一 IP 1小时上限80次)===');
  let n=0; for (let i=0;i<95;i++){ const c=await post(createH,{sku:'studio'});
    const g=await post(genH,{scene:'wedding',image:'data:image/jpeg;base64,x',orderNo:c.body.orderNo},'10.9.9.9');
    if(g.code===429){ n=i; break; } }
  console.log(`同 IP 第 ${n} 次被 429 拦下`);

  const pass = mini===5 && shoot===20 && studio===60 && ok===20 && ok2===5 && n>0;
  console.log('\n' + (pass ? '✅ 全部通过' : '❌ 有不符合预期的'));
  process.exit(pass?0:1);
})();
