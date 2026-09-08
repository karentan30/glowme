#!/usr/bin/env node
/* 站点上线关卡 — 零依赖·零 token·可进 CI
 * 用法:
 *   node site-audit.js --dir <本地目录>            扫本地 .html
 *   node site-audit.js --url <网址> [网址...]      抓线上页面(SPA/SSR 工程用这个)
 *   --json  机器可读 · 有 FAIL 时退出码=1(CI 红灯) · 0 页可查时退出码=2
 */
const fs=require('fs'), path=require('path');

/* 允许出现在英文页的中文:语言切换链接 / 品牌名 / 设计资产。新增例外改这里。 */
const ALLOW=[
  /中文版?(法律文件)?s*(→|->)?/g,          // 语言切换:中英分站唯一互通入口
  /善缘/g, /善s*緣/g, /舞镜/g,             // 品牌名
  /[甲乙丙丁戊己庚辛壬癸]/g,                  // 天干:命盘数据本身(bazi.html 就有 12,319 个)
  /[子丑寅卯辰巳午未申酉戌亥]/g,              // 地支:同上
  /[金木水火土]/g,                           // 五行:同上
  /[心經金剛經般若波羅蜜多菩薩功德回向空觀自在]/g, // 佛经原文:sutra 页是原文配英译
];

function visible(html){
  return html.replace(/<script[\s\S]*?<\/script>/gi,'\n')
             .replace(/<style[\s\S]*?<\/style>/gi,'\n')
             .replace(/<!--[\s\S]*?-->/g,'\n')
             .replace(/<[^>]+>/g,'\n')
             .replace(/&[a-z#0-9]+;/gi,' ');
}
function isEnglishPage(file,html){
  if(/-(en|EN).html$/.test(file) || path.basename(file).toLowerCase()==='en.html') return true;
  if(/\/en(\/|$)/.test(file)) return true;
  const m=html.match(/<html[^>]*lang="([^"]+)"/i);
  return m ? /^en/i.test(m[1]) : false;
}
function audit(file,html){
  const out=[];
  const en=isEnglishPage(file,html);
  const langAttr=(html.match(/<html[^>]*lang="([^"]+)"/i)||[])[1]||'';

  if(/BAILOUT_TO_CLIENT_SIDE_RENDERING/.test(html))
    out.push(['FAIL','csr-bailout','服务端渲染降级为纯客户端:爬虫和 OG 抓取器看到空页面']);

  if(en){
    let v=visible(html);
    ALLOW.forEach(re=>{ v=v.replace(re,' '); });
    const hits=[...new Set((v.match(/[一-鿿]+/g)||[]))];
    if(hits.length) out.push(['FAIL','cjk-in-en',hits.slice(0,8).join(' / ')]);
    if(langAttr && !/^en/i.test(langAttr)) out.push(['FAIL','lang-attr','英文页却是 lang="'+langAttr+'"']);
  }
  if(!/application\/ld\+json/.test(html)) out.push(['WARN','no-ld-json','缺结构化数据']);
  if(!/rel="canonical"/.test(html))       out.push(['WARN','no-canonical','缺 canonical']);
  if(!/hreflang=/.test(html))             out.push(['WARN','no-hreflang','缺 hreflang']);
  if(!/og:image/.test(html))              out.push(['WARN','no-og-image','缺 og:image']);
  if(!/name="description"/i.test(html))   out.push(['WARN','no-description','缺 meta description']);
  return out;
}
function fetchUrl(u){
  const lib=u.startsWith('https')?require('https'):require('http');
  return new Promise((res,rej)=>{lib.get(u,{headers:{'user-agent':'site-audit'}},r=>{
    if(r.statusCode>=300&&r.statusCode<400&&r.headers.location) return fetchUrl(new URL(r.headers.location,u).href).then(res,rej);
    let d='';r.setEncoding('utf8');r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});
}
(async()=>{
  const a=process.argv.slice(2), asJson=a.includes('--json'), NL=String.fromCharCode(10);
  let targets=[];
  const di=a.indexOf('--dir');
  if(di>=0){
    const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{
      const p=path.join(d,e.name);
      if(e.isDirectory()) return /node_modules|\.git|archive/.test(p)?[]:walk(p);
      return /\.html$/.test(e.name)?[p]:[];});
    try{ targets=walk(a[di+1]).map(f=>({name:f,html:fs.readFileSync(f,'utf8')})); }
    catch(e){ console.error('读取目录失败: '+e.message); process.exit(2); }
  }
  const ui=a.indexOf('--url');
  if(ui>=0) for(const u of a.slice(ui+1).filter(x=>x.startsWith('http')))
    try{ targets.push({name:u,html:await fetchUrl(u)}); }catch(e){ console.error('抓取失败 '+u+': '+e.message); }

  /* 防假绿灯:0 页不是「通过」,是「什么都没测」 */
  if(targets.length===0){
    console.error(NL+'没有找到任何可检查的页面 —— 这不是通过,是没测到东西。');
    if(di>=0){
      const dir=a[di+1];
      const hints=[['next.config.mjs','Next.js'],['next.config.js','Next.js'],['vite.config.ts','Vite'],
                   ['vite.config.js','Vite'],['nuxt.config.ts','Nuxt'],['svelte.config.js','SvelteKit']];
      let hit=null; for(const h of hints){ try{ if(fs.existsSync(path.join(dir,h[0]))){hit=h;break;} }catch(_){} }
      if(hit) console.error('   检测到 '+hit[1]+' 工程:页面由框架在运行时生成,源码里没有 .html 文件。');
      else    console.error('   目录里没有 .html 文件。');
    }
    console.error('   改用线上抓取: node audit/site-audit.js --url https://站点/页1 https://站点/页2 ...'+NL);
    process.exit(2);
  }

  let fail=0,warn=0; const report=[];
  for(const t of targets){
    const r=audit(t.name,t.html);
    if(!r.length) continue;
    r.forEach(x=>x[0]==='FAIL'?fail++:warn++);
    report.push({page:t.name,issues:r});
  }
  if(asJson) console.log(JSON.stringify({checked:targets.length,fail,warn,report},null,2));
  else{
    for(const {page,issues} of report){
      const f=issues.filter(i=>i[0]==='FAIL');
      if(!f.length) continue;
      console.log(NL+'FAIL  '+page);
      f.forEach(i=>console.log('   ['+i[1]+'] '+i[2]));
    }
    console.log(NL+'受检 '+targets.length+' 页 · FAIL '+fail+' · WARN '+warn);
  }
  process.exit(fail>0?1:0);
})();
