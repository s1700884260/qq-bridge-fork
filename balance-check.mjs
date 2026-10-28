// balance-check.mjs -- 查 DeepSeek 开放平台余额，并通过 QQ 私聊通知主人。
//
// 为什么走「桥接的 /api/test-send」而不是 MCP 工具：
//   这是**操作者**通道，不需要会话令牌，也不受 reserved2 的 agent 校验；
//   计划任务在 DSH 没开时也能跑（只要桥接在）。
//
// Key 来源（按顺序）：
//   1. 环境变量 DEEPSEEK_API_KEY（进程内）
//   2. 用户级环境变量 DEEPSEEK_API_KEY
//   3. <qq-bridge>/config.json 的 balance.apiKey（可选，便于你换成别的 key）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(ROOT, 'state');
const CONFIG = path.join(ROOT, 'config.json');
const LOG = path.join(STATE, 'balance-check.log');

const THRESHOLD = Number(process.env.BALANCE_THRESHOLD ?? 3); // 元
const DRY = process.argv.includes('--dry');

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

function log(line) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = `${stamp} [balance] ${line}`;
  console.log(text);
  if (!DRY) { try { fs.appendFileSync(LOG, text + '\n', 'utf8'); } catch {} }
}

function apiKey() {
  const cfg = readJson(CONFIG, {});
  // 计划任务继承用户级环境变量，所以 setx 之后一般直接可用；
  // config.json 的 balance.apiKey 是给「临时换一把 key」留的后门。
  return String(process.env.DEEPSEEK_API_KEY || cfg?.balance?.apiKey || '').trim();
}

async function fetchBalance(key) {
  const res = await fetch('https://api.deepseek.com/user/balance', {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
}

function formatBalance(data) {
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  if (!infos.length) return { text: '（接口没返回余额明细）', total: null };
  const lines = infos.map((b) => {
    const cur = b.currency === 'CNY' ? '元' : b.currency;
    const parts = [`余额 ${b.total_balance} ${cur}`];
    if (b.topped_up_balance && Number(b.topped_up_balance) !== 0) parts.push(`充值 ${b.topped_up_balance}`);
    if (b.granted_balance && Number(b.granted_balance) !== 0) parts.push(`赠送 ${b.granted_balance}`);
    return parts.join('，');
  });
  const cny = infos.find((b) => b.currency === 'CNY') || infos[0];
  return { text: lines.join(' / '), total: Number(cny.total_balance), available: data?.is_available !== false };
}

async function notifyOwner(message) {
  const cfg = readJson(CONFIG, {});
  const owner = String(cfg?.ownerQQ ?? '').trim();
  if (!owner) throw new Error('config.json 里没配 ownerQQ');
  const token = String(fs.readFileSync(path.join(STATE, 'console-token'), 'utf8')).trim();
  const res = await fetch('http://127.0.0.1:3100/api/test-send', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-console-token': token },
    body: JSON.stringify({ kind: 'private', id: Number(owner), message }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const key = apiKey();
if (!key) {
  log('没找到 DEEPSEEK_API_KEY：请先执行 setx DEEPSEEK_API_KEY "sk-..."（然后重开终端/等待任务环境刷新）');
  process.exit(2);
}

try {
  const data = await fetchBalance(key);
  const info = formatBalance(data);
  const low = Number.isFinite(info.total) && info.total < THRESHOLD;
  const message = `💰 DeepSeek 余额：${info.text}`
    + (info.available === false ? '\n⚠️ 账户当前不可用（可能欠费或未实名）' : '')
    + (low ? `\n⚠️ 已低于 ${THRESHOLD} 元阈值，记得充值` : '');
  log(`余额 ${info.text}（阈值 ${THRESHOLD}）${low ? ' 低于阈值' : ''}`);
  if (DRY) { log(`[dry] 将发送：${message.replace(/\n/g, ' / ')}`); process.exit(0); }
  const sent = await notifyOwner(message);
  log(`已通知主人 QQ（message_id=${sent?.message_id ?? '?'}）`);
} catch (error) {
  log(`查询失败：${error?.message ?? error}`);
  process.exit(1);
}
