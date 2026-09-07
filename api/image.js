/**
 * GET /api/image?url=<火山TOS图片URL>
 * 代理火山图片并带 CORS 头 → 前端 canvas 不会被跨域污染(可下载/加水印/分享)。
 * 仅允许 volces.com 域(防 SSRF/开放代理)。
 */
'use strict';

module.exports = async function handler(req, res) {
  const u = new URL(req.url, 'https://x').searchParams.get('url') || '';
  if (!/^https:\/\/[\w.-]*volces\.com\//.test(u)) {
    return res.status(400).json({ error: 'bad url' });
  }
  try {
    const r = await fetch(u);
    if (!r.ok) return res.status(502).json({ error: 'fetch failed' });
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(502).json({ error: 'proxy error' });
  }
};
