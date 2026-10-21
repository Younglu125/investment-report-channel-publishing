// 删除指定推文（CDP 自动化）
const UTILS = '<your-hermes-skills>/creative/baoyu-post-to-x/scripts/x-utils.js';
const { CdpConnection } = await import(UTILS);
import { spawnSync } from 'node:child_process';

const TWEET_ID = process.argv[2];
if (!TWEET_ID) { console.error('用法: bun x-delete-tweet.ts <tweet_id>'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findPort() {
  const out = spawnSync('bash', ['-lc',
    'pgrep -fl "user-data-dir=.*baoyu-skills/chrome-profile" | head -1 | grep -o "remote-debugging-port=[0-9]*" | cut -d= -f2'
  ], { encoding: 'utf8' });
  return (out.stdout || '').trim();
}

const port = findPort();
if (!port) { console.error('❌ 找不到 X 专用 Chrome'); process.exit(3); }
console.log('[0] CDP 端口:', port);

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
let page = targets.find(t => t.type === 'page' && t.url.includes('x.com'));
if (!page) { console.error('❌ 无 x.com 页面'); process.exit(3); }

const cdp = await CdpConnection.connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
  return r.result?.value;
};

const HANDLE = process.env.X_HANDLE || '<your_x_handle>';
const URL_TWEET = `https://x.com/${HANDLE}/status/${TWEET_ID}`;
console.log('[1] 打开推文:', URL_TWEET);
await cdp.send('Page.navigate', { url: URL_TWEET });
await sleep(6000);

// 校验页面上确实是这条推文
const head = await ev(`(() => {
  const el = document.querySelector('[data-testid="tweetText"]');
  return el ? el.textContent.slice(0, 40) : null;
})()`);
console.log('[2] 页面推文开头:', JSON.stringify(head));
if (!head) { console.error('❌ 找不到推文正文，中止'); process.exit(2); }

// 点 caret 菜单
console.log('[3] 点开更多菜单...');
await ev(`(() => {
  const btn = document.querySelector('[data-testid="caret"]');
  if (!btn) return 'no-caret';
  const r = btn.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
  btn.dispatchEvent(new PointerEvent('pointerdown', opts));
  btn.dispatchEvent(new MouseEvent('mousedown', opts));
  btn.dispatchEvent(new PointerEvent('pointerup', opts));
  btn.dispatchEvent(new MouseEvent('mouseup', opts));
  btn.dispatchEvent(new MouseEvent('click', opts));
  return 'clicked';
})()`);
await sleep(1800);

const menuItems = await ev(`(() => {
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map(e => e.textContent.trim()).slice(0,8);
})()`);
console.log('[4] 菜单项:', JSON.stringify(menuItems));

// 点 Delete
console.log('[5] 点 Delete...');
const delClicked = await ev(`(() => {
  const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
  const d = items.find(e => /Delete|删除/i.test(e.textContent));
  if (!d) return 'no-delete-item';
  const r = d.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
  d.dispatchEvent(new PointerEvent('pointerdown', opts));
  d.dispatchEvent(new MouseEvent('mousedown', opts));
  d.dispatchEvent(new PointerEvent('pointerup', opts));
  d.dispatchEvent(new MouseEvent('mouseup', opts));
  d.dispatchEvent(new MouseEvent('click', opts));
  return 'clicked';
})()`);
console.log('   ->', delClicked);
if (delClicked !== 'clicked') { console.error('❌ 未找到 Delete 项'); process.exit(2); }
await sleep(1800);

// 确认弹窗
console.log('[6] 确认删除...');
const confirmClicked = await ev(`(() => {
  const btn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
  if (!btn) {
    const all = Array.from(document.querySelectorAll('[role="button"]')).filter(e => /Delete|删除/i.test(e.textContent));
    if (!all.length) return 'no-confirm';
    const b = all[all.length-1];
    const r = b.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.left+r.width/2, clientY: r.top+r.height/2 };
    b.dispatchEvent(new PointerEvent('pointerdown', o));
    b.dispatchEvent(new MouseEvent('mousedown', o));
    b.dispatchEvent(new PointerEvent('pointerup', o));
    b.dispatchEvent(new MouseEvent('mouseup', o));
    b.dispatchEvent(new MouseEvent('click', o));
    return 'clicked-fallback';
  }
  const r = btn.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.left+r.width/2, clientY: r.top+r.height/2 };
  btn.dispatchEvent(new PointerEvent('pointerdown', o));
  btn.dispatchEvent(new MouseEvent('mousedown', o));
  btn.dispatchEvent(new PointerEvent('pointerup', o));
  btn.dispatchEvent(new MouseEvent('mouseup', o));
  btn.dispatchEvent(new MouseEvent('click', o));
  return 'clicked';
})()`);
console.log('   ->', confirmClicked);
await sleep(3000);

// 校验：页面应显示推文不存在
const check = await ev(`(() => {
  const body = document.body.innerText || '';
  const gone = /This post was deleted|此帖已删除|doesn.t exist|Hmm/.test(body);
  return { gone, snippet: body.slice(0, 120).replace(/\\s+/g, ' ') };
})()`);
console.log('[7] 校验:', JSON.stringify(check));

cdp.close();
console.log(check.gone ? '✅ 推文已删除' : '⚠️ 未见删除确认文案，请人工核实');
