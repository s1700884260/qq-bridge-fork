// set-mode.mjs -- 只切换角色模式（active / silent），不发任何告别语。
//
// 为什么不用 offline-notice.mjs：那个脚本会在切静默前向所有白名单群发一句告别语，
// 适合「晚上下班」；但早上 8 点切静默时发告别语很奇怪。定时上下班用这个更干净。
//
// 优先走桥接的 /api/role-mode：它会顺带清掉（silent）/ 重排（active）群聊定时器，
// 避免下班前留下的计时器半夜把群聊叫醒。桥接没在跑就退回直接写状态文件。
//
// 用法：
//   node set-mode.mjs silent
//   node set-mode.mjs active
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const STATE = path.join(ROOT, 'state');
const ROLE_FILE = path.join(STATE, 'current-role.json');

const arg = String(process.argv[2] ?? '').trim().toLowerCase();
if (arg !== 'silent' && arg !== 'active') {
  console.error('用法: node set-mode.mjs silent|active');
  process.exit(2);
}

let prev = { role: null, mode: 'active' };
try { prev = JSON.parse(fs.readFileSync(ROLE_FILE, 'utf8')); } catch {}
const next = { role: prev?.role ?? null, mode: arg };

try {
  const token = String(fs.readFileSync(path.join(STATE, 'console-token'), 'utf8')).trim();
  const res = await fetch('http://127.0.0.1:3100/api/role-mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-console-token': token },
    body: JSON.stringify({ mode: arg }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) throw new Error(body.error || `HTTP ${res.status}`);
  console.log(`[mode] ${prev?.mode ?? '(unknown)'} -> ${arg}（角色: ${next.role ?? '默认'}，群聊 ${body.groups ?? '?'} 个）`);
  process.exit(0);
} catch (error) {
  console.log(`[mode] 桥接接口不可用（${error?.message ?? error}），直接写状态文件`);
}

fs.writeFileSync(ROLE_FILE, JSON.stringify(next, null, 2));
console.log(`[mode] ${prev?.mode ?? '(unknown)'} -> ${arg}（角色: ${next.role ?? '默认'}）`);
