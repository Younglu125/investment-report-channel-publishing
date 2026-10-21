#!/usr/bin/env bun
/**
 * x-clear-compose.ts — 复位 X compose 编辑器（含已附图片）。
 *
 * 用途：发布脚本失败、或只想预览不发布时，把编辑器复位，避免残留内容被误发。
 *
 * 原理：**关掉现有 x.com 标签、重新开一个** —— 比 reload 更彻底，
 *      也避开 reload 导致 CDP 连接失效的问题（Draft.js 内容不在 innerText 里，
 *      用 DOM 清空会静默失效，见 SKILL.md 坑2）。
 *
 * 用法：bun x-clear-compose.ts
 */

import { spawnSync } from 'node:child_process';

const PROFILE_HINT = 'baoyu-skills/chrome-profile';
const COMPOSE_URL = 'https://x.com/compose/post';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const port = parseInt(spawnSync('bash', ['-lc',
  `pgrep -fl "user-data-dir=.*${PROFILE_HINT}" | head -1 | grep -o 'remote-debugging-port=[0-9]*' | head -1 | cut -d= -f2`
], { encoding: 'utf-8' }).stdout.trim(), 10);
if (!Number.isFinite(port)) { console.error('未找到 X 专用 Chrome'); process.exit(3); }

const list = async (): Promise<any[]> => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];

const xs = (await list()).filter((t: any) => t.type === 'page' && (t.url || '').includes('x.com'));
for (const t of xs) {
  try { await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`, { method: 'PUT' }); } catch { /* 忽略 */ }
}
console.log(`已关闭 ${xs.length} 个 x.com 标签`);
await sleep(1200);

await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(COMPOSE_URL)}`, { method: 'PUT' });
await sleep(6000);

const after = (await list()).filter((t: any) => t.type === 'page' && (t.url || '').includes('x.com'));
console.log('新建标签:', after.length ? after[0].url : '（失败）');
console.log('✅ 编辑器已复位（新标签 = 空编辑器）');
