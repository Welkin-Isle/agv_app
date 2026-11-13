/* =============================================================================
 * xlsxgen.js —— 把答案注入空白调研表，生成"格式完全一致"的 xlsx
 * =============================================================================
 * 原理（已在 agv_app/tests/prove_xlsx.mjs 验证）：
 *   只改 xl/worksheets/sheet1.xml 里目标单元格；其余 36 个条目（图片/样式/
 *   合并单元格定义）原始压缩字节原样拷贝 → 格式不可能变。
 *
 * 两条铁律：
 *   ① 只写"有值"的单元格。没填的一律不动 → 原表的提示文字/空白全部保留。
 *   ② 数值字段写数字型 <v>，文本写 inlineStr；否则 Excel 里是文本、选型脚本读不到。
 *
 * 原表预留容量：物料 A×2、载具 B×1、组合 C×2、流程 D×2。
 * 超出部分与"选型补充/其他需求"一起，追加到 R84 起的【扩展区】。
 * ========================================================================== */
(function (g) {
  'use strict';

  var SHEET = 'xl/worksheets/sheet1.xml';

  /* ---------------- 字段 → 单元格映射（来自 refs/字段清单.csv，已核对） ---------------- */
  // 固定分组：{ 字段key: [行, 列] }
  var FIXED = {
    basic: {
      customer_name: [2, 4], project_name: [3, 4], site_address: [4, 4],
      contact: [5, 4], position: [6, 4], contact_info: [7, 4],
      kickoff: [8, 4], purchase_mode: [9, 4]
    },
    material_overview: { sku_count: [12, 6], material_desc: [13, 6], material_attr: [14, 6] },
    site: {
      temperature: [66, 6], building_height: [67, 6], slope: [68, 6],
      floor_condition: [69, 6], floor_capacity: [70, 6], glare: [71, 6], dust: [72, 6]
    },
    work: { existing_equipment: [73, 6], driver_count: [74, 6], work_time: [75, 6] },
    system: {
      erp: [76, 6], wms: [77, 6], site_devices: [78, 6],
      trigger_by_system: [79, 6], trigger_mode: [80, 6], trigger_place: [81, 6]
    }
  };
  // 工艺流程：C65:G65 合并，只能写左上角
  var PROCESS_CELL = [65, 3];

  // 重复区块：首行 + 步长 + 原表预留组数
  var REPEAT = {
    material: { base: 15, stride: 4, capacity: 2, label: '物料', prefix: 'A', cols: {
      pack_form: 0, pack_size: 1, material_weight: 2, info_record: 3 } },
    carrier: { base: 24, stride: 6, capacity: 1, label: '载具', prefix: 'B', cols: {
      carrier_for_material: 0, carrier_type: 1, fork_entry: 2,
      carrier_material: 3, carrier_weight: 4, carrier_info_record: 5 } },
    combo: { base: 31, stride: 12, capacity: 2, label: '组合', prefix: 'C', cols: {
      stack_mode: 0, load_weight: 1, pallet_length: 2, cargo_length: 3,
      dim_L1: 4, dim_L2: 5, fork_hole_width: 6, pallet_width: 7,
      cargo_width: 8, cargo_height: 9, pallet_height: 10, fork_hole_height: 11 } },
    flow: { base: 55, stride: 5, capacity: 2, label: '流程', prefix: 'D', cols: {
      route_start: 0, route_end: 1, cargo: 2, flow_rate: 4 } }
  };

  var EXTRA_LABELS = {
    aisle_width_mm: '选型补充 · 现场实际通道宽度',
    site_environment: '选型补充 · 运行环境'
  };

  /* ---------------- 值格式化 ---------------- */
  function isNum(x) { return x !== null && x !== undefined && x !== '' && !isNaN(Number(x)); }
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function codeOf(label) {
    var m = String(label || '').match(/^\S+/);
    return m ? m[0] : String(label || '');
  }

  /** 返回 {text, num}；num 非 null 时用数字型写入 */

  /** 三维尺寸（{L,W,H} 或 {text}）拼成导出字符串 */
  function joinDim(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number') return String(v);
    if (typeof v !== 'object') return String(v);
    if ('text' in v) return String(v.text == null ? '' : v.text).trim();
    if (typeof v.m === 'string') {
      if (v.m === 'range') return [v.a, v.b].filter(isNum).join(' ~ ');
      if (v.m === 'unknown') return '不确定';
      return isNum(v.v) ? String(v.v) : '';
    }
    return [v.L, v.W, v.H].filter(isNum).map(String).join('×');
  }

  function fmtAnswer(field, val) {
    // 兼容：字段从 number 改成 text 后，旧数据仍是 {m:'single', v:600}
    if (val && typeof val === 'object' && typeof val.m === 'string' &&
        !(field && (field.type === 'number' || field.type === 'place_layers'))) {
      val = (val.m === 'range') ? [val.a, val.b].filter(isNum).join(' ~ ') : val.v;
    }
    if (field && field.type === 'dim3') {
      var dj = joinDim(val);
      return dj ? { text: dj } : null;
    }
    if (val === null || val === undefined) return null;
    if (Array.isArray(val)) {
      var s = val.filter(Boolean).join('、');
      return s ? { text: s } : null;
    }
    if (typeof val === 'object') {
      // 数值四模式
      var u = field && field.unit ? '' : '';
      switch (val.m) {
        case 'single':
          if (!isNum(val.v)) return null;
          return (field && field.type === 'number') ? { num: Number(val.v) } : { text: String(val.v) };
        case 'range':
          if (isNum(val.a) && isNum(val.b)) return { text: val.a + ' ~ ' + val.b };
          if (isNum(val.a)) return { text: '≥ ' + val.a };
          if (isNum(val.b)) return { text: '≤ ' + val.b };
          return null;
        case 'ge':
          if (!isNum(val.v)) return null;
          return { text: '≥ ' + val.v };
        case 'le':
          if (!isNum(val.v)) return null;
          return { text: '≤ ' + val.v };
        case 'unknown':
          return { text: '不确定/待确认' };
        case 'place_layers':
          var a = val.place ? String(val.place) : '';
          var b = isNum(val.n) ? (val.n + ' 层') : '';
          var arr = [];
          if (a) arr.push(a);
          if (b) arr.push(b);
          return arr.length ? { text: arr.join(' · ') } : null;
        default:
          return null;
      }
    }
    var str = String(val).trim();
    if (!str) return null;
    if (field && field.type === 'number' && isNum(str)) return { num: Number(str) };
    return { text: str };
  }

  /* ---------------- XML 工具 ---------------- */
  function escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function colName(n) {
    var s = '';
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function colIndex(name) {
    var n = 0;
    for (var i = 0; i < name.length; i++) n = n * 26 + (name.charCodeAt(i) - 64);
    return n;
  }

  function cellXml(ref, payload, style) {
    var st = style ? ' s="' + style + '"' : '';
    if (payload.num !== undefined && payload.num !== null) {
      return '<c r="' + ref + '"' + st + '><v>' + payload.num + '</v></c>';
    }
    return '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' +
      escXml(payload.text) + '</t></is></c>';
  }

  /* 在已存在的行里设置单元格（保留原样式 s） */
  function setCellInExistingRow(xml, row, col, payload) {
    var ref = colName(col) + row;
    var one = new RegExp('<c r="' + ref + '"[^>]*?(?:/>|>[\\s\\S]*?</c>)');

    if (one.test(xml)) {
      var tagM = new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>)').exec(xml);
      var styleM = tagM && /\bs="(\d+)"/.exec(tagM[1]);
      return xml.replace(one, cellXml(ref, payload, styleM ? styleM[1] : null));
    }
    // 行内按列顺序插入
    var rowRe = new RegExp('<row[^>]*r="' + row + '"[^>]*>([\\s\\S]*?)</row>');
    var rm = rowRe.exec(xml);
    if (!rm) return xml;
    var inner = rm[1];
    var cellRe = /<c r="([A-Z]+)(\d+)"/g, mm, at = -1;
    while ((mm = cellRe.exec(inner)) !== null) {
      if (colIndex(mm[1]) > col) { at = mm.index; break; }
    }
    var nv = cellXml(ref, payload, null);
    var newInner = at >= 0 ? inner.slice(0, at) + nv + inner.slice(at) : inner + nv;
    return xml.replace(rm[0], rm[0].replace(inner, newInner));
  }

  /* 追加新行（必须保持 r 升序） */
  function appendRow(xml, row, cells) {
    var rowXml = '<row r="' + row + '">' + cells.join('') + '</row>';
    // 找第一个 r 更大的 row，插在它前面
    var re = /<row[^>]*r="(\d+)"[^>]*>/g, m;
    var insertBefore = -1;
    while ((m = re.exec(xml)) !== null) {
      if (parseInt(m[1], 10) > row) { insertBefore = m.index; break; }
    }
    if (insertBefore >= 0) return xml.slice(0, insertBefore) + rowXml + xml.slice(insertBefore);
    return xml.replace('</sheetData>', rowXml + '</sheetData>');
  }

  function bumpDimension(xml, maxRow) {
    return xml.replace(/<dimension ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/,
      function (_, c1, r1, c2, r2) {
        return '<dimension ref="' + c1 + r1 + ':' + c2 + Math.max(parseInt(r2, 10), maxRow) + '"/>';
      });
  }


  /* ============================================================================
   * 真插行：把超量区块插到「对应位置」，而不是堆到表格最后
   * ----------------------------------------------------------------------------
   * 做法：把原表最后那一组区块的 <row> 整行复制一份（样式、行高、合并单元格
   * 全部跟着走），插在该区块末尾，然后：
   *   · 所有行号 / 单元格行号 按累计偏移重编
   *   · 合并单元格：跨过插入点的范围自动延长；复制来的块内合并同步平移
   *   · 图片锚点（drawing1.xml 的 xdr:row）跟着平移
   *   · dimension 扩大
   * ========================================================================== */

  // 每种区块在原表里的最后一行的行号（插入点）
  var BLOCK_END = { material: 22, carrier: 29, combo: 54, flow: 64 };

  function planInserts(answers) {
    var plan = [];
    Object.keys(REPEAT).forEach(function (rid) {
      var def = REPEAT[rid];
      var n = Array.isArray(answers[rid]) ? answers[rid].length : 0;
      var extra = Math.max(0, n - def.capacity);
      if (!extra) return;
      var after = BLOCK_END[rid];
      plan.push({
        rid: rid,
        after: after,
        stride: def.stride,
        count: extra * def.stride,
        srcStart: after - def.stride + 1,
        srcEnd: after
      });
    });
    plan.sort(function (a, b) { return a.after - b.after; });
    return plan;
  }

  function shiftFactory(plan) {
    return function (row) {
      var d = 0;
      for (var i = 0; i < plan.length; i++) if (plan[i].after < row) d += plan[i].count;
      return row + d;
    };
  }

  function splitRows(xml) {
    var re = /<row[^>]*\br="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)/g, m, list = [];
    while ((m = re.exec(xml)) !== null) list.push({ num: parseInt(m[1], 10), xml: m[0] });
    return list;
  }

  function renumRow(rowXml, newNum) {
    var s1 = rowXml.replace(/^(<row\b[^>]*?\br=")\d+(")/, '$1' + newNum + '$2');
    return s1.replace(/(<c\b[^>]*?\br=")([A-Z]+)\d+(")/g, function (_, a, col, b) {
      return a + col + newNum + b;
    });
  }

  function expandSheet(xml, plan) {
    if (!plan.length) {
      var max0 = 0;
      (xml.match(/<row[^>]*\br="(\d+)"/g) || []).forEach(function (t) {
        var m = /r="(\d+)"/.exec(t); if (m) max0 = Math.max(max0, parseInt(m[1], 10));
      });
      return { xml: xml, shift: function (r) { return r; }, maxRow: max0 };
    }
    var shift = shiftFactory(plan);
    var rows = splitRows(xml);
    var byAfter = {};
    plan.forEach(function (p) { byAfter[p.after] = p; });

    var outRows = [], maxNew = 0;
    rows.forEach(function (r) {
      var n = shift(r.num);
      outRows.push(renumRow(r.xml, n));
      if (n > maxNew) maxNew = n;
      var p = byAfter[r.num];
      if (p) {
        // 可能一次要插多组（例如 2 个多余载具 = 12 行），必须按组循环克隆
        var reps = Math.max(1, Math.round(p.count / p.stride));
        var start = n + 1, k = 0;
        for (var rep = 0; rep < reps; rep++) {
          rows.forEach(function (sr) {
            if (sr.num >= p.srcStart && sr.num <= p.srcEnd) {
              outRows.push(renumRow(sr.xml, start + k));
              if (start + k > maxNew) maxNew = start + k;
              k++;
            }
          });
        }
      }
    });

    // 合并单元格：原始合并按 shift 平移/延长；复制块内的合并同步复制
    var mergeRe = /<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g, mm, merges = [];
    while ((mm = mergeRe.exec(xml)) !== null) {
      merges.push({ c1: mm[1], r1: +mm[2], c2: mm[3], r2: +mm[4] });
    }
    var next = merges.map(function (g) {
      return { c1: g.c1, r1: shift(g.r1), c2: g.c2, r2: shift(g.r2) };
    });
    plan.forEach(function (p) {
      var reps = Math.max(1, Math.round(p.count / p.stride));
      for (var rep = 0; rep < reps; rep++) {
        var base0 = shift(p.after) + 1 + rep * p.stride;
        merges.forEach(function (g) {
          if (g.r1 >= p.srcStart && g.r2 <= p.srcEnd) {
            next.push({
              c1: g.c1, r1: base0 + (g.r1 - p.srcStart),
              c2: g.c2, r2: base0 + (g.r2 - p.srcStart)
            });
          }
        });
      }
    });
    // 大区级合并（A/B 列的「1 负载信息」「2 物流信息」、G 列提示区）要跟着区块延长，
    // 否则新插入的 B3/C4 左侧没有竖线、也没有大类标签。
    var carrierEnd = shift(29) + (plan[0] && plan[0].rid === 'carrier' ? 0 : 0);
    // 各段真实结束行：已插行的段尾 = shift(段尾) + 该段插入量
    var CARRIER_END = shift(29) + (plan.filter(function (p) { return p.rid === 'carrier'; })[0] || { count: 0 }).count;
    var COMBO_END   = shift(54) + (plan.filter(function (p) { return p.rid === 'combo'; })[0] || { count: 0 }).count;
    var FLOW_END    = shift(64) + (plan.filter(function (p) { return p.rid === 'flow'; })[0] || { count: 0 }).count;
    var RECLOSE = {
      'A11:A42': COMBO_END, 'B11:B42': COMBO_END, 'G30:G42': COMBO_END,
      'A55:A64': FLOW_END,  'B55:B64': FLOW_END,  'G55:G64': FLOW_END,
      'G11:G29': CARRIER_END
    };
    next.forEach(function (g) {
      var key = g.c1 + g.r1 + ':' + g.c2 + g.r2;
      if (RECLOSE[key] && g.r2 < RECLOSE[key]) g.r2 = RECLOSE[key];
    });

    var seen = {}, finalM = [];
    next.forEach(function (g) {
      var k = g.c1 + g.r1 + ':' + g.c2 + g.r2;
      if (!seen[k]) { seen[k] = 1; finalM.push(g); }
    });
    finalM.sort(function (a, b) { return a.r1 - b.r1 || colIndex(a.c1) - colIndex(b.c1); });
    var mergeXml = '<mergeCells count="' + finalM.length + '">' +
      finalM.map(function (g) { return '<mergeCell ref="' + g.c1 + g.r1 + ':' + g.c2 + g.r2 + '"/>'; }).join('') +
      '</mergeCells>';

    var out = xml
      .replace(/<sheetData>[\s\S]*<\/sheetData>/, '<sheetData>' + outRows.join('') + '</sheetData>')
      .replace(/<mergeCells[\s\S]*?<\/mergeCells>/, mergeXml)
      .replace(/<dimension ref="([A-Z]+)(\d+):([A-Z]+)\d+"\/>/,
        '<dimension ref="$1$2:$3' + maxNew + '"/>');

    return { xml: out, shift: shift, maxRow: maxNew };
  }

  /**
   * 只保留「表1-项目基本情况」：删掉「现场勘查情况」「现场勘查图」两个分表，
   * 并让 Excel 打开时停在第一张表。
   * 做法：从 workbook.xml 移除 <sheet> 条目（其余部件保留但不被引用，Excel 会忽略），
   * 给 sheet1 的 sheetView 加 tabSelected，bookViews 的 activeTab 归零。
   */
  // 只删「现场勘查图」（照片已进附件）；「现场勘查情况」保留但会空着
  var DROP_SHEETS = ['现场勘查图'];

  function patchWorkbook(wbXml) {
    var out = wbXml.replace(/name="表1-项目基本情况"/g, 'name="项目基本情况"');
    DROP_SHEETS.forEach(function (name) {
      var re = new RegExp('<sheet\\b[^>]*name="' + name + '"[^>]*/>');
      out = out.replace(re, '');
    });
    out = out.replace(/<workbookView([^>]*?)\\bactiveTab="\\d+"/, '<workbookView$1activeTab="0"');
    if (out.indexOf('activeTab') < 0) {
      out = out.replace(/<workbookView/, '<workbookView activeTab="0"');
    }
    return out;
  }

  function markActiveTab(sheetXml) {
    if (/<sheetView[^>]*tabSelected/.test(sheetXml)) return sheetXml;
    return sheetXml.replace(/<sheetView\\b/, '<sheetView tabSelected="1"');
  }

  // 图片锚点用的是 0 基行号，转成 1 基再平移
  function shiftDrawing(drXml, shift) {
    return drXml.replace(/<xdr:row>(\d+)<\/xdr:row>/g, function (_, n) {
      return '<xdr:row>' + (shift(parseInt(n, 10) + 1) - 1) + '</xdr:row>';
    });
  }

  function blockLabel(rid, def, idx, item) {
    var n = idx + 1;
    if (rid === 'material') return '物料A' + n;
    if (rid === 'carrier') return '载具B' + n;
    if (rid === 'flow') return '流程D' + n;
    if (rid === 'combo') {
      var a = item.ref_material ? 'A' + item.ref_material : '';
      var b = item.ref_carrier ? 'B' + item.ref_carrier : '';
      var ref = a && b ? a + '+' + b : (a || b);
      return 'C' + n + (ref ? '(' + ref + ')' : '');
    }
    return def.label + n;
  }

  /* ---------------- 主流程 ---------------- */
  /**
   * @param {ArrayBuffer} templateBuf 空白调研表
   * @param {Object} project  { customer, name }
   * @param {Object} answers  { basic:{}, material:[], carrier:[], combo:[], flow:[], ... }
   * @param {Object} schema   window.AGV_SCHEMA（用于查 field 类型/单位）
   * @returns {Promise<Blob>}
   */
  async function generate(templateBuf, project, answers, schema) {
    var z = g.AGV_ZIP.readZip(templateBuf);
    var entry = z.find(SHEET);
    if (!entry) throw new Error('模板缺少 ' + SHEET);
    var xml = new TextDecoder('utf-8').decode(await z.inflate(entry));

    // 字段索引表（用于查 type/unit）
    var fieldDef = {};
    (schema ? schema.steps : []).forEach(function (st) {
      (st.groups || []).forEach(function (grp) {
        grp.fields.forEach(function (f) { fieldDef[grp.id + '.' + f.key] = f; });
      });
      if (st.repeat) {
        st.repeat.fields.forEach(function (f) { fieldDef[st.repeat.id + '.' + f.key] = f; });
      }
    });

    // ① 先把超量区块真正插进表格对应位置（复制上一块的行，样式/行高/合并都跟随）
    var plan = planInserts(answers);
    var ex = expandSheet(xml, plan);
    xml = ex.xml;
    var shift = ex.shift;

    var existingRows = {};
    (xml.match(/<row[^>]*r="(\d+)"/g) || []).forEach(function (t) {
      var m = /r="(\d+)"/.exec(t); if (m) existingRows[m[1]] = 1;
    });

    var maxRow = ex.maxRow || 83;

    function put(row, col, payload) {
      if (!payload) return;
      if (row > maxRow) maxRow = row;
      if (existingRows[row]) xml = setCellInExistingRow(xml, row, col, payload);
      else { xml = appendRow(xml, row, [cellXml(colName(col) + row, payload)]); existingRows[row] = 1; }
    }

    /* ① 固定分组 */
    Object.keys(FIXED).forEach(function (gid) {
      var store = answers[gid] || {};
      Object.keys(FIXED[gid]).forEach(function (key) {
        var cell = FIXED[gid][key];
        var p = fmtAnswer(fieldDef[gid + '.' + key], store[key]);
        if (p) put(shift(cell[0]), cell[1], p);
      });
    });

    /* ② 工艺流程（合并单元格，写左上角；追加在原提示之后，不覆盖） */
    var proc = (answers.process || {}).process_text;
    var procRow = shift(PROCESS_CELL[0]);
    var procText = [];
    if (proc && String(proc).trim()) procText.push(String(proc).trim());
    // 流程路线（含中间点）并入同一格，格式与工艺流程描述一致
    var flowArr = Array.isArray(answers.flow) ? answers.flow : [];
    flowArr.forEach(function (f, i) {
      if (!f) return;
      var parts = [];
      if (f.route_start) parts.push('起始点【' + codeOf(f.route_start) + '】');
      (Array.isArray(f.vias) ? f.vias : []).forEach(function (v, j) {
        if (v) parts.push('中间点' + (j + 1) + '【' + codeOf(v) + '】');
      });
      if (f.route_end) parts.push('终点【' + codeOf(f.route_end) + '】');
      if (parts.length) procText.push('流程D' + (i + 1) + '：' + parts.join(' → '));
    });
    if (procText.length) {
      maxRow = Math.max(maxRow, procRow);
      xml = appendIntoMergedCell(xml, procRow, PROCESS_CELL[1], procText.join('\n'));
    }

    /* ③ 重复区块：全部就地写入（超量部分已在①插好行） */
    Object.keys(REPEAT).forEach(function (rid) {
      var def = REPEAT[rid];
      var arr = Array.isArray(answers[rid]) ? answers[rid] : [];
      var blockBase = shift(def.base);
      arr.forEach(function (item, idx) {
        var base = blockBase + idx * def.stride;
        Object.keys(def.cols).forEach(function (key) {
          var p = fmtAnswer(fieldDef[rid + '.' + key], item[key]);
          if (p) put(base + def.cols[key], 6, p);
        });
        // 复制来的块带着上一组的标题，改成自己的
        if (idx >= def.capacity) put(base, 3, { text: blockLabel(rid, def, idx, item) });
      });
    });

    /* ④ 扩展区：超容量组合 + 选型补充 + 其他需求 */
    var ext = [];
    /* 超量表项已在①就地插入，这里只放原表没有的栏位 */
    var extraStore = answers.extra || {};
    Object.keys(EXTRA_LABELS).forEach(function (k) {
      var p = fmtAnswer(fieldDef['extra.' + k], extraStore[k]);
      if (p) ext.push({ label: EXTRA_LABELS[k], payload: p });
    });
    // 地点清单（原表无此栏，写进扩展区保留信息）
    var places = Array.isArray(answers.place) ? answers.place : [];
    var placeOk = places.filter(function (p) {
      return (p && (str(p.code) || str(p.name)));
    });
    // 地点清单不再单独列在表格末尾（流程里已体现起终点）
    // 堆叠层数（可能是多个地点）
    var stacking = Array.isArray(answers.stacking) ? answers.stacking : [];
    var stOk = stacking.filter(function (x) {
      return x && ((x.place && String(x.place).trim()) || isNum(x.layers));
    });
    if (stOk.length) {
      ext.push({ head: '【堆叠层数 / 货架层数】' });
      stOk.forEach(function (x) {
        var a = x.place ? String(x.place) : '';
        var pf = fmtAnswer(fieldDef['stacking.layers'], x.layers);
        var b = pf ? (pf.text || (isNum(pf.num) ? pf.num + ' 层' : '')) : '';
        if (b && isNum(pf && pf.num)) b = pf.num + ' 层';
        ext.push({ label: a || '(未选地点)', payload: { text: b } });
      });
    }
    // 流程路线（含中间点）——原表只有取货点/放货点两格
    var flows2 = Array.isArray(answers.flow) ? answers.flow : [];
    var routes = [];
    flows2.forEach(function (f, i) {
      if (!f) return;
      var parts = [];
      if (f.route_start) parts.push('起始点【' + codeOf(f.route_start) + '】');
      (Array.isArray(f.vias) ? f.vias : []).forEach(function (v, j) {
        if (v) parts.push('中间点' + (j + 1) + '【' + codeOf(v) + '】');
      });
      if (f.route_end) parts.push('终点【' + codeOf(f.route_end) + '】');
      if (parts.length) routes.push({ label: '流程 D' + (i + 1) + ' 路线', text: parts.join(' → ') });
    });
    // 流程路线已在「工艺流程」单元格里拼接，这里不再单列尾段
    var other = (answers.other || {}).other_requirements;
    if (other && String(other).trim()) {
      ext.push({ label: '其他需求（指定车型、特殊条件等）', payload: { text: String(other).trim() } });
    }

    var row = shift(84);
    ext.forEach(function (e) {
      var cells = [];
      if (e.head) {
        cells.push(cellXml('C' + row, { text: e.head }));
      } else {
        cells.push(cellXml('C' + row, { text: e.label }));
        cells.push(cellXml('F' + row, e.payload));
      }
      xml = appendRow(xml, row, cells);
      maxRow = row;
      row++;
    });

    if (maxRow > 83) xml = bumpDimension(xml, maxRow);

    var repl = {};
    repl[SHEET] = new TextEncoder().encode(markActiveTab(xml));
    var wbEntry = z.find('xl/workbook.xml');
    if (wbEntry) {
      var wbXml = new TextDecoder('utf-8').decode(await z.inflate(wbEntry));
      repl['xl/workbook.xml'] = new TextEncoder().encode(patchWorkbook(wbXml));
    }
    if (plan.length) {
      var dr = z.find('xl/drawings/drawing1.xml');
      if (dr) {
        var drXml = new TextDecoder('utf-8').decode(await z.inflate(dr));
        repl['xl/drawings/drawing1.xml'] = new TextEncoder().encode(shiftDrawing(drXml, shift));
      }
    }
    return g.AGV_ZIP.repackZip(templateBuf, repl);
  }

  function letter(i) {
    // 0→A1 的编号：A1、A2… 直接用数字更贴合原表（A1/A2）
    return (i + 1);
  }
  function labelOf(schema, rid, key) {
    var out = key;
    (schema ? schema.steps : []).forEach(function (st) {
      if (st.repeat && st.repeat.id === rid) {
        st.repeat.fields.forEach(function (f) { if (f.key === key) out = f.label; });
      }
    });
    return out;
  }
  /** 往合并单元格左上角追加文本（保留原提示） */
  function appendIntoMergedCell(xml, row, col, text) {
    var ref = colName(col) + row;
    var re = new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)');
    var m = re.exec(xml);
    if (!m) return setCellInExistingRow(xml, row, col, { text: text });

    var styleM = /\bs="(\d+)"/.exec(m[1]);
    // 取出已有纯文本（若原本是 inlineStr / v）
    var old = '';
    var t1 = /<t[^>]*>([\s\S]*?)<\/t>/.exec(m[2] || '');
    var v1 = /<v>([\s\S]*?)<\/v>/.exec(m[2] || '');
    if (t1) old = t1[1];

    var merged = (old ? unescapeEntities(old) + '\n\n【填写】\n' : '') + text;
    var payload = { text: merged };
    var style = styleM ? styleM[1] : null;
    return xml.replace(re, cellXml(ref, payload, style));
  }
  function unescapeEntities(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }

  /* 文件名 */
  function fileName(project) {
    var d = new Date();
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    var ymd = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
    var who = (project && (project.customer || project.name) || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 30);
    return '1.1 AGV项目需求调研表_' + who + '_' + ymd + '.xlsx';
  }

  g.AGV_XLSX = { generate: generate, fileName: fileName, FIXED: FIXED, REPEAT: REPEAT, EXTRA_LABELS: EXTRA_LABELS };
})(typeof window !== 'undefined' ? window : globalThis);
