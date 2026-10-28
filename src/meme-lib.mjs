// meme-lib.mjs —— 把 dsh-meme 的 `[表情: 描述]` 标记解析成本地图片路径。
//
// 为什么需要它：dsh-meme 的原生 IM 发图依赖 dsh-im / dsh-companion；qq-bridge 两者都不是，
// 所以它在 QQ 侧只会把方括号文字发出去。这里直接读 dsh-meme 自己的图库索引
// （每套图库一个 index.db，表 memes(path, tag, caption, keywords, ...)），把描述映射回图片。
// 只读、只在本机：不联网、不改图库文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');

// 描述里不允许出现右括号或换行。括号兼容【】/［］：模型偶尔会写全角括号，
// 只认 [] 的话那种标记会被当成普通文字原样发到 QQ。
const MARKER_RE = /[\[【［]\s*表情\s*[:：]\s*([^\]】］\n]{1,200})\s*[\]】］]/g;

/** 找出所有可用图库的 index.db：用户图库 + 各 profile 里装着的内置图库。 */
function indexFiles() {
  const out = new Set();
  const addPacks = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const db = path.join(dir, e.name, 'index.db');
      try { if (fs.statSync(db).isFile()) out.add(db); } catch {}
    }
  };
  addPacks(path.join(DSH_HOME, 'meme-packs'));
  const profiles = path.join(DSH_HOME, 'profiles');
  let profileDirs = [];
  try { profileDirs = fs.readdirSync(profiles, { withFileTypes: true }); } catch {}
  for (const p of profileDirs) {
    if (!p.isDirectory()) continue;
    addPacks(path.join(profiles, p.name, 'node_modules', 'dsh-meme', 'memes'));
  }
  return [...out];
}

let cache = { at: 0, entries: [] };
const CACHE_MS = 30_000;

/** 读全部图库索引并摊平；30 秒内存缓存（图库改了最多半分钟生效）。 */
export function loadIndex(force = false) {
  if (!force && Date.now() - cache.at < CACHE_MS) return cache.entries;
  const entries = [];
  for (const dbFile of indexFiles()) {
    const packDir = path.dirname(dbFile);
    const packId = path.basename(packDir);
    let db;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      const rows = db.prepare('SELECT path, tag, caption, keywords FROM memes').all();
      for (const r of rows) {
        if (!r || !r.path) continue;
        entries.push({
          packId,
          file: path.join(packDir, String(r.path)),
          tag: String(r.tag || ''),
          caption: String(r.caption || '').trim(),
          keywords: String(r.keywords || '').trim(),
        });
      }
    } catch {
      // 索引损坏/被占用：跳过这一套，不影响其它图库。
    } finally {
      try { db?.close(); } catch {}
    }
  }
  cache = { at: Date.now(), entries };
  return entries;
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// 宽松归一：去掉空白、全角/半角标点、括号里的补充说明。
// 模型抄描述时常会改一个标点、省掉「（呆滞无语）」这类括注 —— 严格比较会判成没命中，
// 结果是标记原样发到 QQ。必须按“意思相同”比，而不是按字节比。
const loose = (s) => String(s ?? '')
  .replace(/[\s\u3000]+/g, '')
  .replace(/[（(][^）)]*[）)]/g, '')
  .replace(/[，,。.！!？?、;；:：'"“”‘’…~～·\-—_]+/g, '')
  .toLowerCase();

/** 按描述找图：宽松精确 → 双向包含 → 关键词打分。找不到返回 null（调用方保留原文）。 */
export function resolveMeme(caption) {
  const want = norm(caption);
  if (!want) return null;
  const wantLoose = loose(want);
  const entries = loadIndex();
  if (wantLoose) {
    const exactLoose = entries.find((e) => loose(e.caption) === wantLoose);
    if (exactLoose) return exactLoose.file;
  }
  const exact = entries.find((e) => norm(e.caption) === want);
  if (exact) return exact.file;
  if (wantLoose.length >= 4) {
    const partialLoose = entries.find((e) => {
      const c = loose(e.caption);
      if (c.length < 4) return false;
      return c.includes(wantLoose) || wantLoose.includes(c);
    });
    if (partialLoose) return partialLoose.file;
  }
  const partial = entries.find((e) => {
    const c = norm(e.caption);
    return c.includes(want) || (want.includes(c) && c.length >= 4);
  });
  if (partial) return partial.file;
  const tokens = want.split(/[\s,，、]+/).filter((t) => t.length >= 2);
  if (tokens.length) {
    const scored = entries
      .map((e) => {
        const hay = loose(`${e.caption} ${e.keywords} ${e.tag}`);
        return { e, score: tokens.filter((t) => hay.includes(loose(t))).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length) return scored[0].e.file;
  }
  return null;
}

/**
 * 从一段回复里剥离 `[表情: 描述]` 标记。
 * @returns {{ text: string, captions: string[] }}
 */
export function parseMemeMarkers(reply) {
  const captions = [];
  const text = String(reply ?? '').replace(MARKER_RE, (_, caption) => {
    captions.push(norm(caption));
    return '';
  });
  return { text: text.replace(/[ \t]{2,}/g, ' ').replace(/^\s+|\s+$/g, ''), captions };
}
