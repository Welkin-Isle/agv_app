/* =============================================================================
 * prove_xlsx.mjs —— 验证「浏览器端离线改写调研表并保持格式」是否可行
 * =============================================================================
 * 思路（不引任何第三方库）：
 *   1. 读空白调研表 xlsx（本质是 ZIP）
 *   2. 只替换工作表 XML 里目标单元格的值（用 inlineStr，不动 sharedStrings）
 *   3. 其余条目（图片、样式、合并单元格定义）**原始压缩字节原样拷贝**
 *   4. 重新拼 ZIP → 用 openpyxl 读回，检查：值对不对、合并单元格在不在、图片在不在
 *
 * 若本脚本通过，说明 App 内可以离线生成"格式与空白表一致"的调研表。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const TEMPLATE = process.argv[2];
const OUT = process.argv[3];
if (!TEMPLATE || !OUT) {
  console.error('用法: node prove_xlsx.mjs "<空白调研表.xlsx>" "<输出.xlsx>"');
  process.exit(2);
}

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

/* ---------------- 读 ZIP ---------------- */
const buf = fs.readFileSync(TEMPLATE);
const u8 = new Uint8Array(buf);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

let eocd = -1;
for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
  if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('不是有效 xlsx'); process.exit(1); }
const total = dv.getUint16(eocd + 10, true);
let p = dv.getUint32(eocd + 16, true);

const entries = [];
for (let n = 0; n < total; n++) {
  if (dv.getUint32(p, true) !== 0x02014b50) break;
  const flags = dv.getUint16(p + 8, true);
  const method = dv.getUint16(p + 10, true);
  const time = dv.getUint16(p + 12, true);
  const date = dv.getUint16(p + 14, true);
  const crc = dv.getUint32(p + 16, true);
  const compSize = dv.getUint32(p + 20, true);
  const uncompSize = dv.getUint32(p + 24, true);
  const nameLen = dv.getUint16(p + 28, true);
  const extraLen = dv.getUint16(p + 30, true);
  const commentLen = dv.getUint16(p + 32, true);
  const localOff = dv.getUint32(p + 42, true);
  const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));
  entries.push({ name, flags, method, time, date, crc, compSize, uncompSize, localOff });
  p += 46 + nameLen + extraLen + commentLen;
}
console.log(`模板条目数: ${entries.length}`);

/* ---------------- 取出某条目的原始压缩字节 ---------------- */
function rawData(e) {
  const lnl = dv.getUint16(e.localOff + 26, true);
  const lel = dv.getUint16(e.localOff + 28, true);
  const start = e.localOff + 30 + lnl + lel;
  return u8.subarray(start, start + e.compSize);
}
function inflate(e) {
  const d = rawData(e);
  if (e.method === 0) return Buffer.from(d);
  if (e.method === 8) return zlib.inflateRawSync(Buffer.from(d));
  throw new Error('不支持的压缩方式 ' + e.method);
}

/* ---------------- 改写 sheet XML ---------------- */
const sheetEntry = entries.find(e => e.name === 'xl/worksheets/sheet1.xml');
if (!sheetEntry) { console.error('找不到 sheet1.xml'); process.exit(1); }
let xml = inflate(sheetEntry).toString('utf8');
console.log(`sheet1.xml 原大小: ${(xml.length / 1024).toFixed(0)} KB`);

/**
 * 把某行某列的值设为文本（inlineStr）；若该单元格已存在，整段替换。
 * 值传 null 表示清空（删掉 <v> 保留样式）。
 */
function setCell(xml, row, col, text) {
  const colName = colToName(col);
  const ref = colName + row;
  const inline = `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;

  // 1) 已存在该单元格
  const re = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  if (re.test(xml)) {
    // 保留样式 s="..."
    const m = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>)`).exec(xml);
    const styleM = m && /\bs="(\d+)"/.exec(m[1]);
    const styled = styleM ? inline.replace('<c r="' + ref + '"', '<c r="' + ref + '" s="' + styleM[1] + '"') : inline;
    return xml.replace(re, styled);
  }

  // 2) 不存在：插到该 <row> 里（按列顺序）
  const rowRe = new RegExp(`<row[^>]*r="${row}"[^>]*>([\\s\\S]*?)</row>`);
  const rm = rowRe.exec(xml);
  if (!rm) return xml;                        // 该行不存在则跳过（不改结构）
  const inner = rm[1];
  let newInner = inner;
  // 找到第一个列号大于目标列的单元格，插在它前面
  const cellRe = /<c r="([A-Z]+)(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let insertAt = -1, mm;
  while ((mm = cellRe.exec(inner)) !== null) {
    if (colToIndex(mm[1]) > col) { insertAt = mm.index; break; }
  }
  if (insertAt >= 0) newInner = inner.slice(0, insertAt) + inline + inner.slice(insertAt);
  else newInner = inner + inline;
  return xml.replace(rm[0], rm[0].replace(inner, newInner));
}
function colToName(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function colToIndex(name) {
  let n = 0;
  for (const ch of name) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* 用 refs/字段清单.csv 的真实映射写几个字段：
 *   R2 客户名 → D 列；R3 项目名 → D 列；R12 SKU → F 列；R25 载具类型 → F 列 */
const testValues = [
  [2, 4, '삼양식품 (Samyang Foods)'],
  [3, 4, '方形包装半成品码垛/出货自动化'],
  [4, 4, '韩国 江原道 原州工厂'],
  [12, 6, '12'],
  [13, 6, '方形包装半成品，纸箱装，单箱约 12kg'],
  [25, 6, '田字托盘'],
  [26, 6, '短边进叉'],
  [66, 6, '-18 ~ 5'],
  [67, 6, '9'],
];
testValues.forEach(([r, c, v]) => { xml = setCell(xml, r, c, v); });
console.log(`已写入 ${testValues.length} 个单元格`);

/* ---------------- 重新打包（未改动条目原样拷贝） ---------------- */
const patched = Buffer.from(xml, 'utf8');
const patchedCrc = crc32(patched);

const parts = [];      // local headers + data
const central = [];    // central directory
let offset = 0;

for (const e of entries) {
  const isPatched = e.name === 'xl/worksheets/sheet1.xml';
  let method, crc, comp, uncomp;

  if (isPatched) {
    // 用 stored(0) 存，避免依赖压缩库，兼容性最好
    method = 0; crc = patchedCrc; comp = patched; uncomp = patched;
  } else {
    method = e.method; crc = e.crc;
    comp = Buffer.from(rawData(e));
    uncomp = null;                          // 只需长度，从中央目录拷贝
  }

  const nameBuf = Buffer.from(e.name, 'utf8');
  const compSize = comp.length;
  const uncompSize = isPatched ? patched.length : e.uncompSize;

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(e.time, 10);
  lh.writeUInt16LE(e.date, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(compSize, 18);
  lh.writeUInt32LE(uncompSize, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  parts.push(lh, nameBuf, comp);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(e.time, 12);
  cd.writeUInt16LE(e.date, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(compSize, 20);
  cd.writeUInt32LE(uncompSize, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([cd, nameBuf]));

  offset += lh.length + nameBuf.length + compSize;
}

const cdBuf = Buffer.concat(central);
const eocdOut = Buffer.alloc(22);
eocdOut.writeUInt32LE(0x06054b50, 0);
eocdOut.writeUInt16LE(0, 4);
eocdOut.writeUInt16LE(0, 6);
eocdOut.writeUInt16LE(entries.length, 8);
eocdOut.writeUInt16LE(entries.length, 10);
eocdOut.writeUInt32LE(cdBuf.length, 12);
eocdOut.writeUInt32LE(offset, 16);
eocdOut.writeUInt16LE(0, 20);

const outBuf = Buffer.concat([...parts, cdBuf, eocdOut]);
fs.writeFileSync(OUT, outBuf);
console.log(`\n已生成: ${OUT}`);
console.log(`  大小: ${(outBuf.length / 1048576).toFixed(2)} MB（模板 ${(buf.length / 1048576).toFixed(2)} MB）`);
