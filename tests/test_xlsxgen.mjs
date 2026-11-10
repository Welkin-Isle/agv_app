/* =============================================================================
 * test_xlsxgen.mjs —— 端到端验证 xlsx 生成器（Node 内运行真实前端代码）
 * =============================================================================
 * 用真实空白调研表 + 一份"含溢出组合"的答案，跑 agv_app 的 zip.js + xlsxgen.js，
 * 生成 xlsx 后用 openpyxl（由 test_xlsxgen.py 调用）核对：
 *   字段值是否正确、合并单元格/图片是否保留、扩展区是否写入、空字段是否留空
 *
 * 用法: node agv_app/tests/test_xlsxgen.mjs
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', 'docs');
const ROOT = path.resolve(PUB, '..', '..');
const TEMPLATE = path.join(PUB, 'template', 'template.xlsx');
const OUT = path.join(HERE, '_gen.xlsx');

globalThis.window = globalThis;
for (const f of ['assets/zip.js', 'assets/util.js', 'assets/schema.js', 'assets/xlsxgen.js']) {
  (0, eval)(fs.readFileSync(path.join(PUB, f), 'utf8'));
}
const XLSX = globalThis.AGV_XLSX, SCHEMA = globalThis.AGV_SCHEMA;

let pass = 0, fail = 0;
const check = (n, c, e) => {
  if (c) { pass++; console.log('  ✓ ' + n + (e ? '  ' + e : '')); }
  else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); }
};

console.log('='.repeat(72));
console.log('xlsx 生成器 端到端测试');
console.log('='.repeat(72));

/* ---------------- 造一份含溢出的答案 ---------------- */
const answers = {
  basic: {
    customer_name: '삼양식품 (Samyang Foods)',
    project_name: '方形包装半成品码垛/出货自动化',
    site_address: '韩国 江原道 原州工厂',
    contact: '김민수',
    position: '物流自动化经理',
    contact_info: 'min@example.com / +82-10-1234-5678',
    kickoff: '2027年3月',
    purchase_mode: '议标'
  },
  material_overview: {
    sku_count: { m: 'single', v: 12 },
    material_desc: '方形包装半成品，纸箱装，单箱约 12kg',
    material_attr: ['常规']
  },
  material: [
    { pack_form: '箱装', pack_size: { L: 600, W: 400, H: 300 }, material_weight: { m: 'range', a: 11, b: 13 }, info_record: ['二维码'] },
    { pack_form: '箱装', pack_size: { m: 'single', v: 500 }, material_weight: { m: 'single', v: 10 }, info_record: ['二维码'] },
    { pack_form: '袋装', pack_size: { text: '按图纸' }, material_weight: { m: 'single', v: 8 }, info_record: ['无'] }
  ],
  carrier: [
    { carrier_for_material: 'A1、A2', carrier_type: '货架存储型托盘', carrier_material: '塑料', carrier_weight: { m: 'single', v: 25 }, carrier_info_record: ['二维码'] },
    { carrier_for_material: 'A3', carrier_type: '料箱', carrier_material: '塑料', carrier_weight: { m: 'single', v: 12 }, carrier_info_record: ['无'] }
  ],
  combo: [
    { ref_material: 1, ref_carrier: 1, stack_mode: '自动码盘', load_weight: { m: 'range', a: 1000, b: 1200 },
      pallet_length: { m: 'single', v: 1000 }, cargo_length: { m: 'single', v: 950 },
      dim_L1: { m: 'single', v: 200 }, dim_L2: { m: 'single', v: 200 },
      fork_hole_width: { m: 'single', v: 240 }, pallet_width: { m: 'single', v: 1200 },
      cargo_width: { m: 'single', v: 1150 }, cargo_height: { m: 'single', v: 1500 },
      pallet_height: { m: 'single', v: 150 }, fork_hole_height: { m: 'single', v: 100 } },
    { ref_material: 2, ref_carrier: 1, stack_mode: '自动码盘', load_weight: { m: 'single', v: 800 },
      pallet_length: { m: 'single', v: 1000 }, pallet_width: { m: 'single', v: 1200 },
      cargo_height: { m: 'single', v: 1400 }, pallet_height: { m: 'single', v: 150 } },
    { ref_material: 3, ref_carrier: 2, stack_mode: '人工码盘', load_weight: { m: 'single', v: 500 },
      pallet_length: { m: 'single', v: 600 }, pallet_width: { m: 'single', v: 400 },
      cargo_height: { m: 'single', v: 900 }, pallet_height: { m: 'single', v: 120 } }
  ],
  place: [
    { code: 'D1', name: '原料库' },
    { code: 'E1', name: '包装线' },
    { code: 'F1', name: '缓存区' }
  ],
  flow: [
    { route_start: 'D1 原料库', vias: ['F1 缓存区'], route_end: 'E1 包装线', cargo: 'A1（箱装）', flow_rate: { m: 'single', v: 45 } },
    { route_start: 'E1 包装线', route_end: 'F1 缓存区', cargo: 'C1（自动码盘）', flow_rate: { m: 'single', v: 30 } }
  ],
  process: { process_text: '原料入库 → 拆包 → 码盘 → 货架存储 → 按订单拣选 → 出货装车。' },
  site: {
    temperature: { m: 'range', a: -18, b: 5 },
    building_height: { m: 'single', v: 9 },
    slope: { m: 'le', v: 0 },
    floor_capacity: { m: 'le', v: 2 },
    floor_condition: '良好（平整、无裂缝）',
    glare: '无',
    dust: '无'
  },
  work: { existing_equipment: '现有叉车 4 台', driver_count: { m: 'single', v: 6 }, work_time: '两班倒，每班 10 小时' },
  system: {
    erp: 'MES和ERP', wms: '有', site_devices: '产线接驳位 4 处，电动门 2 樘',
    trigger_by_system: '是', trigger_mode: '系统联机自动运行', trigger_place: '集中区域'
  },
  extra: {
    aisle_width_mm: { m: 'range', a: 2000, b: null },
    site_environment: ['室内', '冷库']
  },
  stacking: [
    { place: 'F1 缓存区', layers: { m: 'single', v: 3 } },
    { place: 'E1 包装线', layers: { m: 'single', v: 2 } }
  ],
  other: { other_requirements: '客户要求三向堆垛式；如运营需要也可接受三向+前移式。现场电压 380V/60Hz。' }
};

/* ---------------- 生成 ---------------- */
const tplBuf = fs.readFileSync(TEMPLATE);
const ab = tplBuf.buffer.slice(tplBuf.byteOffset, tplBuf.byteOffset + tplBuf.byteLength);

console.log('\n— 1) 生成 —');
const t0 = Date.now();
const blob = await XLSX.generate(ab, { customer: '삼양식품', name: '원주공장' }, answers, SCHEMA);
const ms = Date.now() - t0;
const outBuf = Buffer.from(await blob.arrayBuffer());
fs.writeFileSync(OUT, outBuf);
check('生成成功', outBuf.length > 20000, (outBuf.length / 1024).toFixed(0) + ' KB');
check('耗时 < 3 秒', ms < 3000, ms + ' ms');
check('文件名符合规范', /^1\.1 AGV项目需求调研表_.+_\d{8}\.xlsx$/.test(XLSX.fileName({ customer: '삼양식품' })),
  XLSX.fileName({ customer: '삼양식품' }));

/* ---------------- 用 openpyxl 核对 ---------------- */
console.log('\n— 2) openpyxl 核对（调用 Python） —');
const py = process.env.AGV_PY || 'python';
const pyScript = path.join(HERE, '_verify_gen.py');
fs.writeFileSync(pyScript, `
import openpyxl, sys, json
sys.stdout.reconfigure(encoding="utf-8")
wb = openpyxl.load_workbook(r"${OUT.replace(/\\/g, '\\\\')}")
tplwb = openpyxl.load_workbook(r"${TEMPLATE.replace(/\\/g, '\\\\')}")
tplws = tplwb["表1-项目基本情况"]
ws = wb["表1-项目基本情况"]
res = {
  "tpl_merges": len(tplws.merged_cells.ranges),
  "tpl_imgs_main": len(getattr(tplws, "_images", [])),
  "tpl_imgs_site": len(getattr(tplwb["现场勘查图"], "_images", [])),
  "sheets": wb.sheetnames,
  "dims": [ws.max_row, ws.max_column],
  "merges": len(ws.merged_cells.ranges),
  "imgs_main": len(getattr(ws, "_images", [])),
  "imgs_site": len(getattr(wb["现场勘查图"], "_images", [])),
  "cells": {}, "ext": []
}
probe = {
  "basic.customer_name": (2,4), "basic.project_name": (3,4), "basic.site_address": (4,4),
  "basic.contact": (5,4), "basic.contact_info": (7,4), "basic.purchase_mode": (9,4),
  "overview.sku_count": (12,6), "overview.desc": (13,6), "overview.attr": (14,6),
  "mat1.pack_form": (15,6), "mat1.pack_size": (16,6), "mat1.weight": (17,6),
  "mat2.pack_form": (19,6), "mat2.pack_size": (20,6),
  "carrier1.type": (25,6), "carrier1.weight": (28,6),
  "combo1.stack": (31,6), "combo1.load": (32,6), "combo1.pallet_L": (33,6),
  "combo1.fork_hole_h": (42,6),
  "combo2.stack": (43,6), "combo2.pallet_L": (45,6),
  "flow1.start": (55,6), "flow1.end": (56,6), "flow1.cargo": (57,6), "flow1.rate": (59,6),
  "flow1.carrier_col_empty": (58,6),
  "flow2.start": (60,6),
  "site.temp": (66,6), "site.height": (67,6), "site.slope": (68,6), "site.capacity": (70,6),
  "work.driver": (74,6), "work.time": (75,6),
  "sys.erp": (76,6), "sys.trigger_mode": (80,6),
  "process": (65,3),
}
for k,(r,c) in probe.items():
    v = ws.cell(row=r, column=c).value
    res["cells"][k] = None if v is None else str(v)[:60]
# 数值字段必须是数字类型（不能是字符串），否则 Excel 算不了、选型脚本可能读不到
res["types"] = {}
for k,(r,c) in {"num.sku":(12,6), "num.pallet_L":(33,6), "num.fork_hole_h":(42,6),
                "num.height":(67,6), "num.driver":(74,6), "num.flow_rate":(59,6)}.items():
    v = ws.cell(row=r, column=c).value
    res["types"][k] = type(v).__name__
# 真正未填的字段应为空
for k,(r,c) in {"empty.carrier_fork":(26,6), "empty.combo2_cargo_len":(46,6),
                "empty.combo2_L1":(47,6), "empty.combo2_cargo_w":(51,6)}.items():
    v = ws.cell(row=r, column=c).value
    res["cells"][k] = None if v is None else str(v)[:40]
# 扩展区：R84 起
for r in range(84, ws.max_row + 1):
    c3 = ws.cell(row=r, column=3).value
    c6 = ws.cell(row=r, column=6).value
    if c3 or c6:
        res["ext"].append([r, str(c3)[:40] if c3 else None, str(c6)[:40] if c6 else None])
print(json.dumps(res, ensure_ascii=False))
`);
let pyOut;
try {
  pyOut = execFileSync(py, [pyScript], { encoding: 'utf8' });
} catch (e) {
  console.log('  ✗ 调用 Python 失败（设置 AGV_PY 环境变量指向 python.exe）');
  console.log(String(e.message).slice(0, 400));
  process.exit(1);
}
const R = JSON.parse(pyOut.trim().split('\n').filter(l => l.startsWith('{')).pop());

check('工作表 3 个', R.sheets.length === 3, R.sheets.join(','));
check('合并单元格与模板一致', R.merges === R.tpl_merges, R.merges + ' / 模板 ' + R.tpl_merges);
check('主表图片与模板一致', R.imgs_main === R.tpl_imgs_main, R.imgs_main + ' / 模板 ' + R.tpl_imgs_main);
check('勘查图图片与模板一致', R.imgs_site === R.tpl_imgs_site, R.imgs_site + ' / 模板 ' + R.tpl_imgs_site);

const C = R.cells;
const eq = (k, expect) => {
  const got = C[k];
  const ok = got !== null && String(got).includes(String(expect));
  check(k + ' = ' + JSON.stringify(expect), ok, got === null ? '(空)' : JSON.stringify(got).slice(0, 46));
};
console.log('\n— 3) 字段落位 —');
eq('basic.customer_name', '삼양식품');
eq('basic.project_name', '方形包装');
eq('basic.site_address', '韩国');
eq('basic.contact', '김민수');
eq('basic.purchase_mode', '议标');
eq('overview.sku_count', '12');
eq('overview.attr', '常规');
eq('mat1.pack_form', '箱装');
eq('mat1.pack_size', '600×400×300');
eq('mat2.pack_size', '500');   // 旧数据（数字对象）仍能正确导出
eq('mat1.weight', '11 ~ 13');
eq('mat2.pack_form', '箱装');
eq('carrier1.type', '货架存储型托盘');
eq('combo1.stack', '自动码盘');
eq('combo1.load', '1000 ~ 1200');
eq('combo1.pallet_L', '1000');
eq('combo1.fork_hole_h', '100');
eq('combo2.stack', '自动码盘');
eq('flow1.start', 'D1 原料库');
eq('flow1.end', 'E1 包装线');
eq('flow1.cargo', 'A1');
eq('flow1.rate', '45');
eq('flow2.start', 'E1 包装线');
eq('site.temp', '-18 ~ 5');
eq('site.height', '9');
eq('site.capacity', '≤ 2');
eq('site.slope', '≤ 0');
eq('work.driver', '6');
eq('sys.erp', 'MES和ERP');
eq('sys.trigger_mode', '系统联机自动运行');
eq('process', '原料入库');

console.log('\n— 4) 未填字段应保持空白 —');
check('未填的进叉方向为空', C['empty.carrier_fork'] === null, JSON.stringify(C['empty.carrier_fork']));
check('未填的组合C2货物长为空', C['empty.combo2_cargo_len'] === null, JSON.stringify(C['empty.combo2_cargo_len']));
check('未填的组合C2 L1为空', C['empty.combo2_L1'] === null, JSON.stringify(C['empty.combo2_L1']));
check('未填的组合C2货物宽为空', C['empty.combo2_cargo_w'] === null, JSON.stringify(C['empty.combo2_cargo_w']));

console.log('\n— 4b) 数值字段必须是数字类型（不是文本） —');
Object.entries(R.types).forEach(([k, t]) => {
  check(k + ' 为数值型', t === 'int' || t === 'float' || t === 'int64' || t === 'long', '实际类型 ' + t);
});

console.log('\n— 5) 扩展区（超出原表容量的部分 + 选型补充 + 其他需求） —');
const extText = R.ext.map(x => (x[1] || '') + '=' + (x[2] || '')).join(' | ');
console.log('     R84 起共 ' + R.ext.length + ' 行');
['物料 A3', '载具 B2', '组合 C3', '现场实际通道宽度', '运行环境', '其他需求', '三向堆垛式',
   '地点清单', 'D1', '原料库', '≥ 2000',
   '堆叠层数', '3 层', '2 层', '流程路线', '中间点1【F1】', '按图纸',
   '室内、冷库']
  .forEach(k => check('扩展区含「' + k + '」', extText.includes(k)));

console.log('\n' + '='.repeat(72));
console.log(`xlsx 生成器测试: 通过 ${pass}   失败 ${fail}`);
console.log('='.repeat(72));
fs.unlinkSync(pyScript);
process.exit(fail ? 1 : 0);
