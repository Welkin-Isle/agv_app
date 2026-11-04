/* =============================================================================
 * browser.test.mjs —— 用真实浏览器（Edge）做端到端测试
 * =============================================================================
 * 通过 Chrome DevTools 协议连接无头 Edge，真实执行页面里的 JS：
 *   · IndexedDB 往返、模板加载（4.9MB）、浏览器内生成 xlsx、WebCrypto 加解密
 *   · 首页/工作台/模块页渲染是否成功、有无 console 报错
 * 这是唯一能验证"PWA 在真实浏览器里能跑"的手段。
 *
 * 前置：先起静态服务器
 *   python -m http.server 8899 --bind 127.0.0.1 --directory agv_app/docs
 * 用法：node agv_app/tests/browser.test.mjs [端口]
 * ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 支持两种用法：
//   node browser.test.mjs 8899                                    → 测本地
//   node browser.test.mjs https://user.github.io/repo             → 测线上
const ARG = process.argv[2] || '8899';
const SITE = /^https?:\/\//.test(ARG) ? ARG.replace(/\/$/, '') : `http://127.0.0.1:${ARG}`;
const DBG_PORT = 9333;
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(p => fs.existsSync(p));
if (!EDGE) { console.error('找不到 Edge/Chrome'); process.exit(2); }

let pass = 0, fail = 0;
const check = (n, c, e) => {
  if (c) { pass++; console.log('  ✓ ' + n + (e ? '  ' + e : '')); }
  else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 启动浏览器 ---------------- */
const profile = path.join(HERE, '.edge-cdp');
fs.rmSync(profile, { recursive: true, force: true });
const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--mute-audio',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${DBG_PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank'
], { stdio: 'ignore', detached: false });

async function waitDevtools(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${DBG_PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('DevTools 端口没起来');
}

/* ---------------- CDP 客户端 ---------------- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise, returnByValue: true, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description
        || r.exceptionDetails.text));
    }
    return r.result.value;
  }
}

async function newTab(url) {
  let r = await fetch(`http://127.0.0.1:${DBG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) r = await fetch(`http://127.0.0.1:${DBG_PORT}/json/new?${encodeURIComponent(url)}`);
  const t = await r.json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  return { cdp, targetId: t.id, ws };
}

function consoleErrors(cdp) {
  const out = [];
  for (const e of cdp.events) {
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
      var u = (e.params.entry.url || '');
      if (u.indexOf('favicon') >= 0) continue;          // 图标缺失不算功能错误
      out.push(e.params.entry.text + (u ? ' @ ' + u : ''));
    }
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      out.push(d.exception && d.exception.description || d.text);
    }
  }
  return out;
}

/* ============================ 开测 ============================ */
console.log('='.repeat(74));
console.log('真实浏览器端到端测试（Edge + DevTools 协议）');
console.log('='.repeat(74));
console.log('浏览器:', PATH_basename(EDGE));
function PATH_basename(p) { return p.split('\\').pop(); }

const ver = await waitDevtools();
console.log('版本  :', ver.Browser);

/* ---------- 1. 自检页：浏览器能力与核心链路 ---------- */
console.log('\n— 1) 环境自检页（浏览器真实执行） —');
const p1 = await newTab(SITE + '/selftest.html');
let items = [], verdict = '';
for (let i = 0; i < 70; i++) {
  await sleep(500);
  try {
    const raw = await p1.cdp.evaluate(`JSON.stringify({
      items: [...document.querySelectorAll('#list .item')].map(function(d){
        var ic = d.querySelector('.ic');
        var nm = d.querySelector('.nm2');
        return {
          ic: ic ? ic.textContent.trim() : '',
          name: nm && nm.childNodes[0] ? nm.childNodes[0].textContent.trim() : '',
          dt: (d.querySelector('.dt') || {}).textContent || ''
        };
      }),
      verdict: (document.getElementById('verdict') || {}).innerText || ''
    })`, false);
    const o = JSON.parse(raw || '{}');
    items = o.items || [];
    verdict = o.verdict || '';
    if (verdict) break;
  } catch (e) { /* 页面未就绪 */ }
}
items.forEach(function (it) { console.log('    ' + it.ic + ' ' + it.name + ' — ' + it.dt); });

const byName = n => items.filter(function (x) { return x.name.indexOf(n) >= 0; })[0] || { ic: '', dt: '缺失' };
const okItem = n => byName(n).ic === '✓';

check('自检项 8 条', items.length === 8, String(items.length));
check('本地数据库（IndexedDB）', okItem('本地数据库'), byName('本地数据库').dt);
check('加密能力（WebCrypto）', okItem('加密能力'), byName('加密能力').dt);
check('离线缓存（Service Worker）', okItem('离线缓存'), byName('离线缓存').dt);
check('录视频（MediaRecorder）', okItem('录视频'), byName('录视频').dt);
check('解压能力（DecompressionStream）', okItem('解压能力'), byName('解压能力').dt);
check('加载调研表模板', okItem('调研表模板') && /[\d.]+\s*(KB|MB)/.test(byName('调研表模板').dt),
  byName('调研表模板').dt);
check('浏览器内生成 xlsx 且校验通过',
  okItem('生成调研表') && /[\d.]+\s*(KB|MB)/.test(byName('生成调研表').dt) && /\d+ 个部件/.test(byName('生成调研表').dt),
  byName('生成调研表').dt);
check('可用存储空间', okItem('可用存储'), byName('可用存储').dt);
check('自检结论为"可以正常使用"', verdict.indexOf('可以正常使用') >= 0,
  verdict.slice(0, 40).replace(/\n/g, ' '));

const err1 = consoleErrors(p1.cdp);
check('自检页无 console 错误', err1.length === 0, err1.slice(0, 3).join(' | '));
p1.ws.close();

/* ---------- 2. 首页 ---------- */
console.log('\n— 2) 首页（我的方案） —');
const p2 = await newTab(SITE + '/index.html');
await sleep(2500);
const homeInfo = await p2.cdp.evaluate(`(() => {
  const m = document.getElementById('main');
  return {
    text: (m ? m.innerText : '').slice(0, 400),
    hasNewBtn: !!document.getElementById('btn-new'),
    hasWelcome: (m ? m.innerText : '').indexOf('欢迎使用') >= 0,
    hasEmpty: (m ? m.innerText : '').indexOf('还没有方案') >= 0,
    hasNoticeBad: (m ? m.innerText : '').indexOf('加载失败') >= 0
  };
})()`, false);
check('首页渲染出内容（不是"正在加载"）',
  homeInfo.text.indexOf('正在加载') < 0, JSON.stringify(homeInfo.text.slice(0, 40)));
check('显示首次使用说明', homeInfo.hasWelcome);
check('显示空状态', homeInfo.hasEmpty);
check('无加载失败提示', !homeInfo.hasNoticeBad);
check('新建按钮存在', homeInfo.hasNewBtn);
const err2 = consoleErrors(p2.cdp);
check('首页无 console 错误', err2.length === 0, err2.slice(0, 2).join(' | '));

/* ---------- 3. 建方案 → 工作台 → 模块页 ---------- */
console.log('\n— 3) 建方案 / 工作台 / 模块页 —');
const pid = await p2.cdp.evaluate(`(async () => {
  const p = AGV_DB.newProject({ customer: '브라우저테스트', name: '端到端' });
  await AGV_DB.putProject(p);
  return p.id;
})()`);
check('通过页面 API 创建方案', !!pid, pid);

const p3 = await newTab(SITE + '/project.html?id=' + encodeURIComponent(pid));
await sleep(2500);
const projInfo = await p3.cdp.evaluate(`(() => {
  const m = document.getElementById('main');
  const mods = document.querySelectorAll('.mod');
  return {
    text: (m ? m.innerText : '').slice(0, 200),
    modCount: mods.length,
    cardCount: document.querySelectorAll('.mod-grid .mod').length,
    hasTitle: (document.getElementById('ttl') || {}).textContent || '',
    bad: (m ? m.innerText : '').indexOf('加载失败') >= 0
  };
})()`, false);
check('工作台显示客户名', projInfo.hasTitle.indexOf('브라우저테스트') >= 0, projInfo.hasTitle);
check('模块卡片数量 = 11（10 步 + 附件）', projInfo.modCount === 11, String(projInfo.modCount));
check('工作台无加载失败', !projInfo.bad);
const err3 = consoleErrors(p3.cdp);
check('工作台无 console 错误', err3.length === 0, err3.slice(0, 2).join(' | '));

const p4 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=combo');
await sleep(2500);
const modInfo = await p4.cdp.evaluate(`(() => {
  const m = document.getElementById('main');
  return {
    text: (m ? m.innerText : '').slice(0, 300),
    repCount: document.querySelectorAll('.rep').length,
    refs: document.querySelectorAll('.rep-refs').length,
    fields: document.querySelectorAll('.field').length,
    addBtn: !!document.querySelector('.add-rep'),
    title: (document.getElementById('ttl') || {}).textContent || ''
  };
})()`, false);
check('模块页标题正确', modInfo.title.indexOf('载具 + 物料组合') >= 0, modInfo.title);
check('组合 C 默认 1 组', modInfo.repCount === 1, String(modInfo.repCount));
check('组合 C 有 S3 引用下拉（选物料/载具）', modInfo.refs === 1, String(modInfo.refs));
check('组合 C 渲染 12 个字段', modInfo.fields >= 12, String(modInfo.fields));
check('有「添加」按钮', modInfo.addBtn);
const err4 = consoleErrors(p4.cdp);
check('模块页无 console 错误', err4.length === 0, err4.slice(0, 2).join(' | '));

/* 填写并落盘 */
const saved = await p4.cdp.evaluate(`(async () => {
  const p = await AGV_DB.getProject(${JSON.stringify(pid)});
  p.answers.combo = [{ ref_material: 1, ref_carrier: 1, stack_mode: '自动码盘',
    pallet_length: { m: 'single', v: 1000 }, pallet_width: { m: 'single', v: 1200 } }];
  p.answers.basic = { customer_name: '브라우저테스트', project_name: '端到端验证' };
  await AGV_DB.putProject(p);
  const back = await AGV_DB.getProject(${JSON.stringify(pid)});
  return { combo: (back.answers.combo || []).length, L: back.answers.combo[0].pallet_length.v };
})()`);
check('数据写入并可读回', saved.combo === 1 && saved.L === 1000, JSON.stringify(saved));

p2.ws.close(); p3.ws.close(); p4.ws.close();

/* ---------- 4. 导出链路 / 媒体 / 加密 ---------- */
console.log('\n— 4) 导出链路 / 媒体处理 / 加密 —');
const p5 = await newTab(SITE + '/project.html?id=' + encodeURIComponent(pid));  // 该页加载了全部模块
await sleep(2200);

/* 4a 图片压缩 */
const imgInfo = await p5.cdp.evaluate(`(async () => {
  const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
  const x = c.getContext('2d');
  x.fillStyle = '#3b82f6'; x.fillRect(0, 0, 3000, 2000);
  x.fillStyle = '#fff'; x.font = '200px sans-serif'; x.fillText('TEST', 200, 1100);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'big.png', { type: 'image/png' });
  const out = await AGV_MEDIA.compressImage(file);
  return { orig: file.size, comp: out.size, w: out.w, h: out.h,
           mime: out.mime, thumb: out.thumb ? out.thumb.size : 0, name: out.name };
})()`);
check('图片压缩后体积变小', imgInfo.comp < imgInfo.orig,
  (imgInfo.orig / 1024).toFixed(0) + 'KB → ' + (imgInfo.comp / 1024).toFixed(0) + 'KB');
check('长边压到 1920 以内', Math.max(imgInfo.w, imgInfo.h) <= 1920, imgInfo.w + 'x' + imgInfo.h);
check('输出为 JPEG', imgInfo.mime === 'image/jpeg', imgInfo.mime);
check('生成了缩略图', imgInfo.thumb > 0, imgInfo.thumb + ' B');
check('文件名改为 .jpg', /\.jpg$/.test(imgInfo.name), imgInfo.name);

/* 4b 视频录制（Edge 假摄像头） */
const vidInfo = await p5.cdp.evaluate(`(async () => {
  try {
    const meta = await AGV_MEDIA.startRecording({ audio: true });
    await new Promise(r => setTimeout(r, 1700));
    const v = await AGV_MEDIA.stopRecording();
    return { ok: true, size: v.size, mime: v.mime, name: v.name, dur: v.duration, recMime: meta.mimeType };
  } catch (e) { return { ok: false, err: (e && e.message) || String(e) }; }
})()`);
check('视频录制成功', vidInfo.ok === true, vidInfo.err || '');
check('录制产物有内容', vidInfo.ok && vidInfo.size > 1000, (vidInfo.size || 0) + ' B');
check('录制时长 1~4 秒', vidInfo.ok && vidInfo.dur >= 1 && vidInfo.dur <= 4, (vidInfo.dur || 0) + ' s');
check('录制文件名带扩展名', vidInfo.ok && /\.(mp4|webm)$/.test(vidInfo.name), vidInfo.name);

/* 4c 完整导出链路：xlsx + 媒体 + answers.json + 说明 */
const expInfo = await p5.cdp.evaluate(`(async () => {
  const p = AGV_DB.newProject({
    customer: 'EXPORTTEST', name: '导出链路测试',
    answers: {
      basic: { customer_name: 'EXPORTTEST', project_name: '导出链路测试' },
      extra: { aisle_width_mm: { m: 'single', v: 2000 }, site_environment: '室内' },
      other: { other_requirements: '导出链路验证内容' }
    }
  });
  await AGV_DB.putProject(p);
  await AGV_DB.addMedia({ projectId: p.id, zone: 'site_photos', kind: 'image',
    name: 'a.jpg', mime: 'image/jpeg', size: 2048, note: '地面',
    blob: new Blob([new Uint8Array(2048)], { type: 'image/jpeg' }) });
  await AGV_DB.addMedia({ projectId: p.id, zone: 'videos', kind: 'video',
    name: 'v.mp4', mime: 'video/mp4', size: 4096,
    blob: new Blob([new Uint8Array(4096)], { type: 'video/mp4' }) });
  const media = await AGV_DB.listMedia(p.id);
  const res = await AGV_EXPORT.build({ project: p, answers: p.answers, media: media });
  const f = res.files[0];
  const ab = await f.blob.arrayBuffer();
  const z = AGV_ZIP.readZip(ab);
  const names = z.entries.map(e => e.name);

  let inner = 0, innerHasText = false;
  const xe = z.entries.filter(e => /\.xlsx$/.test(e.name))[0];
  if (xe) {
    const xb = await z.inflate(xe);
    const z2 = AGV_ZIP.readZip(xb.buffer.slice(xb.byteOffset, xb.byteOffset + xb.byteLength));
    inner = z2.entries.length;
    const s1 = z2.entries.filter(e => e.name === 'xl/worksheets/sheet1.xml')[0];
    if (s1) {
      const xml = new TextDecoder().decode(await z2.inflate(s1));
      innerHasText = xml.indexOf('导出链路验证内容') >= 0;
    }
  }
  let ansOk = false;
  const je = z.entries.filter(e => e.name === 'answers.json')[0];
  if (je) ansOk = new TextDecoder().decode(await z.inflate(je)).indexOf('EXPORTTEST') >= 0;

  // 加密往返
  const enc = await AGV_EXPORT.encryptBlob(f.blob, 'test-pw-123');
  const dec = await AGV_EXPORT.decryptBlob(enc, 'test-pw-123');
  let wrongPwRejected = false;
  try { await AGV_EXPORT.decryptBlob(enc, 'bad-pw'); } catch (e) { wrongPwRejected = true; }

  // 分包导出（视频单独一包）
  const splitRes = await AGV_EXPORT.build({ project: p, answers: p.answers, media: media, splitVideo: true });

  await AGV_DB.deleteProject(p.id);

  return { fileName: f.name, total: res.total, count: z.entries.length, names: names,
           inner: inner, innerHasText: innerHasText, ansOk: ansOk,
           encSameBlob: (await dec.arrayBuffer()).byteLength === ab.byteLength,
           wrongPwRejected: wrongPwRejected,
           splitNames: splitRes.files.map(x => x.name),
           splitSizes: splitRes.files.map(x => x.size) };
})()`);

check('导出文件名规范', /^EXPORTTEST_\d{8}\.zip$/.test(expInfo.fileName), expInfo.fileName);
check('zip 含调研表 xlsx', expInfo.names.some(n => /\.xlsx$/.test(n)),
  expInfo.names.filter(n => /\.xlsx$/.test(n)).join(''));
check('zip 含照片且带备注序号', expInfo.names.some(n => /^现场照片\/01_地面\.jpg$/.test(n)),
  expInfo.names.filter(n => n.startsWith('现场照片')).join(''));
check('zip 含视频（无备注时不加下划线）',
  expInfo.names.some(n => /^现场视频\/01(_[^\/]*)?\.mp4$/.test(n)),
  expInfo.names.filter(n => n.startsWith('现场视频')).join(''));
check('zip 含 answers.json', expInfo.names.indexOf('answers.json') >= 0);
check('zip 含 说明.txt', expInfo.names.indexOf('说明.txt') >= 0);
check('内层 xlsx 结构完整（部件数 > 20）', expInfo.inner > 20, String(expInfo.inner) + ' 个部件');
check('内层 xlsx 含填写内容', expInfo.innerHasText === true);
check('answers.json 含项目数据', expInfo.ansOk === true);
check('加密后解密字节一致', expInfo.encSameBlob === true);
check('错误口令被拒绝', expInfo.wrongPwRejected === true);
check('分包模式产出 2 个包', expInfo.splitNames.length === 2, expInfo.splitNames.join(' + '));
check('分包：视频包不含表格', expInfo.splitNames[1].indexOf('视频') >= 0, expInfo.splitNames[1]);

/* 4d UI 入口是否真的接上（加密导出 / 解密加密包） */
const menu = await p5.cdp.evaluate(`(async () => {
  document.getElementById('btn-more').click();
  await new Promise(r => setTimeout(r, 250));
  const t = (document.getElementById('sheet-body') || {}).innerText || '';
  document.getElementById('sheet-close').click();
  return t;
})()`);
check('方案菜单含「加密导出」', menu.indexOf('加密导出') >= 0);
check('方案菜单含「删除这个方案」', menu.indexOf('删除') >= 0);

const menu2 = await p5.cdp.evaluate(`(async () => {
  const f = document.createElement('iframe');
  f.style.display = 'none'; f.src = 'index.html';
  document.body.appendChild(f);
  await new Promise(r => { f.onload = r; setTimeout(r, 2500); });
  const d = f.contentDocument;
  d.getElementById('btn-more').click();
  await new Promise(r => setTimeout(r, 250));
  const t = (d.getElementById('sheet-body') || {}).innerText || '';
  f.remove();
  return t;
})()`);
check('首页菜单含「解密加密包」', menu2.indexOf('解密加密包') >= 0, menu2.split('\n')[0] || '');
check('首页菜单含「导出全部方案」', menu2.indexOf('导出全部方案') >= 0);

const err5 = consoleErrors(p5.cdp);
check('导出链路无 console 错误', err5.length === 0, err5.slice(0, 2).join(' | '));
p5.ws.close();

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(74));
console.log(`浏览器端到端测试: 通过 ${pass}   失败 ${fail}`);
console.log('='.repeat(74));

try { proc.kill(); } catch (e) { }
await sleep(600);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Edge 可能还占用，无害 */ }
process.exit(fail ? 1 : 0);
