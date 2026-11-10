/* =============================================================================
 * shots.mjs —— 用无头 Edge 给主要页面截图（含预置示例数据）
 * 用法: node agv_app/tests/shots.mjs [端口]
 * ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = `http://127.0.0.1:${process.argv[2] || 8899}`;
const PORT = 9555;
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const prof = path.join(HERE, '.edge-shots');
fs.rmSync(prof, { recursive: true, force: true });

const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--hide-scrollbars', '--mute-audio', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });

for (let i = 0; i < 50; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (e) { }
  await sleep(300);
}

let idSeq = 0; const pend = new Map(); let ws;
async function open(url) {
  let r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`);
  const t = await r.json();
  const s = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { s.addEventListener('open', res); s.addEventListener('error', rej); });
  const cdp = {
    ws: s,
    send(method, params = {}) {
      const id = ++idSeq;
      return new Promise((resolve, reject) => {
        pend.set(id, { resolve, reject });
        s.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expr, awaitPromise = true) {
      const r2 = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, userGesture: true });
      if (r2.exceptionDetails) throw new Error(r2.exceptionDetails.text);
      return r2.result.value;
    }
  };
  s.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 430, height: 932, deviceScaleFactor: 2, mobile: true
  });
  return cdp;
}
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const p = path.join(HERE, name);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('  ' + name + '  ' + Math.round(fs.statSync(p).size / 1024) + ' KB');
}

/* ---------- 1. 造数据 ---------- */
const seed = await open(SITE + '/index.html');
const pid = await seed.evaluate(`(async () => {
  const answers = {
    basic: { customer_name: '삼양식품', project_name: '원주공장 코드 파렛타이징',
      site_address: '韩国 江原道 原州工厂', contact: '김민수', position: '物流自动化经理',
      contact_info: 'min@example.com', kickoff: '2027年3月', purchase_mode: '议标' },
    material_overview: { sku_count: {m:'single',v:12}, material_desc: '方形包装半成品，纸箱装，单箱约 12kg', material_attr: ['常规'] },
    material: [ { pack_form:'箱装', pack_size:'600×400×300', material_weight:{m:'range',a:11,b:13}, info_record:['二维码'] } ],
    carrier: [ { carrier_for_material:'A1', carrier_type:'货架存储型托盘', carrier_material:'塑料', carrier_weight:{m:'single',v:25} } ],
    combo: [ { ref_material:1, ref_carrier:1, stack_mode:'自动码盘', load_weight:{m:'range',a:1000,b:1200},
      pallet_length:{m:'single',v:1000}, pallet_width:{m:'single',v:1200},
      cargo_height:{m:'single',v:1500}, pallet_height:{m:'single',v:150} } ],
    place: [ { code:'D1', name:'原料库' }, { code:'E1', name:'包装线' }, { code:'F1', name:'缓存区' } ],
    flow: [ { route_start:'D1 原料库', vias:['F1 缓存区'], route_end:'E1 包装线', cargo:'A1（箱装）', flow_rate:{m:'single',v:45} } ],
    site: { temperature:{m:'range',a:5,b:30}, building_height:{m:'single',v:9}, slope:{m:'le',v:2}, floor_capacity:{m:'le',v:3}, floor_condition:'良好（平整、无裂缝）', glare:'无', dust:'无' },
    extra: { aisle_width_mm:{m:'range',a:2000,b:null}, site_environment:['室内'] },
    stacking: [ { place:'F1 缓存区', layers:{m:'single',v:3} } ],
    other: { other_requirements:'客户要求三向堆垛式；如运营需要也可接受三向+前移式。' }
  };
  const p = AGV_DB.newProject({ customer: '삼양식품', name: '원주공장 코드 파렛타이징', answers: answers });
  await AGV_DB.putProject(p);
  const p2 = AGV_DB.newProject({ customer: 'SOSTRA', name: '하노이 물류센터' });
  p2.answers = { basic: { customer_name: 'SOSTRA', project_name: '하노이 물류센터' }, extra: { site_environment: '室外' } };
  p2.status = 'done';
  await AGV_DB.putProject(p2);
  document.cookie = 'seeded=1';
  return p.id;
})()`);
console.log('  已造 2 个方案, id=' + pid);

/* ---------- 2. 首页 ---------- */
const c1 = await open(SITE + '/index.html');
await sleep(2200);
await shot(c1, 'shot-home.png');

/* ---------- 3. 工作台 ---------- */
const c2 = await open(SITE + '/project.html?id=' + encodeURIComponent(pid));
await sleep(2200);
await shot(c2, 'shot-workspace.png');

/* ---------- 4. 模块页（组合 C） ---------- */
const c3 = await open(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=combo');
await sleep(2200);
await shot(c3, 'shot-module.png');

/* ---------- 4z. 物料信息（尺寸文本输入） ---------- */
const c3m = await open(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=material');
await sleep(2000);
await shot(c3m, 'shot-material.png');
// 演示软提醒：把尺寸改成只写一个数字
await c3m.evaluate(`(function(){
  var labels = [].slice.call(document.querySelectorAll('.field'));
  var f = labels.filter(function(x){
    var l = x.querySelector('.flabel');
    return l && l.textContent.indexOf('\u5c3a\u5bf8') === 0;
  })[0];
  if (!f) return false;
  var i = f.querySelector('input');
  i.value = '600';
  i.dispatchEvent(new Event('input'));
  return true;
})()`);
await sleep(500);
await shot(c3m, 'shot-material-warn.png');

/* ---------- 4a. 基本信息（新顺序） ---------- */
const c3a = await open(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=basic');
await sleep(2000);
await shot(c3a, 'shot-basic.png');

/* ---------- 4b. 流程页（地点+路线） ---------- */
const c3b = await open(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=flow');
await sleep(2200);
await shot(c3b, 'shot-flow.png');

/* ---------- 4c. 选型补充页（通道宽度/层数） ---------- */
const c3c = await open(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=extra');
await sleep(2200);
await shot(c3c, 'shot-extra.png');

/* ---------- 5. 自检页 ---------- */
const c4 = await open(SITE + '/selftest.html');
await sleep(4000);
await shot(c4, 'shot-selftest.png');

/* ---------- 6. 附件页 ---------- */
const c5 = await open(SITE + '/module.html?id=' + encodeURIComponent(pid) + '&m=media');
await sleep(2200);
await shot(c5, 'shot-media.png');

[c1, c2, c3, c3m, c3a, c3b, c3c, c4, c5, seed].forEach(c => { try { c.ws.close(); } catch (e) { } });
try { proc.kill(); } catch (e) { }
await sleep(700);
try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { }
console.log('截图完成');
