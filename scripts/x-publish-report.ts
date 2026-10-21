#!/usr/bin/env bun
/**
 * x-publish-report.ts — 把一条投资报告发到 X（Twitter），全流程一次跑完。
 *
 * 方案：**全程走 CDP，不碰剪贴板**（2026-10-16 定）。
 *   文字 → Input.insertText 一次性插入
 *   图片 → DOM.setFileInputFiles 打到页面的 input[type=file]
 *
 * 为什么不用剪贴板（2026-10-14/16 踩坑实录）：
 *   坑1  编辑器有旧内容时会层层叠加 ⇒ 标签重复十几次。
 *        真因不是输入方式，而是「没清空」——用 innerText 读 Draft.js 读到空、
 *        误以为已清空。⇒ 读用 textContent、清空靠 location.reload()。
 *   坑2  X 编辑器是 Draft.js，innerText 读不到内容。
 *   坑3  发布按钮有两个：tweetButton（弹窗内，可点）/ tweetButtonInline（时间线内嵌，恒 disabled）。
 *   坑4  Cmd+V 只送到「前台窗口」，而用户日常浏览器同名为 "Google Chrome"，
 *        且脚本进程常常抢不到前台 ⇒ 粘贴静默失败（编辑器 len=0）。
 *        **改用 CDP 后此坑自动消失。**
 *   坑5  Chrome 可能以 --no-startup-window 跑着但没有任何页面 ⇒ 需要主动 createTarget。
 *
 * 用法：
 *   bun x-publish-report.ts --text /tmp/x_post_20261016.txt \
 *       --image /tmp/acct_masked.jpg --image /tmp/holdings.jpg --submit
 *
 * 不加 --submit：只填内容 + 验证，不发布。
 * 退出码：0 成功；2 内容验证失败（已中止，未发布）；3 浏览器/登录问题。
 */

const UTILS = '<your-hermes-skills>/creative/baoyu-post-to-x/scripts/x-utils.js';
const { CdpConnection } = await import(UTILS);
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const BASE = '<your-hermes-skills>/creative/baoyu-post-to-x/scripts';
const COMPOSE_URL = 'https://x.com/compose/post';
const PROFILE_HINT = 'baoyu-skills/chrome-profile';
const PROFILE_DIR = `${process.env.HOME}/Library/Application Support/${PROFILE_HINT}`;

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const argVal = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const getMany = (f: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === f && argv[i + 1]) out.push(argv[++i]!);
  return out;
};
const textFile = argVal('--text');
const images = getMany('--image');
const submit = argv.includes('--submit');
const maxWaitSec = Number(argVal('--timeout') ?? 180) || 180;

if (!textFile) { console.error('缺少 --text <文件>'); process.exit(2); }
if (!fs.existsSync(textFile)) { console.error('文案文件不存在: ' + textFile); process.exit(2); }

const TEXT = fs.readFileSync(textFile, 'utf-8').replace(/\r\n/g, '\n').trimEnd();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- 找到 Chrome 的 CDP 端口（轮询等待） ----------
function findPort(): number | null {
  const r = spawnSync('bash', ['-lc',
    `pgrep -fl "user-data-dir=.*${PROFILE_HINT}" | head -1 | grep -o 'remote-debugging-port=[0-9]*' | head -1 | cut -d= -f2`
  ], { encoding: 'utf-8' });
  const p = parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(p) && p > 0 ? p : null;
}

async function ensureChrome(): Promise<number> {
  let port = findPort();
  if (port) return port;

  console.log('[0] 未发现 X 专用 Chrome，启动中（需 10-30 秒）...');
  spawnSync('bash', ['-lc',
    `cd $HOME && nohup bun ${BASE}/x-browser.ts "1" --profile "${PROFILE_DIR}" >/tmp/x_warmup.log 2>&1 &`
  ], { encoding: 'utf-8' });

  for (let i = 0; i < 24; i++) {
    await sleep(2000);
    port = findPort();
    if (port) {
      // 端口出现后再等 CDP 真正可连
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) return port;
      } catch { /* 还没就绪，继续等 */ }
    }
  }
  console.error('Chrome 启动超时');
  process.exit(3);
}

async function main() {
  const port = await ensureChrome();
  console.log('[0] CDP 端口:', port);

  const listTargets = async (): Promise<any[]> => {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await res.json()) as any[];
  };
  const findX = (ts: any[]) => ts.find((t: any) => t.type === 'page' && (t.url || '').includes('x.com'));

  let page = findX(await listTargets());
  if (!page) {
    console.log('[0] 无 X 页面，用 CDP 新建...');
    try {
      await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(COMPOSE_URL)}`, { method: 'PUT' });
      await sleep(5000);
      page = findX(await listTargets());
    } catch { /* 下面统一报错 */ }
  }
  if (!page) { console.error('X 页面不存在且创建失败'); process.exit(3); }

  const cdp = await CdpConnection.connect(page.webSocketDebuggerUrl, 30000, { defaultTimeoutMs: 25000 });
  const ev = async (expr: string) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return (r as any)?.result?.value ?? (r as any)?.value ?? null;
  };

  await cdp.send('DOM.enable');

  // ---------- 1) 刷新，保证编辑器干净（坑1/坑2） ----------
  await ev(`location.href = ${JSON.stringify(COMPOSE_URL)}`);
  await sleep(5000);
  await ev(`location.reload()`);
  console.log('[1] 硬刷新 compose 页');
  await sleep(9000);

  const ready = await ev(`(() => { const ed = document.querySelector('[data-testid="tweetTextarea_0"]'); return ed ? 'READY|len=' + (ed.textContent||'').length : 'NOT_FOUND'; })()`);
  console.log('[2] 编辑器:', ready);
  if (!String(ready).startsWith('READY')) {
    console.error('编辑器未就绪 —— 可能需要人工登录 X（脚本会停在 Waiting for X editor）');
    console.error('请在弹出的专用 Chrome 窗口登录一次: ' + PROFILE_DIR);
    cdp.close();
    process.exit(3);
  }

  // ---------- 1b) 清掉 reload 后可能恢复的草稿 ----------
  // 坑7（2026-10-21）：reload 之后 X 有时会恢复上次未发出的草稿，
  //   编辑器 len>0。若直接 insertText，残留字符会拼到正文最前面
  //   （实际事故：推文开头多了一个 "1"）。必须清到 0 才能继续。
  let curLen = Number(String(ready).split('len=')[1] || '0');
  if (curLen > 0) {
    console.log('[2a] ⚠️ 编辑器有残留 ' + curLen + ' 字符，清空中...');
    await ev(`(() => { const ed = document.querySelector('[data-testid="tweetTextarea_0"]'); ed.focus(); ed.click(); })()`);
    await sleep(500);
    // Cmd+A（macOS modifiers=4）后 Backspace
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    }
    await sleep(300);
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 51 });
    }
    await sleep(900);
    const after = await ev(`(() => { const ed = document.querySelector('[data-testid="tweetTextarea_0"]'); return (ed.textContent||'').length; })()`);
    console.log('[2b] 清空后 len=' + after);
    if (Number(after) > 0) {
      console.error('❌ 编辑器清不干净（残留 ' + after + ' 字符）—— 中止，绝不发带脏字符的推文');
      console.error('   处置：人工在 X 窗口里清空编辑器，或先跑 x-clear-compose.ts 换新标签');
      cdp.close();
      process.exit(5);
    }
  }

  // ---------- 2) 插入正文（CDP，无剪贴板） ----------
  // 坑6：Chrome 在后台时页面没有焦点（document.hasFocus()=false），
  //      Input.insertText 会静默失效（编辑器 len 恒为 0）。
  //      处置：开焦点仿真 + 尝试前置，不依赖窗口是否可见（2026-10-19 实测）。
  try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* 老版本可能不支持 */ }
  try { await cdp.send('Page.bringToFront'); } catch { /* 无窗口时可能失败，不影响 */ }
  await sleep(500);

  await ev(`(() => { const ed = document.querySelector('[data-testid="tweetTextarea_0"]'); ed.focus(); ed.click(); })()`);
  await sleep(700);
  try { await cdp.send('Input.insertText', { text: TEXT }); } catch (e) { /* 下面统一检查 */ }
  await sleep(2200);

  // 若仍为空，再补一次（焦点仿真生效后通常就正常了）
  let lenNow = Number(await ev(`(() => { const ed = document.querySelector('[data-testid="tweetTextarea_0"]'); return ed ? (ed.textContent||'').length : 0; })()`));
  if (lenNow < 20) {
    console.log('[3] 首次插入未生效（len=' + lenNow + '），重试一次...');
    await ev(`(() => { const ed = document.querySelector('[data-testid="tweetTextarea_0"]'); ed.focus(); ed.click(); })()`);
    await sleep(800);
    try { await cdp.send('Input.insertText', { text: TEXT }); } catch { /* 下面统一检查 */ }
    await sleep(2500);
  }

  const check = await ev(`(() => {
    const ed = document.querySelector('[data-testid="tweetTextarea_0"]');
    const t = ed ? (ed.textContent || '') : '';
    const tags = t.match(/#[^\\s#]+/g) || [];
    const counts = {}; for (const x of tags) counts[x] = (counts[x]||0) + 1;
    const dup = Object.values(counts).some(v => v > 1);
    return JSON.stringify({ len: t.length, dup, counts, text: t.slice(0, 60) });
  })()`);
  const parsed = JSON.parse(String(check));
  console.log('[3] 正文: len=' + parsed.len + ' 标签=' + JSON.stringify(parsed.counts) + (parsed.dup ? '  ⚠️ 有重复' : ''));

  if (parsed.dup) {
    console.error('❌ hashtag 重复（说明编辑器没清空）——已中止，未发布');
    console.error('   当前内容:', parsed.text);
    cdp.close();
    process.exit(2);
  }
  if (parsed.len < 20) {
    console.error('❌ 正文没进编辑器（len=' + parsed.len + '）——已中止，未发布');
    cdp.close();
    process.exit(2);
  }
  console.log('[3] ✅ 正文正常');

  // ---------- 3) 上传图片（CDP 文件注入，无剪贴板） ----------
  if (images.length) {
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const rootNodeId = (doc as any).root?.nodeId ?? (doc as any).nodeId;
    const q = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector: 'input[type="file"]' });
    const fileNodeId = (q as any)?.nodeId;
    if (!fileNodeId) { console.error('❌ 页面里找不到 input[type=file]，无法上传图片'); cdp.close(); process.exit(2); }

    const countImgs = async () => Number(await ev(`document.querySelectorAll('[data-testid="attachments"] img').length`));
    for (const img of images) {
      if (!fs.existsSync(img)) { console.error('图片不存在:', img); cdp.close(); process.exit(2); }
      const before = await countImgs();
      await cdp.send('DOM.setFileInputFiles', { nodeId: fileNodeId, files: [img] });
      let after = before;
      for (let i = 0; i < 8; i++) {
        await sleep(2500);
        after = await countImgs();
        if (after > before) break;
      }
      console.log('[4] 上传 ' + img.split('/').pop() + ' → 附件数 ' + before + '→' + after + (after > before ? ' ✅' : ' ⚠️'));
      if (after <= before) { console.error('❌ 图片上传失败'); cdp.close(); process.exit(2); }
    }
  }

  // ---------- 4) 等 tweetButton 可点（坑3） ----------
  console.log('[5] 等待发布按钮可用...');
  let clickable = false;
  for (let i = 0; i < Math.floor(maxWaitSec / 4); i++) {
    const st = await ev(`(() => {
      const b = document.querySelector('[data-testid="tweetButton"]');
      if (!b) return 'NONE';
      const r = b.getBoundingClientRect();
      return JSON.stringify({ d: b.getAttribute('aria-disabled'), vis: r.width > 0 && r.height > 0 });
    })()`);
    try {
      const s = JSON.parse(String(st));
      if (s.d !== 'true' && s.vis) { clickable = true; break; }
    } catch { /* 页面切换中，继续等 */ }
    await sleep(4000);
  }
  if (!clickable) { console.error('❌ 发布按钮始终不可用，已中止'); cdp.close(); process.exit(2); }
  console.log('[5] ✅ 按钮可点');

  if (!submit) {
    console.log('[6] 未加 --submit → 只填内容不发布');
    cdp.close();
    return;
  }

  // ---------- 5) 点击发布 ----------
  const clicked = await ev(`(() => {
    const b = document.querySelector('[data-testid="tweetButton"]');
    if (!b) return 'NO_BUTTON';
    const r = b.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width/2, clientY: r.y + r.height/2 };
    b.dispatchEvent(new PointerEvent('pointerdown', o));
    b.dispatchEvent(new MouseEvent('mousedown', o));
    b.dispatchEvent(new PointerEvent('pointerup', o));
    b.dispatchEvent(new MouseEvent('mouseup', o));
    b.dispatchEvent(new MouseEvent('click', o));
    return 'clicked';
  })()`);
  console.log('[6] 点击发布:', clicked);
  await sleep(10000);
  console.log('[6] 提交后 URL:', await ev(`location.href`));
  console.log('[6] 提示：请再跑 x-verify-post.ts 确认落地（脚本自述不等于事实）');

  cdp.close();
}

await main().catch(e => { console.error('失败:', e?.message || e); process.exit(1); });
