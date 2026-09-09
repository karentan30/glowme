/**
 * GET /api/scenes —— 给前端渲染情侣场景选择器。
 * 只吐 id / 分类 / 名称 / 是否爆款,**绝不吐 prompt 和负面词**:
 * 那套 prompt 库是花时间调出来的资产,吐出去等于把款库送人。
 */
'use strict';

const { COUPLE_SCENES } = require('./couple-scenes.js');

const PUBLIC = COUPLE_SCENES.map((s) => ({
  id: s.id, cat: s.cat, catLabel: s.catLabel, label: s.label, hot: !!s.hot,
}));

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return res.status(200).json({ ok: true, scenes: PUBLIC });
};
