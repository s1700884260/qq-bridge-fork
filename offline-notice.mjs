// offline-notice.mjs -- daily 08:00 clock off in the groups, 18:00 back on.
//
// Runs from Windows Task Scheduler so it works even when DSH or the bridge is down.
// "Off work" = post a short line to every whitelisted group, then flip the bridge's
// role state to silent: 群聊完全不唤醒（一个 token 都不花），私聊照常。
//
// Usage:
//   node offline-notice.mjs down [--dry]
//   node offline-notice.mjs up   [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(ROOT, 'state');
const ROLE_STATE = path.join(STATE, 'current-role.json');
const CONFIG = path.join(ROOT, 'config.json');
const LOG = path.join(STATE, 'offline-notice.log');

const args = process.argv.slice(2);
const mode = args.includes('up') ? 'up' : 'down';
const dry = args.includes('--dry');

function log(line) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = `${stamp} [offline-notice] ${line}`;
  console.log(text);
  if (!dry) { try { fs.appendFileSync(LOG, text + '\n', 'utf8'); } catch {} }
}

const FAREWELL = [
  '到点啦，我先下班了，晚上六点再出来干活。',
  '八点了，收工。白天群里的活儿先交给你们，晚上见。',
  '上班时间到——我先撤，晚上六点回来。',
  '我下班了，今天聊得挺开心，晚上再来。',
  '打卡下班，白天不接话了，晚上六点我再来。',
  '这个点该歇了，我下线了，晚上六点见。',
  '收工，我要回去充电了，晚上六点准时上线。',
  '下班咯，群消息晚上再看。',
];

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

/** 通过桥接接口切模式：会顺带清掉/重排群聊定时器；桥接没在跑就退回直接写状态文件。 */
async function setSilent(silent) {
  const prev = readJson(ROLE_STATE, { role: null, mode: 'active' });
  const next = { role: prev.role ?? null, mode: silent ? 'silent' : 'active' };
  if (dry) { log(`[dry] 角色状态 -> mode=${next.mode}`); return; }
  try {
    const token = String(fs.readFileSync(path.join(STATE, 'console-token'), 'utf8')).trim();
    const res = await fetch('http://127.0.0.1:3100/api/role-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-console-token': token },
      body: JSON.stringify({ mode: next.mode }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok !== true) throw new Error(body.error || `HTTP ${res.status}`);
    log(`角色状态 mode=${next.mode}（role=${next.role ?? '无'}，群聊 ${body.groups ?? '?'} 个）`);
    return;
  } catch (error) {
    log(`桥接接口不可用（${error?.message ?? error}），直接写状态文件`);
  }
  fs.writeFileSync(ROLE_STATE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  log(`角色状态 mode=${next.mode}（role=${next.role ?? '无'}）`);
}

async function sendToGroup(groupId, message) {
  const token = String(fs.readFileSync(path.join(STATE, 'console-token'), 'utf8')).trim();
  const res = await fetch('http://127.0.0.1:3100/api/test-send', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-console-token': token },
    body: JSON.stringify({ kind: 'group', id: groupId, message }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

if (mode === 'up') {
  log('晚上班：解除静默，群聊恢复');
  await setSilent(false);
  process.exit(0);
}

const cfg = readJson(CONFIG, {});
const groups = Array.isArray(cfg?.allow?.groups) ? cfg.allow.groups.map(String) : [];
if (!groups.length) {
  log('白名单里没有群，跳过告示，仅进入静默');
  await setSilent(true);
  process.exit(0);
}

const line = FAREWELL[Math.floor(Math.random() * FAREWELL.length)];
for (const gid of groups) {
  if (dry) { log(`[dry] 将发送到 group:${gid}：${line}`); continue; }
  try {
    await sendToGroup(gid, line);
    log(`已发送下班告示到 group:${gid}`);
  } catch (error) {
    log(`发送到 group:${gid} 失败：${error?.message ?? error}（桥接没在跑？）`);
  }
}
await setSilent(true);
log('已进入静默：群聊完全不唤醒（不烧 token），私聊照常；18:00 由 QQBridge-Online 恢复');
