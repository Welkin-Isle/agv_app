/**
 * build_pdf.mjs —— 把 Markdown 说明文档渲染成 PDF（A4）
 *
 * 用法： node tests/build_pdf.mjs <输入.md> <输出.pdf> [预览.png]
 *
 * 为什么自己写：这台机器上没有 pandoc / wkhtmltopdf，但 Edge 自带
 * Chrome DevTools 协议的 Page.printToPDF，能完整保留中文字体、表格与底色，
 * 分页也比"截图拼页"干净。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MD = path.resolve(process.argv[2] || '使用注意事项.md');
const OUT = path.resolve(process.argv[3] || '使用注意事项.pdf');
const SHOT = process.argv[4] ? path.resolve(process.argv[4]) : null;

/* ============================ 1. Markdown → HTML ============================ */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  let list = null;      // { tag: 'ul'|'ol', items: [] }
  let quote = [];
  let table = null;     // { head: [], rows: [] }
  let code = null;

  const flushPara = () => {
    if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
  };
  const flushList = () => {
    if (list) {
      out.push('<' + list.tag + '>' + list.items.map((x) => '<li>' + inline(x) + '</li>').join('') + '</' + list.tag + '>');
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) { out.push('<blockquote>' + quote.map((l) => '<p>' + inline(l) + '</p>').join('') + '</blockquote>'); quote = []; }
  };
  const flushTable = () => {
    if (table) {
      const th = table.head.map((h) => '<th>' + inline(h) + '</th>').join('');
      const tr = table.rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('');
      out.push('<table><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table>');
      table = null;
    }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); flushTable(); };

  while (i < lines.length) {
    const ln = lines[i];
    const t = ln.trim();

    // 代码块
    if (code !== null) {
      if (t.startsWith('```')) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; }
      else code.push(ln);
      i++; continue;
    }
    if (t.startsWith('```')) { flushAll(); code = []; i++; continue; }
    if (!t) { flushAll(); i++; continue; }

    // 分隔线
    if (/^-{3,}$/.test(t)) { flushAll(); out.push('<hr>'); i++; continue; }

    // 标题
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushAll();
      const lv = h[1].length;
      out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>');
      i++; continue;
    }

    // 表格
    if (t.startsWith('|') && t.endsWith('|')) {
      flushPara(); flushList(); flushQuote();
      const cells = t.slice(1, -1).split('|').map((x) => x.trim());
      const isSep = cells.every((c) => /^:?-{2,}:?$/.test(c));
      if (isSep) { i++; continue; }
      if (!table) table = { head: cells, rows: [] };
      else if (table.head && table.rows.length === 0 && cells.every((c) => /^:?-+:?$/.test(c))) { /* skip */ }
      else table.rows.push(cells);
      i++; continue;
    } else if (table) flushTable();

    // 引用
    if (t.startsWith('>')) { flushPara(); flushList(); quote.push(t.replace(/^>\s?/, '')); i++; continue; }
    else if (quote.length) flushQuote();

    // 列表
    const ul = t.match(/^[-*]\s+(.*)$/);
    const ol = t.match(/^(\d+)\.\s+(.*)$/);
    if (ul || ol) {
      flushPara(); flushQuote();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(ul ? ul[1] : ol[2]);
      i++; continue;
    } else if (list) flushList();

    para.push(t);
    i++;
  }
  flushAll();
  if (code) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  return out.join('\n');
}

const CSS = `
@page { size: A4; margin: 16mm 14mm 16mm 14mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0; color: #1e293b; background: #fff;
  font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Noto Sans CJK SC", sans-serif;
  font-size: 10.5pt; line-height: 1.72;
}
h1 { font-size: 21pt; margin: 0 0 6pt; color: #1d4ed8; letter-spacing: .2pt; }
h2 {
  font-size: 13.5pt; margin: 18pt 0 7pt; padding-left: 9pt; color: #0f172a;
  border-left: 4pt solid #2563eb; line-height: 1.35; page-break-after: avoid;
}
h3 { font-size: 11.5pt; margin: 12pt 0 5pt; color: #1e40af; page-break-after: avoid; }
p { margin: 5pt 0; }
strong { color: #0f172a; }
a { color: #2563eb; text-decoration: none; word-break: break-all; }
code {
  font-family: Consolas, "Cascadia Mono", monospace; font-size: 9.5pt;
  background: #f1f5f9; border: .5pt solid #e2e8f0; border-radius: 3pt;
  padding: 0 3pt; color: #0f766e;
}
pre {
  background: #f8fafc; border: .5pt solid #e2e8f0; border-left: 3pt solid #94a3b8;
  border-radius: 4pt; padding: 8pt 10pt; margin: 7pt 0; overflow: hidden;
  page-break-inside: avoid;
}
pre code { background: none; border: 0; padding: 0; color: #334155; font-size: 9pt; line-height: 1.6; }
ul, ol { margin: 5pt 0 5pt 0; padding-left: 18pt; }
li { margin: 2.5pt 0; }
li > code, p > code { white-space: nowrap; }
blockquote {
  margin: 8pt 0; padding: 7pt 11pt; background: #eff6ff;
  border-left: 3pt solid #3b82f6; border-radius: 0 4pt 4pt 0; color: #1e3a8a;
  page-break-inside: avoid;
}
blockquote p { margin: 2pt 0; }
hr { border: 0; border-top: .8pt dashed #cbd5e1; margin: 14pt 0; }
table {
  width: 100%; border-collapse: collapse; margin: 7pt 0; font-size: 9.8pt;
  page-break-inside: avoid;
}
th {
  background: #e8effb; color: #0f172a; text-align: left; font-weight: 600;
  padding: 5pt 7pt; border: .5pt solid #cbd5e1;
}
td { padding: 5pt 7pt; border: .5pt solid #dbe2ea; vertical-align: top; }
tbody tr:nth-child(even) td { background: #f8fafc; }
h1, h2, h3 { break-after: avoid; }
table, blockquote, pre { break-inside: avoid; }
`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(path.basename(MD, path.extname(MD)))}</title>
<style>${CSS}</style></head>
<body>
${mdToHtml(fs.readFileSync(MD, 'utf8'))}
</body></html>`;

const TMP = path.join(os.tmpdir(), 'agv_pdf_build');
fs.mkdirSync(TMP, { recursive: true });
const HTML_PATH = path.join(TMP, 'doc.html');
fs.writeFileSync(HTML_PATH, html, 'utf8');

/* ============================ 2. CDP 打印 ============================ */

const port = 9400 + Math.floor(Math.random() * 200);
const profile = path.join(TMP, 'profile-' + port);
const edge = spawn(EDGE, [
  '--headless=new',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  'about:blank'
], { stdio: 'ignore' });

let msgId = 0;
const pending = new Map();

function connect() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).then((j) => {
        resolve(j.webSocketDebuggerUrl);
      }).catch(() => {
        if (Date.now() - t0 > 20000) reject(new Error('Edge 启动超时'));
        else setTimeout(poll, 200);
      });
    })();
  });
}

function makeClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve({
      send(method, params, sessionId) {
        const id = ++msgId;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    });
    ws.onerror = (e) => reject(new Error('WebSocket 连接失败'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message));
        else p.res(m.result);
      }
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let browser, page;
  try {
    const wsUrl = await connect();
    browser = await makeClient(wsUrl);

    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    page = {
      send: (m, p) => browser.send(m, p, sessionId)
    };

    await page.send('Page.enable');
    await page.send('Runtime.enable');

    const fileUrl = 'file:///' + HTML_PATH.replace(/\\/g, '/');
    await page.send('Page.navigate', { url: fileUrl });
    // 等字体与图片就绪
    for (let k = 0; k < 40; k++) {
      const r = await page.send('Runtime.evaluate', {
        expression: 'document.readyState === "complete" && !!document.body && document.body.innerText.length > 200',
        returnByValue: true
      });
      if (r.result && r.result.value) break;
      await sleep(150);
    }
    await page.send('Runtime.evaluate', { expression: 'document.fonts ? document.fonts.ready.then(()=>1) : 1', awaitPromise: true });
    await sleep(300);

    const pdf = await page.send('Page.printToPDF', {
      printBackground: true,
      paperWidth: 8.27,      // A4 英寸
      paperHeight: 11.69,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      displayHeaderFooter: false,
      preferCSSPageSize: true
    });
    fs.writeFileSync(OUT, Buffer.from(pdf.data, 'base64'));
    const kb = (fs.statSync(OUT).size / 1024).toFixed(1);

    // 统计页数（PDF 简化解析）
    const buf = fs.readFileSync(OUT);
    const txt = buf.toString('latin1');
    const pages = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
    console.log(`✓ PDF 已生成：${OUT}  ${kb} KB  ${pages} 页`);

    // 可选：整页预览图
    if (SHOT) {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 794, height: 1123, deviceScaleFactor: 2, mobile: false
      });
      await sleep(300);
      const shot = await page.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true, fromSurface: true
      });
      fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      console.log(`✓ 预览图：${SHOT}  ${(fs.statSync(SHOT).size / 1024).toFixed(1)} KB`);
    }
  } catch (e) {
    console.error('✗ 失败：' + e.message);
    process.exitCode = 1;
  } finally {
    try { if (browser) browser.close(); } catch (e) {}
    edge.kill();
  }
})();
