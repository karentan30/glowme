/**
 * GET /api/video/status?requestId=xxx
 *   转发查 SiliconFlow i2v 任务状态 → 返回 { status, url }。
 *   status: InProgress | Succeed | Failed;成功时 url = 视频地址。
 * Env: SILICONFLOW_API_KEY
 */
'use strict';

const SF_KEY = process.env.SILICONFLOW_API_KEY || '';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!SF_KEY) return res.status(503).json({ error: 'Video engine not configured.' });

  const requestId = (req.query && req.query.requestId) ||
    new URL(req.url, 'http://x').searchParams.get('requestId') || '';
  if (!requestId) return res.status(400).json({ error: 'Missing requestId.' });

  let sfRes, sfJson;
  try {
    sfRes = await fetch('https://api.siliconflow.cn/v1/video/status', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SF_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
    sfJson = await sfRes.json();
  } catch (e) {
    console.error('[video/status] SiliconFlow unreachable', e);
    return res.status(502).json({ error: 'Video service temporarily unavailable.' });
  }

  if (!sfRes.ok) {
    console.error('[video/status] SF error', sfRes.status, JSON.stringify(sfJson).slice(0, 300));
    return res.status(502).json({ error: 'Could not check video status.' });
  }

  const status = sfJson?.status || 'InProgress';
  const url = sfJson?.results?.videos?.[0]?.url || '';
  return res.status(200).json({ status, url });
};
