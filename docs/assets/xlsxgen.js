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
      pick_point: 0, drop_point: 1, flow_material: 2, flow_carrier: 3, flow_rate: 4 } }
  };

  var EXTRA_LABELS = {
    aisle_width_mm: '选型补充 · 现场实际通道宽度最小值',
    site_environment: '选型补充 · 运行环境',
    stacking_layers: '选型补充 · 堆叠层数/货架层数'
  };

  /* ---------------- 值格式化 ---------------- */
  function isNum(x) { return x !== null && x !== undefined && x !== '' && !isNaN(Number(x)); }

  /** 返回 {text, num}；num 非 null 时用数字型写入 */
  function fmtAnswer(field, val) {
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
        case 'unknown':
          return { text: '不确定/待确认' };
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

    var existingRows = {};
    (xml.match(/<row[^>]*r="(\d+)"/g) || []).forEach(function (t) {
      var m = /r="(\d+)"/.exec(t); if (m) existingRows[m[1]] = 1;
    });

    var overflow = [];          // 超出原表容量的内容 → 扩展区
    var maxRow = 83;

    function put(row, col, payload) {
      if (!payload) return;
      if (existingRows[row]) xml = setCellInExistingRow(xml, row, col, payload);
      else xml = appendRow(xml, row, [cellXml(colName(col) + row, payload)]);
    }

    /* ① 固定分组 */
    Object.keys(FIXED).forEach(function (gid) {
      var store = answers[gid] || {};
      Object.keys(FIXED[gid]).forEach(function (key) {
        var cell = FIXED[gid][key];
        var p = fmtAnswer(fieldDef[gid + '.' + key], store[key]);
        if (p) put(cell[0], cell[1], p);
      });
    });

    /* ② 工艺流程（合并单元格，写左上角；追加在原提示之后，不覆盖） */
    var proc = (answers.process || {}).process_text;
    if (proc && String(proc).trim()) {
      maxRow = Math.max(maxRow, PROCESS_CELL[0]);
      xml = appendIntoMergedCell(xml, PROCESS_CELL[0], PROCESS_CELL[1], String(proc).trim());
    }

    /* ③ 重复区块：前 N 组进原表预留位，其余进扩展区 */
    Object.keys(REPEAT).forEach(function (rid) {
      var def = REPEAT[rid];
      var arr = Array.isArray(answers[rid]) ? answers[rid] : [];
      arr.forEach(function (item, idx) {
        if (idx < def.capacity) {
          var base = def.base + idx * def.stride;
          Object.keys(def.cols).forEach(function (key) {
            var p = fmtAnswer(fieldDef[rid + '.' + key], item[key]);
            if (p) put(base + def.cols[key], 6, p);
          });
        } else {
          overflow.push({ rid: rid, label: def.label, idx: idx, item: item, def: def });
        }
      });
    });

    /* ④ 扩展区：超容量组合 + 选型补充 + 其他需求 */
    var ext = [];
    if (overflow.length) {
      ext.push({ head: '【扩展区】以下内容超出原表预留位置（原表仅预留 A1/A2、B1、C1/C2、D1/D2）' });
      overflow.forEach(function (o) {
        ext.push({ head: o.label + ' ' + o.def.prefix + (o.idx + 1) + '（第 ' + (o.idx + 1) + ' 组）' });
        Object.keys(o.def.cols).forEach(function (key) {
          var p = fmtAnswer(fieldDef[o.rid + '.' + key], o.item[key]);
          if (p) ext.push({ label: o.label + ' ' + o.def.prefix + (o.idx + 1) + ' · ' + labelOf(schema, o.rid, key), payload: p });
        });
      });
    }
    var extraStore = answers.extra || {};
    Object.keys(EXTRA_LABELS).forEach(function (k) {
      var p = fmtAnswer(fieldDef['extra.' + k], extraStore[k]);
      if (p) ext.push({ label: EXTRA_LABELS[k], payload: p });
    });
    var other = (answers.other || {}).other_requirements;
    if (other && String(other).trim()) {
      ext.push({ label: '其他需求（指定车型、特殊条件等）', payload: { text: String(other).trim() } });
    }

    var row = 84;
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

    var out = g.AGV_ZIP.repackZip(templateBuf, (function () {
      var m = {}; m[SHEET] = new TextEncoder().encode(xml); return m;
    })());
    return out;
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
