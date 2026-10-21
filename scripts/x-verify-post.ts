#!/usr/bin/env bun
/**
 * x-verify-post.ts — 验证报告是否真的发到 X 上了（不看脚本自述，直接查 X 页面）。
 *
 * 为什么需要：2026-10-14 脚本报 "Post submitted!" 但实际内容被污染（标签重复 12 次），
 * 而我当时只凭脚本输出就说"发布成功"。必须去 X 页面上读真实推文。
 *
 * 用法：
 *   bun x-verify-post.ts                     # 查今天发出去的推
 *   bun x-verify-post.ts --date 2026-10-14   # 查指定日期
 *   bun x-verify-post.ts --expect-tags 2     # 断言标签去重后不超过 2 个（有重复则报警）
 *
 * 退出码：0 = 找到且各项正常；2 = 找到但内容异常；4 = 没找到（可能没发成功或被限流）
 */

const UTILS = '<your-hermes-skills>/creative/baoyu-post-to-x/scripts/x-utils.js';
const { CdpConnection } = await import(UTILS);
import { spawnSync } from 'node:child_process';

const HANDLE = process.env.X_HANDLE || '<your_x_handle>';
const PROFILE_HINT = 'baoyu-skills/chrome-profile';

const argv = process.argv.slice(2);
const arg = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const dateArg = arg('--date');
const maxTags = Number(arg('--expect-tags') ?? '99');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function findPort(): number | null {
  const r = spawnSync('bash', ['-lc',
    `pgrep -fl "user-data-dir=.*${PROFILE_HINT}" | head -1 | grep -o 'remote-debugging-port=[0-9]*' | head -1 | cut -d= -f2`
  ], { encoding: 'utf-8' });
  const p = parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(p) ? p : null;
}

const port = findPort();
if (!port) { console.error('未找到 X 专用 Chrome（先跑 x-publish-report.ts 启动它）'); process.exit(3); }

const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
const targets = await listRes.json();
const page = targets.find((t: any) => t.type === 'page' && (t.url || '').includes('x.com'));
if (!page) { console.error('X 页面不存在'); process.exit(3); }

const cdp = await CdpConnection.connect(page.webSocketDebuggerUrl, 30000, { defaultTimeoutMs: 25000 });
const ev = async (expr: string) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return (r as any)?.result?.value ?? (r as any)?.value ?? null;
};

// 用本地日期（北京时间）作为筛选基准
const want = dateArg || spawnSync('bash', ['-lc', 'TZ=Asia/Shanghai date +%Y-%m-%d'], { encoding: 'utf-8' }).stdout.trim();
console.log('查询日期(北京):', want);

await ev(`location.href = "https://x.com/${HANDLE}"`);
await sleep(11000);

const raw = await ev(`(() => {
  const out = [];
  for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
    const t = a.querySelector('time');
    const dt = t ? t.getAttribute('datetime') : '';
    if (!dt) continue;
    const txt = (a.querySelector('[data-testid="tweetText"]') || {}).textContent || '';
    const imgs = [...a.querySelectorAll('img')].filter(i => (i.src||'').includes('media')).length;
    const link = [...a.querySelectorAll('a[href*="/status/"]')].map(x => x.getAttribute('href')).find(h => /status\\/\\d+$/.test(h||'')) || '';
    const tags = txt.match(/#[^\\s#]+/g) || [];
    const counts = {}; for (const x of tags) counts[x] = (counts[x]||0)+1;
    out.push({ dt, imgs, link, text: txt, counts });
  }
  return JSON.stringify(out);
})()`);

const all = JSON.parse(String(raw)) as any[];
// 把 UTC 时间转成北京时间日期来比对
const todayPosts = all.filter(p => {
  const bj = new Date(new Date(p.dt).getTime() + 8 * 3600 * 1000);
  const d = bj.toISOString().slice(0, 10);
  return d === want;
});

console.log('该日期推文数:', todayPosts.length);
if (!todayPosts.length) {
  console.error('❌ 没找到该日期的推文 —— 可能未发布成功，或 X 尚未刷新（稍后重试）');
  cdp.close();
  process.exit(4);
}

let bad = false;
for (const p of todayPosts) {
  const dup = Object.values(p.counts).some((v: any) => v > 1);
  const tagCount = Object.keys(p.counts).length;
  const head = p.text.split('\n')[0].slice(0, 40);
  const flags: string[] = [];
  if (dup) flags.push('标签重复');
  if (tagCount > maxTags) flags.push(`标签数 ${tagCount} > ${maxTags}`);
  if (p.imgs === 0) flags.push('无配图');
  if (flags.length) bad = true;
  console.log('---');
  console.log('  时间(北京):', new Date(new Date(p.dt).getTime() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19));
  console.log('  链接:', 'https://x.com' + p.link);
  console.log('  开头:', head);
  console.log('  配图:', p.imgs, '| 标签:', JSON.stringify(p.counts));
  console.log('  判定:', flags.length ? '⚠️ ' + flags.join(' / ') : '✅ 正常');
}

cdp.close();
process.exit(bad ? 2 : 0);
