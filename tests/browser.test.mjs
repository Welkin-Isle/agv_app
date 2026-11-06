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

check('自检项 7 条', items.length === 7, String(items.length));
check('本地数据库（IndexedDB）', okItem('本地数据库'), byName('本地数据库').dt);
check('加密能力（WebCrypto）', okItem('加密能力'), byName('加密能力').dt);
check('离线缓存（Service Worker）', okItem('离线缓存'), byName('离线缓存').dt);
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

/* ---------- 5. 交互回归（2026-11-05 十条改动） ---------- */
console.log('\n— 5) 交互回归（即时重绘 / 其它说明 / 引用下拉 / 参考图 / 地点→流程 / 附件预览） —');

const HELPERS = `function fieldByLabel(t){
  var all = [].slice.call(document.querySelectorAll('.field'));
  for (var i=0;i<all.length;i++){
    var l = all[i].querySelector('.flabel');
    if (l && l.textContent.trim().indexOf(t) === 0) return all[i];
  }
  return null;
}`;

/* 5a 模式切换即时重绘 */
const p6 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=material');
await sleep(2000);
const repaint = await p6.cdp.evaluate(`(function(){ ${HELPERS}
  var f = fieldByLabel('\u91cd\u91cf');
  if (!f) return { err: 'no-field' };
  var before = f.querySelectorAll('.mode-body input').length;
  [].slice.call(f.querySelectorAll('.modes span')).forEach(function(s){
    if (s.textContent === '范围') s.click();
  });
  var after = f.querySelectorAll('.mode-body input').length;
  var on = (f.querySelector('.modes .on') || {}).textContent;
  return { before: before, after: after, on: on };
})()`, false);
check('点「范围」立刻变成两个输入框（不用重进）', repaint.after === 2, JSON.stringify(repaint));
check('模式按钮选中态立刻跟随', repaint.on === '范围', String(repaint.on));

/* 5b 选"其它"立刻弹说明框 */
const p7 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=carrier');
await sleep(2000);
const other = await p7.cdp.evaluate(`(function(){ ${HELPERS}
  var f = fieldByLabel('\u8f7d\u5177\u7c7b\u578b');
  if (!f) return { err: 'no-field' };
  var sel = f.querySelector('select');
  sel.value = '__other';
  sel.dispatchEvent(new Event('change'));
  var box = f.querySelector('.other-box');
  return {
    has: !!box,
    label: box ? (box.querySelector('.other-label') || {}).textContent : '',
    hasInput: box ? !!box.querySelector('input') : false
  };
})()`, false);
check('选「其它（请说明）」立刻弹出输入框', other.has === true, JSON.stringify(other));
check('说明框带「说明内容」字样', other.label === '说明内容', String(other.label));
check('说明框有可输入的文本框', other.hasInput === true);

/* 5c 对应物料是引用下拉 */
const refSel = await p7.cdp.evaluate(`(function(){ ${HELPERS}
  var f = fieldByLabel('\u5bf9\u5e94\u7269\u6599');
  if (!f) return { err: 'no-field' };
  var sel = f.querySelector('select');
  return { isSelect: !!sel, opts: sel ? [].slice.call(sel.options).map(function(o){ return o.textContent; }) : [] };
})()`, false);
check('「对应物料」已改为下拉', refSel.isSelect === true);
check('下拉里有 A1', (refSel.opts || []).some(function(o){ return o.indexOf('A1') === 0; }), (refSel.opts || []).join(' | '));

/* 5d 组合 C 的参考图按钮 */
const p8 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=combo');
await sleep(2000);
const refImg = await p8.cdp.evaluate(`(async function(){
  var btn = document.getElementById('btn-ref');
  if (!btn) return { btn: false };
  btn.click();
  await new Promise(function(r){ setTimeout(r, 400); });
  var mask = document.getElementById('overlay');
  var img = mask ? mask.querySelector('img') : null;
  var ok = false;
  if (img) { ok = img.complete && img.naturalWidth > 0; }
  if (mask) mask.remove();
  return { btn: true, mask: !!mask, src: img ? img.getAttribute('src') : '', loaded: ok };
})()`);
check('组合模块有「参考图」按钮', refImg.btn === true);
check('点开后弹出浮层且图片加载成功', refImg.mask === true && refImg.loaded === true,
  'src=' + refImg.src + ' loaded=' + refImg.loaded);

/* 5e 地点填写 → 流程下拉自动出现 */
const p9 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=flow');
await sleep(2000);
const flowSync = await p9.cdp.evaluate(`(async function(){
  var cards = [].slice.call(document.querySelectorAll('.rep'));
  if (!cards.length) return { err: 'no-rep' };
  var placeCard = cards[0];
  var ins = placeCard.querySelectorAll('.rep-body input[type=text]');
  if (ins.length < 2) return { err: 'no-place-inputs', n: ins.length };
  ins[0].value = 'X1'; ins[0].dispatchEvent(new Event('input'));
  ins[1].value = '测试区'; ins[1].dispatchEvent(new Event('input'));
  await new Promise(function(r){ setTimeout(r, 900); });   // 等防抖刷新
  var all = [].slice.call(document.querySelectorAll('.rep'));
  var flowCard = all[all.length - 1];
  var sel = flowCard.querySelector('select');
  var opts = sel ? [].slice.call(sel.options).map(function(o){ return o.textContent; }) : [];
  return { opts: opts.slice(0, 6) };
})()`);
check('地点填入后，流程起终点下拉自动出现该地点',
  (flowSync.opts || []).some(function(o){ return o.indexOf('X1') === 0; }),
  JSON.stringify(flowSync.opts));

/* 5f 附件上传后可点开预览 + 改备注 */
const p10 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=media');
await sleep(2000);
const mediaFlow = await p10.cdp.evaluate(`(async function(){
  var canvas = document.createElement('canvas');
  canvas.width = 120; canvas.height = 90;
  var x = canvas.getContext('2d');
  x.fillStyle = '#e11d48'; x.fillRect(0, 0, 120, 90);
  var blob = await new Promise(function(r){ canvas.toBlob(r, 'image/png'); });
  var file = new File([blob], 'preview-test.png', { type: 'image/png' });
  var input = document.querySelector('input[type=file]');
  if (!input) return { err: 'no-input' };
  var dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  await new Promise(function(r){ setTimeout(r, 2500); });
  var att = document.querySelector('.att');
  if (!att) return { err: 'no-att' };
  att.click();
  await new Promise(function(r){ setTimeout(r, 400); });
  var mask = document.getElementById('overlay');
  var img = mask ? mask.querySelector('img') : null;
  var loaded = false;
  if (img) { loaded = img.complete && img.naturalWidth > 0; }
  var btns = mask ? [].slice.call(mask.querySelectorAll('.ov-foot .btn')).map(function(b){ return b.textContent; }) : [];
  if (mask) mask.remove();
  return { attCount: document.querySelectorAll('.att').length, mask: !!mask, loaded: loaded, btns: btns };
})()`);
check('附件上传成功', mediaFlow.attCount >= 1, JSON.stringify({ n: mediaFlow.attCount, err: mediaFlow.err }));
check('点缩略图弹出预览浮层', mediaFlow.mask === true);
check('预览图片真的加载出来', mediaFlow.loaded === true);
check('预览里有「修改备注」和「删除」', (mediaFlow.btns || []).join(',').indexOf('修改备注') >= 0 &&
  (mediaFlow.btns || []).join(',').indexOf('删除') >= 0, (mediaFlow.btns || []).join(','));

/* 5h 物料尺寸只有精确值 + 提示语 */
const sizeField = await p6.cdp.evaluate(`(function(){ ${HELPERS}
  var f = fieldByLabel('\u5c3a\u5bf8');
  if (!f) return { err: 'no-field' };
  return {
    hasModes: !!f.querySelector('.modes'),
    hint: (f.querySelector('.fhint') || {}).textContent || ''
  };
})()`, false);
check('物料尺寸已无「范围」选项', sizeField.hasModes === false, JSON.stringify(sizeField));
check('尺寸处有「请下滑添加」提示',
  (sizeField.hint || '').indexOf('下滑添加') >= 0, String(sizeField.hint));

/* 5i 温度只有范围；坡度/承重只有 ≤ */
const p11 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=site');
await sleep(2000);
const siteModes = await p11.cdp.evaluate(`(function(){ ${HELPERS}
  function shapeOf(label){
    var f = fieldByLabel(label);
    if (!f) return null;
    var sep = f.querySelector('.mode-body .sep');
    return {
      hasSwitcher: !!f.querySelector('.modes'),
      sep: sep ? sep.textContent : '',
      inputs: f.querySelectorAll('.mode-body input').length
    };
  }
  return {
    temp: shapeOf('\u6e29\u5ea6\u8303\u56f4'),
    slope: shapeOf('\u5730\u9762\u5761\u5ea6'),
    cap: shapeOf('\u5730\u9762\u3001\u697c\u677f\u627f\u91cd'),
    hasColdHint: document.body.innerText.indexOf('\u51b7\u5e93') >= 0
  };
})()`, false);
// 单一模式时不显示切换条，直接用该形态：温度=范围(两输入+~)，坡度/承重=≤(一个输入)
check('温度只有范围形态（两输入 + ~，无切换条）',
  siteModes.temp && siteModes.temp.hasSwitcher === false &&
  siteModes.temp.inputs === 2 && siteModes.temp.sep === '~', JSON.stringify(siteModes.temp));
check('地面坡度只有 ≤ 形态（无切换条）',
  siteModes.slope && siteModes.slope.hasSwitcher === false &&
  siteModes.slope.inputs === 1 && siteModes.slope.sep === '≤', JSON.stringify(siteModes.slope));
check('楼板承重只有 ≤ 形态（无切换条）',
  siteModes.cap && siteModes.cap.hasSwitcher === false &&
  siteModes.cap.inputs === 1 && siteModes.cap.sep === '≤', JSON.stringify(siteModes.cap));
check('已删除「若有冷库/冷冻区请填最低温度」', siteModes.hasColdHint === false);

/* 5j 通道宽度无"最小值"且只有范围；层数=地点+层数 */
const p12 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=extra');
await sleep(2000);
const extraUI = await p12.cdp.evaluate(`(function(){ ${HELPERS}
  var a = fieldByLabel('\u73b0\u573a\u5b9e\u9645\u901a\u9053\u5bbd\u5ea6');
  var reps = document.querySelectorAll('.rep');
  var r0 = reps.length ? reps[0] : null;
  var sep = a ? a.querySelector('.mode-body .sep') : null;
  return {
    aisleLabel: a ? (a.querySelector('.flabel') || {}).textContent || '' : '',
    aisleSwitcher: !!(a && a.querySelector('.modes')),
    aisleSep: sep ? sep.textContent : '',
    aisleInputs: a ? a.querySelectorAll('.mode-body input').length : 0,
    repCount: reps.length,
    hasAdd: !!document.querySelector('.add-rep'),
    layerHasSelect: !!(r0 && r0.querySelector('select')),
    layerHasNumber: !!(r0 && r0.querySelector('input[type=number]')),
    layerUnit: r0 ? (r0.querySelector('.unit') || {}).textContent || '' : '',
    envIsChips: !!document.querySelector('#main .chips')
  };
})()`, false);
check('通道宽度标题已去掉「最小值」', (extraUI.aisleLabel || '').indexOf('最小值') < 0, String(extraUI.aisleLabel));
check('通道宽度只有范围形态（两输入 + ~，无切换条）',
  extraUI.aisleSwitcher === false && extraUI.aisleInputs === 2 && extraUI.aisleSep === '~',
  JSON.stringify({ sw: extraUI.aisleSwitcher, sep: extraUI.aisleSep, n: extraUI.aisleInputs }));
check('堆叠层数已变成可添加的重复组',
  extraUI.repCount >= 1 && extraUI.hasAdd === true, JSON.stringify({ reps: extraUI.repCount, add: extraUI.hasAdd }));
check('堆叠组内是「地点下拉 + 层数输入」',
  extraUI.layerHasSelect === true && extraUI.layerHasNumber === true && extraUI.layerUnit === '层',
  JSON.stringify({ sel: extraUI.layerHasSelect, num: extraUI.layerHasNumber, unit: extraUI.layerUnit }));
check('运行环境已改为按钮组（可多选）', extraUI.envIsChips === true, String(extraUI.envIsChips));

[p11, p12].forEach(function (x) { try { x.ws.close(); } catch (e) {} });

/* 5g 已无"现场视频"录制 */
check('附件页已无录制视频按钮', await p10.cdp.evaluate(
  `!document.querySelector('#btn-rec-stop') && document.body.innerText.indexOf('录制视频') < 0`, false));
check('上传按钮文案为「点击上传」', await p10.cdp.evaluate(
  `document.body.innerText.indexOf('点击上传') >= 0 && document.body.innerText.indexOf('点击选择') < 0`, false));

[p6, p7, p8, p9, p10].forEach(function (x) { try { x.ws.close(); } catch (e) {} });

/* ---------- 6. 2026-11-06 八条改动 ---------- */
console.log('\n— 6) 本轮调整（基本信息顺序 / 定制载具说明 / 添加中间点 / 承重单位 / ERP选项 / 无副标题） —');

/* 6a 基本信息：项目名称在前、客户名称在后、无「联系方式」 */
const p13 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=basic');
await sleep(2000);
const basicUI = await p13.cdp.evaluate(`(function(){
  var labels = [].slice.call(document.querySelectorAll('#main .flabel')).map(function(l){
    return l.textContent.replace(/[*\\s]/g, '');
  });
  return { labels: labels.slice(0, 6), hasContact: document.body.innerText.indexOf('\\u8054\\u7cfb\\u65b9\\u5f0f') >= 0 };
})()`, false);
check('基本信息第 1 项是「项目名称」', (basicUI.labels[0] || '') === '项目名称', JSON.stringify(basicUI.labels));
check('基本信息第 2 项是「客户名称」', (basicUI.labels[1] || '') === '客户名称', JSON.stringify(basicUI.labels));
check('已删除「联系方式」输入框', basicUI.hasContact === false);

/* 6b 载具类型选「定制载具」也弹说明框 */
const p14 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=carrier');
await sleep(2000);
const customCarrier = await p14.cdp.evaluate(`(function(){ ${HELPERS}
  var f = fieldByLabel('\\u8f7d\\u5177\\u7c7b\\u578b');
  if (!f) return { err: 'no-field' };
  var sel = f.querySelector('select');
  sel.value = '\\u5b9a\\u5236\\u8f7d\\u5177';
  sel.dispatchEvent(new Event('change'));
  var box = f.querySelector('.other-box');
  return {
    has: !!box,
    label: box ? (box.querySelector('.other-label') || {}).textContent : '',
    selStillCustom: sel.value === '\\u5b9a\\u5236\\u8f7d\\u5177'
  };
})()`, false);
check('选「定制载具」立刻弹出说明框', customCarrier.has === true, JSON.stringify(customCarrier));
check('定制载具说明框带「说明内容」', customCarrier.label === '说明内容', String(customCarrier.label));

/* 6c 现场：承重单位 kg/m²；无副标题 */
const p15 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=site');
await sleep(2000);
const siteUI = await p15.cdp.evaluate(`(function(){ ${HELPERS}
  var cap = fieldByLabel('\\u5730\\u9762\\u3001\\u697c\\u677f\\u627f\\u91cd');
  var sub = document.getElementById('sub');
  return {
    unit: cap ? (cap.querySelector('.unit') || {}).textContent || '' : '',
    subText: sub ? sub.textContent : 'x',
    subHidden: sub ? (sub.style.display === 'none' || !sub.textContent) : true
  };
})()`, false);
check('楼板承重单位已改为 kg/m²', siteUI.unit === 'kg/m²', String(siteUI.unit));
check('模块页不再显示「原表 R…」备注', siteUI.subHidden === true, JSON.stringify(siteUI.subText));

/* 6d 系统对接：ERP/MES 选项 */
const p16 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=system');
await sleep(2000);
const erpUI = await p16.cdp.evaluate(`(function(){ ${HELPERS}
  var f = fieldByLabel('ERP/MES');
  if (!f) return { err: 'no-field' };
  var sel = f.querySelector('select');
  return { opts: sel ? [].slice.call(sel.options).map(function(o){ return o.textContent; }) : [] };
})()`, false);
check('ERP/MES 选项为 MES/ERP/MES和ERP/无/不确定/其它',
  ['MES', 'ERP', 'MES和ERP', '无', '不确定'].every(function (x) {
    return (erpUI.opts || []).indexOf(x) >= 0;
  }) && (erpUI.opts || []).some(function (o) { return o.indexOf('其它') === 0; }),
  (erpUI.opts || []).join(' | '));

/* 6e 流程：默认无中间点，「＋ 添加中间点」逐个加，最多 3 个 */
const p17 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=flow');
await sleep(2000);
const viasUI = await p17.cdp.evaluate(`(async function(){
  var flowCard = [].slice.call(document.querySelectorAll('.rep')).pop();
  if (!flowCard) return { err: 'no-flow-card' };
  var before = flowCard.querySelectorAll('.via-row').length;
  var add = flowCard.querySelector('.vias .add-rep');
  if (!add) return { err: 'no-add-via' };
  add.click();
  await new Promise(function(r){ setTimeout(r, 200); });
  var after1 = flowCard.querySelectorAll('.via-row').length;
  flowCard.querySelector('.vias .add-rep').click();
  await new Promise(function(r){ setTimeout(r, 200); });
  flowCard.querySelector('.vias .add-rep').click();
  await new Promise(function(r){ setTimeout(r, 200); });
  var after3 = flowCard.querySelectorAll('.via-row').length;
  var addNow = flowCard.querySelector('.vias .add-rep');
  return { before: before, after1: after1, after3: after3, maxed: addNow ? addNow.disabled : null,
           btnText: addNow ? addNow.textContent : '' };
})()`);
check('流程默认没有中间点', viasUI.before === 0, JSON.stringify(viasUI));
check('点「＋ 添加中间点」可逐个添加', viasUI.after1 === 1 && viasUI.after3 === 3, JSON.stringify(viasUI));
check('加到 3 个后按钮禁用', viasUI.maxed === true, String(viasUI.maxed));

/* 6f 附件允许图片和视频 */
const p18 = await newTab(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=media');
await sleep(2000);
const acceptUI = await p18.cdp.evaluate(`(function(){
  var ins = [].slice.call(document.querySelectorAll('input[type=file]'));
  return { accepts: ins.map(function(i){ return i.accept; }) };
})()`, false);
check('附件上传 accept 含 image 与 video',
  (acceptUI.accepts || []).some(function (a) { return a.indexOf('image/*') >= 0 && a.indexOf('video/*') >= 0; }),
  JSON.stringify(acceptUI.accepts));

/* 6g 真上传一个视频文件：入库 + 预览为 <video> + 导出进「现场视频」目录 */
const videoFlow = await p18.cdp.evaluate(`(async function(){
  var fake = new File([new Uint8Array(4096)], 'clip.mp4', { type: 'video/mp4' });
  var input = document.querySelectorAll('input[type=file]')[0];
  if (!input) return { err: 'no-input' };
  var dt = new DataTransfer(); dt.items.add(fake);
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  await new Promise(function(r){ setTimeout(r, 1500); });

  var thumbs = [].slice.call(document.querySelectorAll('.att'));
  var vidThumb = thumbs.filter(function(t){ return t.textContent.indexOf('\u89c6\u9891') >= 0; })[0];
  if (!vidThumb) return { err: 'no-video-thumb', n: thumbs.length };
  vidThumb.click();
  await new Promise(function(r){ setTimeout(r, 400); });
  var mask = document.getElementById('overlay');
  var vid = mask ? mask.querySelector('video') : null;
  var hasVideoEl = !!vid;
  if (mask) mask.remove();
  return { hasVideoEl: hasVideoEl, thumbCount: thumbs.length };
})()`);
check('视频可上传并出现在附件列表', !videoFlow.err, videoFlow.err || '');
check('视频预览用 <video> 播放器', videoFlow.hasVideoEl === true);

/* 6h 导出包里视频进「现场视频/」目录（在加载了 export.js 的页面验证） */
const p19 = await newTab(SITE + '/project.html?id=' + encodeURIComponent(pid));
await sleep(2200);
const videoExport = await p19.cdp.evaluate(`(async function(){
  var p = await AGV_DB.getProject(${JSON.stringify('__PID__')});
  var media = await AGV_DB.listMedia(p.id);
  var res = await AGV_EXPORT.build({ project: p, answers: p.answers || {}, media: media, includeVideos: true });
  var ab = await res.files[0].blob.arrayBuffer();
  var z = AGV_ZIP.readZip(ab);
  var names = z.entries.map(function(e){ return e.name; });
  return { all: names, videos: names.filter(function(n){ return n.indexOf('\u73b0\u573a\u89c6\u9891') === 0; }) };
})()`.replace('__PID__', pid));
check('导出包里有「现场视频/」目录',
  (videoExport.videos || []).length > 0, JSON.stringify(videoExport.videos || videoExport.all));
p19.ws.close();

/* 6i 新建方案：先项目名称(必填) → 客户名称(可空)，并自动带进基本信息 */
const p20 = await newTab(SITE + '/index.html');
await sleep(1800);
await p20.cdp.evaluate(`(function(){
  var seq = ['\u81ea\u52a8\u6d4b\u8bd5\u9879\u76ee', '\u81ea\u52a8\u6d4b\u8bd5\u5ba2\u6237'];
  window.prompt = function(){ return seq.length ? seq.shift() : null; };
  document.getElementById('btn-new').click();
  return true;
})()`, false);
await sleep(1800);

const p21 = await newTab(SITE + '/index.html');
await sleep(1800);
const autoFill = await p21.cdp.evaluate(`(async function(){
  var list = await AGV_DB.listProjects();
  var p = list.filter(function(x){ return x.name === '\u81ea\u52a8\u6d4b\u8bd5\u9879\u76ee'; })[0];
  if (!p) return { err: 'not-found', names: list.map(function(x){ return x.name; }) };
  var b = p.answers.basic || {};
  var out = { name: p.name, customer: p.customer,
              basicProject: b.project_name, basicCustomer: b.customer_name, id: p.id };
  await AGV_DB.deleteProject(p.id);   // 清理
  return out;
})()`);
check('新建时项目名称生效', autoFill.name === '自动测试项目', JSON.stringify(autoFill.err || autoFill.name));
check('新建时客户名称生效', autoFill.customer === '自动测试客户', String(autoFill.customer));
check('项目名称已自动带进「基本信息」', autoFill.basicProject === '自动测试项目', String(autoFill.basicProject));
check('客户名称已自动带进「基本信息」', autoFill.basicCustomer === '自动测试客户', String(autoFill.basicCustomer));
p20.ws.close(); p21.ws.close();

[p13, p14, p15, p16, p17, p18].forEach(function (x) { try { x.ws.close(); } catch (e) {} });

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(74));
console.log(`浏览器端到端测试: 通过 ${pass}   失败 ${fail}`);
console.log('='.repeat(74));

try { proc.kill(); } catch (e) { }
await sleep(600);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Edge 可能还占用，无害 */ }
process.exit(fail ? 1 : 0);
