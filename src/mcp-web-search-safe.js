// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - 搜索：优先走 **DSH 同一路 DeepSeek 联网搜索**（src/web-search.js：同一端点/模型/
//   服务端 web_search 工具，凭据取 config/env/DSH 的 .credentials.yaml），
//   不可用时回退 Bing（RSS 优先）。搜索词不再默认发给 Bing。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import path from 'node:path';
import { safeFetch } from './safe-fetch.js';
import { webSearch } from './web-search.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * 项目根目录（用于读 config.json 的 webSearch 段）。
 *
 * 不能用 `import.meta.url`：离线测试会把本文件塞进 vm 上下文执行（那里没有 import.meta，
 * 直接是语法错误）。DSH 以 `node <本文件绝对路径>` 启动 MCP，所以 argv[1] 就是本文件；
 * 取它的上一级 `src/` 的父目录即可。取不到时退回 cwd（测试环境正好从仓库根运行）。
 */
function projectRoot() {
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {}
  return process.cwd();
}

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const server = new McpServer({ name: 'web-search-safe', version: '0.2.1-r1' });

/**
 * 百度新闻搜索（管理端指定：搜新闻优先走百度）。
 *
 * 走新闻频道 `tn=news`：结果集中在 baijiahao / 各新闻站，比网页搜索干净。
 * 搜狐的公开搜索接口已经失效（search.sohu.com 的 api 全 404、页面是 JS 空壳），
 * 所以「搜狐新闻」用 `site:sohu.com` 限定在百度新闻里搜 —— 结果仍是搜狐原文链接。
 */
async function baiduNewsSearch(query, limit = 8) {
  const count = Math.min(20, Math.max(3, Number(limit) || 8));
  const url = `https://www.baidu.com/s?rtt=1&bsst=1&cl=2&tn=news&word=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://www.baidu.com/',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`百度新闻返回 HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const seen = new Set();
  // 新闻结果结构：<h3 ...><a href="...">标题</a>；标题里可能夹 <em> 高亮。
  for (const m of html.matchAll(/<h3[^>]*>[\s\S]{0,400}?<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,160}?)<\/a>/g)) {
    const href = m[1].replace(/&amp;/g, '&');
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || !/^https?:\/\//i.test(href) || seen.has(href)) continue;
    seen.add(href);
    out.push({ title, url: href });
    if (out.length >= count) break;
  }
  return out;
}

/**
 * 搜狗新闻：`news.sogou.com/news?query=`。
 * 结果是 h3 标题 + `news.sogou.com/link?url=...` 跳转链（跟随重定向后是原文）。
 */
async function sogouNewsSearch(query, limit = 8) {
  const count = Math.min(20, Math.max(3, Number(limit) || 8));
  const url = `https://news.sogou.com/news?query=${encodeURIComponent(query)}&mode=1`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`搜狗新闻返回 HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<h3[^>]*>[\s\S]{0,300}?<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,140}?)<\/a>/g)) {
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (title.length < 6) continue;
    let abs = m[1];
    try { abs = new URL(m[1], 'https://news.sogou.com').toString(); } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ title, url: abs });
    if (out.length >= count) break;
  }
  return out;
}

/**
 * 360 搜索：`www.so.com/s?q=`。
 * 结果同样走 `so.com/link?m=` 跳转链；要过滤掉 360 自己的图片/视频/应用聚合页
 * （实测混着 image.so.com、m.so.com、news.so.com/ns 这些无关条目）。
 */
async function so360Search(query, limit = 8) {
  const count = Math.min(20, Math.max(3, Number(limit) || 8));
  const url = `https://www.so.com/s?q=${encodeURIComponent(query)}&pn=1`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`360 搜索返回 HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<h3[^>]*>[\s\S]{0,300}?<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,140}?)<\/a>/g)) {
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (title.length < 6) continue;
    let abs = m[1];
    try { abs = new URL(m[1], 'https://www.so.com').toString(); } catch { continue; }
    let host = '';
    try { host = new URL(abs).host; } catch { continue; }
    // 只保留跳转链（/link?m=）或站外直链，排掉 360 自己的聚合页
    const isRedirect = /\/link\?/i.test(abs);
    const isAggregator = /(^|\.)so\.com$|(^|\.)360\.(cn|com)$/i.test(host);
    if (!isRedirect && isAggregator) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ title, url: abs });
    if (out.length >= count) break;
  }
  return out;
}

/**
 * 必应网页搜索（cn.bing.com）。
 *
 * 为什么用 h2>a 而不是 `<li class="b_algo">…<h2>`：Bing 会在 li 开头塞一大段
 * `<link rel="stylesheet">`（几百字符），按固定窗口匹配会直接错过标题。
 * 这里直接扫全文的 h2 内链接，再排掉 Bing 自家的导航链接。
 */
async function bingWebSearch(query, limit = 8) {
  const count = Math.min(20, Math.max(3, Number(limit) || 8));
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&count=${count + 4}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Bing 返回 HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<h2[^>]*>([\s\S]{0,400}?)<\/h2>/g)) {
    const a = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,160}?)<\/a>/.exec(m[1]);
    if (!a) continue;
    const href = a[1];
    const title = a[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (title.length < 6 || !/^https?:\/\//i.test(href)) continue;
    let host = '';
    try { host = new URL(href).host; } catch { continue; }
    // 排掉 Bing 自己的页面（设置、图片、视频、词典等）
    if (/(^|\.)bing\.com$|(^|\.)microsoft\.com$|(^|\.)msn\.com$/i.test(host)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ title, url: href });
    if (out.length >= count) break;
  }
  return out;
}

server.tool(
  'web_search',
  '只读联网搜索。万能用法：想搜某个站的内容就传 site（如 site="zhihu.com"），内部用 `site:域名` 限定在百度/搜狗里搜，不需要为每个站写适配；拿到 URL 后再用 web_fetch 抓正文。不传 site 时按 source 走百度新闻/搜狗/360/搜狐，最后回退 DeepSeek、Bing。返回标题/URL，不执行任何本地操作。',
  {
    query: z.string().describe('要搜索确认的网络用语/黑话/梗/事实性问题/新闻'),
    source: z.enum(['auto', 'baidu', 'sohu', 'sogou', 'so360', 'bing']).optional().describe('auto=默认（先百度新闻）；baidu=百度新闻；sohu=搜狐站内；sogou=搜狗新闻；so360=360 搜索；bing=必应'),
    site: z.string().optional().describe('限定站点，只写域名即可（例：zhihu.com / github.com / bilibili.com）。给了它就在该站内搜，不用管 source'),
  },
  async ({ query, source, site }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    // site 只取域名部分：允许传 "https://zhihu.com/xxx"、"zhihu.com"、"www.zhihu.com"
    let domain = String(site ?? '').trim().toLowerCase();
    if (domain) {
      domain = domain.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].replace(/:\d+$/, '');
      domain = domain.replace(/^www\./, '');
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
        return { content: [{ type: 'text', text: `site 参数不是有效域名：${site}` }], isError: true };
      }
    }
    const effectiveQuery = domain ? `${clean} site:${domain}` : clean;
    const mode = source ?? 'auto';
    const label = {
      baidu: '百度新闻',
      sohu: '搜狐（百度新闻站内）',
      sogou: '搜狗新闻',
      so360: '360 搜索',
      bing: '必应',
    }[mode];
    try {
      let items = [];
      if (mode === 'sogou') items = await sogouNewsSearch(effectiveQuery, 8);
      else if (mode === 'so360') items = await so360Search(effectiveQuery, 8);
      else if (mode === 'bing') items = await bingWebSearch(effectiveQuery, 8);
      else items = await baiduNewsSearch(effectiveQuery, 8);
      if (items.length === 0 && (domain || mode === 'auto')) {
        // 站内新闻搜不到（很多站没有新闻频道）或 auto 没命中：再用网页搜索兜
        items = await so360Search(effectiveQuery, 8);
      }
      if (items.length === 0 && mode !== 'auto' && !domain) {
        items = await bingWebSearch(effectiveQuery, 8);
      }
      if (items.length === 0 && mode !== 'auto') {
        return { content: [{ type: 'text', text: `${label}没搜到「${clean}」。换个更短的关键词，或者把 source 改成 auto 让我换个源试。` }], isError: true };
      }
      if (items.length > 0) {
        const lines = items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}`);
        const from = domain ? `站内搜索 ${domain}` : (mode === 'auto' ? '百度新闻/360' : label);
        return {
          content: [{
            type: 'text',
            text: `「${clean}」${from} ${items.length} 条：\n${lines.join('\n')}\n\n（要看全文就用 web_fetch 抓其中一条的 URL）`,
          }],
        };
      }
    } catch (error) {
      if (mode !== 'auto' || domain) {
        return { content: [{ type: 'text', text: `${label}搜索失败：${error?.message ?? error}` }], isError: true };
      }
    }
    // auto 的兜底：百度新闻也不行就退回 DeepSeek / Bing
    try {
      const result = await webSearch(clean, { root: projectRoot() });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

/**
 * 抓取网页，并跟随「JS / meta 跳转」外壳页。
 *
 * 为什么要这个：百度、360 的搜索结果给的是自家跳转链接（so.com/link?m=…），
 * 直接抓只拿到一段 `window.location.replace("真实地址")`，正文全丢。
 * 这里识别这种外壳，取出真实地址再抓一次（最多两跳），结果里带上 resolvedFrom。
 */
async function fetchFollowJsRedirect(url, depth = 0) {
  const result = await safeFetch(url);
  if (depth >= 2) return result;
  const body = String(result?.body ?? '');
  // 外壳页通常很短；正文里带 window.location.replace 或 meta refresh
  if (body.length > 4000) return result;
  const js = /window\.location\.replace\(\s*["']([^"']+)["']\s*\)/i.exec(body);
  const meta = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i.exec(body);
  const next = js?.[1] || meta?.[1];
  if (!next || !/^https?:\/\//i.test(next)) return result;
  const followed = await fetchFollowJsRedirect(next, depth + 1);
  return { ...followed, resolvedFrom: url };
}

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。会自动跟随百度/360 搜索结果的 JS 跳转外壳页（拿到真实文章）。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await fetchFollowJsRedirect(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

/**
 * 图片搜索：走 Bing 图片（异步结果页）抓原图直链。
 *
 * 为什么不用 webSearch：DSH 那路联网搜索返回的是**网页**结果，没有图片直链；
 * 而「发一张猫猫比心的图」需要的是可直接下载的图片 URL。这里只检索、不下载：
 * URL 交给桥接的 qq_send_image_url，由那边做 SSRF 校验与大小限制。
 */
async function bingImageSearch(query, limit) {
  const count = Math.min(30, Math.max(4, Number(limit) || 12));
  const url = `https://www.bing.com/images/async?q=${encodeURIComponent(query)}`
    + `&first=1&count=${count * 2}&mkt=zh-CN&adlt=off`;
  const page = await safeFetch(url, 400000);
  const html = typeof page === 'string' ? page : String(page?.text ?? page?.body ?? '');
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const u = String(raw || '').replace(/\\\//g, '/');
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    let host = '';
    try { host = new URL(u).host; } catch {}
    out.push({ url: u, host });
  };
  const re = /murl&quot;:&quot;(https?:\/\/[^&"]+?)&quot;/g;
  let m;
  while ((m = re.exec(html)) !== null && out.length < count) push(m[1]);
  if (out.length === 0) {
    // 兜底：页面结构变了就退化成「扒所有图片直链」，并排掉 Bing 自己的缩略图。
    const re2 = /https?:\/\/[^"'\s\\]+?\.(?:jpe?g|png|gif|webp)(?:\?[^"'\s\\]*)?/gi;
    while ((m = re2.exec(html)) !== null && out.length < count) {
      if (/bing\.com|microsoft\.com|mm\.bing\.net|th\.bing\.com/i.test(m[0])) continue;
      push(m[0]);
    }
  }
  return out.slice(0, count);
}

/**
 * 百度图片搜索（优先用它）。
 *
 * 为什么换主源：Bing 的图片结果对中文二次元查询经常跑偏——实测「提丰 明日方舟 立绘」
 * 返回的是新闻/素材站照片，甚至同一查询直接 0 条；而百度 acjson 接口返回的是
 * 百度图床直链（img0/1/2.baidu.com），**不会热链失效**，也没有水印，群友要的角色图能直接发出去。
 * 代价是只有 ~500×500 的缩略图（百度不给原图直链），够 QQ 显示。
 */
async function baiduImageSearch(query, limit) {
  const count = Math.min(30, Math.max(4, Number(limit) || 12));
  const url = `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&word=${encodeURIComponent(query)}&pn=0&rn=${count}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://image.baidu.com/',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`百度图片返回 HTTP ${res.status}`);
  const json = await res.json().catch(() => ({}));
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(json?.data) ? json.data : []) {
    const u = String(item?.thumbURL || item?.middleURL || '').trim();
    if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
    seen.add(u);
    let host = '';
    try { host = new URL(u).host; } catch {}
    out.push({ url: u, host, title: String(item?.fromPageTitleEnc ?? '').slice(0, 40) });
    if (out.length >= count) break;
  }
  return out;
}

server.tool(
  'web_image_search',
  '按关键词搜索网络图片，返回可直接下载的原图直链（http(s)）与来源域名。用于「搜一张猫猫比心的图」「找个摸鱼表情」「搜二次元角色图」这类需求：拿到候选后挑一个，用 qq_send_image_url 发到 QQ。只做检索、不下载、不写本地；图片版权与来源请自行判断。',
  {
    query: z.string().describe('图片关键词，中文即可，例如「猫猫比心」「提丰 明日方舟 立绘」'),
    limit: z.number().optional().describe('返回几张候选，默认 12，最多 30'),
  },
  async ({ query, limit }) => {
    const clean = sanitizeQuery(query);
    if (!clean) return { content: [{ type: 'text', text: '关键词为空，已拒绝。' }], isError: true };
    try {
      let items = [];
      let source = '百度图片';
      try { items = await baiduImageSearch(clean, limit); } catch { items = []; }
      if (items.length === 0) {
        source = 'Bing';
        try { items = await bingImageSearch(clean, limit); } catch { items = []; }
      }
      if (items.length === 0) {
        return { content: [{ type: 'text', text: `「${clean}」没搜到图片。换个更短的关键词（比如只留角色名）再试。` }], isError: true };
      }
      const lines = items.map((it, i) => `${i + 1}. ${it.host}${it.title ? `（${it.title}）` : ''}  ${it.url}`);
      return {
        content: [{
          type: 'text',
          text: `「${clean}」候选 ${items.length} 张（来源：${source}；挑一张，把 URL 交给 qq_send_image_url）：\n${lines.join('\n')}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `图片搜索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
