/* =============================================================================
 * module.js —— 模块编辑页
 *   ?id=<projectId>&m=<stepId|media>
 * 特性：改动立即落盘；重复组可增删；地点清单供流程下拉；组合 C 有参考图
 * ========================================================================== */
(function () {
  'use strict';
  var DB = window.AGV_DB, U = window.AGV_UTIL, S = window.AGV_SCHEMA;
  var C = window.AGV_CTRL, M = window.AGV_MEDIA, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };

  var qs = new URLSearchParams(location.search);
  var pid = qs.get('id');
  var mid = qs.get('m') || 'basic';

  var state = { project: null, media: [], step: null, saveTimer: null, dirty: false };

  /* ============================ 保存 ============================ */
  function touch() {
    state.dirty = true;
    setSave('保存中…', '');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(save, 400);
  }
  async function save() {
    if (!state.dirty) return;
    state.dirty = false;
    try {
      await DB.putProject(state.project);
      setSave('已保存 ' + new Date().toTimeString().slice(0, 5), 'ok');
    } catch (e) {
      setSave('保存失败：' + e.message, 'warn');
    }
  }
  function setSave(t, cls) {
    var el = $('save-state');
    if (!el) return;
    el.textContent = t;
    el.className = 'save-state ' + (cls || '');
  }

  /* ============================ 取值 ============================ */
  function groupStore(gid) {
    var ans = state.project.answers;
    if (!ans[gid] || typeof ans[gid] !== 'object' || Array.isArray(ans[gid])) ans[gid] = {};
    return ans[gid];
  }
  function repeatStore(rid, min) {
    var ans = state.project.answers;
    if (!Array.isArray(ans[rid])) ans[rid] = [];
    while (ans[rid].length < (min || 1)) ans[rid].push({});
    return ans[rid];
  }

  /* 地点：'{code} {name}' 统一成显示串 */
  function placeLabel(p) {
    var c = (p && p.code ? String(p.code) : '').trim();
    var n = (p && p.name ? String(p.name) : '').trim();
    if (c && n) return c + ' ' + n;
    return c || n || '';
  }
  function placeList() {
    return repeatStore('place', 0).filter(function (p) { return placeLabel(p); });
  }
  function placeOptions() {
    return placeList().map(function (p) {
      var v = placeLabel(p);
      return { value: v, label: v };
    });
  }
  function codeOf(label) {
    var s = String(label || '');
    var m = s.match(/^\S+/);
    return m ? m[0] : s;
  }

  /* 引用型下拉的数据源 */
  function refOptions(refId) {
    if (refId === 'material') {
      return repeatStore('material', 1).map(function (x, i) {
        return { value: 'A' + (i + 1), label: 'A' + (i + 1) + (x.pack_form ? '（' + x.pack_form + '）' : '') };
      });
    }
    if (refId === 'carrier') {
      return repeatStore('carrier', 1).map(function (x, i) {
        return { value: 'B' + (i + 1), label: 'B' + (i + 1) + (x.carrier_type ? '（' + x.carrier_type + '）' : '') };
      });
    }
    if (refId === 'place') return placeOptions();
    return [];
  }

  /* 货物类型：A / B / C 全部已填项 */
  function abcOptions() {
    var out = [];
    repeatStore('material', 1).forEach(function (x, i) {
      out.push('A' + (i + 1) + (x.pack_form ? '（' + x.pack_form + '）' : ''));
    });
    repeatStore('carrier', 1).forEach(function (x, i) {
      out.push('B' + (i + 1) + (x.carrier_type ? '（' + x.carrier_type + '）' : ''));
    });
    repeatStore('combo', 1).forEach(function (x, i) {
      out.push('C' + (i + 1) + (x.stack_mode ? '（' + x.stack_mode + '）' : ''));
    });
    return out;
  }

  function resolveField(f) {
    if (f.optionsFrom === 'abc') {
      var o = Object.assign({}, f);
      o.options = abcOptions();
      delete o.optionsFrom;
      return o;
    }
    return f;
  }

  var CTX = { refOptions: refOptions, placeOptions: placeOptions };

  /* ============================ 渲染 ============================ */
  function render() {
    var main = $('main');
    main.innerHTML = '';
    if (mid === 'media') return renderMedia();

    var st = state.step;
    $('ttl').textContent = st.no + '. ' + st.title;
    $('sub').textContent = st.sub || '';
    renderRefBtn(st);

    if (st.id === 'extra') {
      main.appendChild(notice('info',
        '以下三项原调研表没有，但直接影响车型能否选对。不确定可以选「不确定」。'));
    }
    if (st.id === 'other') {
      main.appendChild(notice('info', '客户特别指定的车型、特殊工况、品牌偏好等，都可以写在这里。'));
    }
    if (st.id === 'flow') {
      main.appendChild(notice('info',
        '先在最上面登记「地点」（代号 + 名称，如 D1 入库缓存区），下面的流程就能直接下拉选起终点；最多可加 3 个途经点。'));
    }

    var flowRedraw = null;
    var placeTimer = null;
    if (st.preRepeat) {
      main.appendChild(preRepeatBlock(st.preRepeat, function () {
        // 地点变了 → 防抖刷新下面的流程下拉（只重绘流程区，地点输入框不失焦）
        clearTimeout(placeTimer);
        placeTimer = setTimeout(function () { if (flowRedraw) flowRedraw(); }, 500);
      }));
    }

    (st.groups || []).forEach(function (grp) {
      var card = document.createElement('div');
      card.className = 'card';
      if (grp.title) {
        var h = document.createElement('div');
        h.className = 'group-title';
        h.textContent = grp.title;
        card.appendChild(h);
      }
      if (st.id === 'extra') {
        var t = document.createElement('div');
        t.className = 'tiny';
        t.style.marginBottom = '10px';
        t.textContent = grp.title;
        card.appendChild(t);
      }
      var store = groupStore(grp.id);
      grp.fields.forEach(function (f) {
        card.appendChild(C.renderField(resolveField(f), store[f.key], function (v) {
          store[f.key] = v;
          touch();
        }, CTX));
      });
      main.appendChild(card);
    });

    if (st.repeat) {
      var r = st.repeat;
      var host = document.createElement('div');
      function redraw() {
        host.innerHTML = '';
        var list = repeatStore(r.id, r.min);
        list.forEach(function (item, idx) { host.appendChild(repeatCard(r, item, idx, list, redraw)); });
        var add = document.createElement('button');
        add.className = 'add-rep';
        add.type = 'button';
        add.textContent = '＋ 添加' + r.label + ' ' + r.prefix + (list.length + 1);
        add.onclick = function () { repeatStore(r.id, r.min).push({}); touch(); redraw(); };
        host.appendChild(add);
        var cnt = document.createElement('div');
        cnt.className = 'tiny';
        cnt.style.marginTop = '8px';
        cnt.textContent = '当前 ' + list.length + ' 组' +
          (r.id === 'combo' ? '（组合 C1…，每组自己选由哪个物料+载具构成）' : '');
        host.appendChild(cnt);
      }
      redraw();
      main.appendChild(host);
      flowRedraw = redraw;
    }
  }

  /* ---------------- 参考图按钮 ---------------- */
  function renderRefBtn(st) {
    var acts = document.querySelector('.appbar .acts');
    if (!acts) return;
    var old = document.getElementById('btn-ref');
    if (old) old.remove();
    if (!st || !st.refImage) return;
    var b = document.createElement('button');
    b.id = 'btn-ref';
    b.className = 'btn small';
    b.textContent = st.refImage.btn || '参考图';
    b.onclick = function () {
      var img = document.createElement('img');
      img.src = st.refImage.src;
      img.alt = '参考图';
      openOverlay(st.refImage.title || '参考图', img, false);
    };
    acts.appendChild(b);
  }

  /* ---------------- 前置列表（地点） ---------------- */
  function preRepeatBlock(r, onPlaceChange) {
    var card = document.createElement('div');
    card.className = 'card';
    var h = document.createElement('div');
    h.className = 'group-title';
    h.textContent = '地点清单';
    card.appendChild(h);
    if (r.note) {
      var n = document.createElement('div');
      n.className = 'tiny';
      n.style.marginBottom = '10px';
      n.textContent = r.note;
      card.appendChild(n);
    }

    var host = document.createElement('div');
    function redraw() {
      host.innerHTML = '';
      var list = repeatStore(r.id, r.min);
      list.forEach(function (item, idx) {
        var box = document.createElement('div');
        box.className = 'rep';
        var head = document.createElement('div');
        head.className = 'rep-head';
        head.innerHTML = '<div class="rep-title"><span class="rep-badge">' + (idx + 1) + '</span>' +
          esc(r.label) + '</div>';
        if (list.length > (r.min || 1)) {
          var del = document.createElement('button');
          del.className = 'rep-del';
          del.type = 'button';
          del.textContent = '删除';
          del.onclick = function () {
            if (!confirm('删除这个地点？引用它的流程会显示「已不存在」。')) return;
            list.splice(idx, 1); touch(); redraw();
            if (onPlaceChange) onPlaceChange();
          };
          head.appendChild(del);
        }
        box.appendChild(head);
        var body = document.createElement('div');
        body.className = 'rep-body';
        var row = document.createElement('div');
        row.className = 'pl2';
        r.fields.forEach(function (f) {
          row.appendChild(C.renderField(f, item[f.key], function (v) {
            item[f.key] = v; touch();
            if (onPlaceChange) onPlaceChange();
          }, CTX));
        });
        body.appendChild(row);
        box.appendChild(body);
        host.appendChild(box);
      });
      var add = document.createElement('button');
      add.className = 'add-rep';
      add.type = 'button';
      add.textContent = '＋ 添加地点';
      add.onclick = function () { repeatStore(r.id, r.min).push({}); touch(); redraw(); };
      host.appendChild(add);
    }
    redraw();
    card.appendChild(host);
    return card;
  }

  /* ---------------- 主重复组卡片 ---------------- */
  function repeatCard(r, item, idx, list, redraw) {
    var box = document.createElement('div');
    box.className = 'rep';

    var head = document.createElement('div');
    head.className = 'rep-head';
    head.innerHTML = '<div class="rep-title"><span class="rep-badge">' +
      esc(r.prefix + (idx + 1)) + '</span>' + esc(r.label) + '</div>';
    if (list.length > (r.min || 1)) {
      var del = document.createElement('button');
      del.className = 'rep-del';
      del.type = 'button';
      del.textContent = '删除';
      del.onclick = function () {
        if (!confirm('删除 ' + r.prefix + (idx + 1) + ' 及其内容？')) return;
        list.splice(idx, 1); touch(); redraw();
      };
      head.appendChild(del);
    }
    box.appendChild(head);

    var body = document.createElement('div');
    body.className = 'rep-body';

    if (r.refs && r.refs.length) {
      var refRow = document.createElement('div');
      refRow.className = 'rep-refs';
      r.refs.forEach(function (rf) {
        var refList = repeatStore(rf.ref, 1);
        var sel = document.createElement('select');
        var opts = ['<option value="">请选择…</option>'];
        refList.forEach(function (x, i) {
          var extra = x.carrier_type || x.pack_form || '';
          opts.push('<option value="' + (i + 1) + '"' +
            (String(item[rf.key] || '') === String(i + 1) ? ' selected' : '') + '>' +
            esc(rf.prefix + (i + 1) + (extra ? '（' + extra + '）' : '')) + '</option>');
        });
        sel.innerHTML = opts.join('');
        sel.addEventListener('change', function () {
          item[rf.key] = sel.value ? Number(sel.value) : null;
          touch();
        });
        var w = document.createElement('div');
        w.className = 'field';
        w.style.marginBottom = '0';
        w.innerHTML = '<label class="flabel">' + esc(rf.label) + '</label>';
        w.appendChild(sel);
        refRow.appendChild(w);
      });
      body.appendChild(refRow);
    }

    var routeLine = null;
    if (r.id === 'flow') {
      routeLine = document.createElement('div');
      routeLine.className = 'route-line';
      routeLine.textContent = routeText(item);
    }

    r.fields.forEach(function (f) {
      body.appendChild(C.renderField(resolveField(f), item[f.key], function (v) {
        item[f.key] = v;
        touch();
        if (routeLine && (f.key === 'route_start' || f.key === 'route_end' || /^via/.test(f.key))) {
          routeLine.textContent = routeText(item);
        }
      }, CTX));
    });

    if (routeLine) {
      body.appendChild(routeLine);
      var tip = document.createElement('div');
      tip.className = 'tiny';
      tip.style.marginTop = '6px';
      tip.textContent = '路线会自动显示在表格的「取货点/放货点」里（含途经点）';
      body.appendChild(tip);
    }

    box.appendChild(body);
    return box;
  }

  function routeText(item) {
    var parts = [];
    if (item.route_start) parts.push('起始点【' + codeOf(item.route_start) + '】');
    ['via1', 'via2', 'via3'].forEach(function (k, i) {
      if (item[k]) parts.push('中间点' + (i + 1) + '【' + codeOf(item[k]) + '】');
    });
    if (item.route_end) parts.push('终点【' + codeOf(item.route_end) + '】');
    return parts.length ? parts.join(' → ') : '选择起终点后，这里会显示路线';
  }

  /* ============================ 附件模块 ============================ */
  function renderMedia() {
    $('ttl').textContent = '附件';
    $('sub').textContent = '照片 / 图纸，导出时一并打包';
    renderRefBtn({});
    var main = $('main');
    main.innerHTML = '';
    main.appendChild(notice('info', '点缩略图可放大查看，并可修改备注或删除。'));
    S.uploadZones.forEach(function (z) { main.appendChild(mediaZone(z)); });
  }

  function mediaZone(z) {
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div class="group-title">' + esc(z.title) + '</div>' +
      '<div class="tiny" style="margin-bottom:9px">' + esc(z.desc) + '　·　最多 ' + z.max + ' 个</div>';
    card.appendChild(filePicker('点击上传', z.accept, z.id, z.max));
    card.appendChild(mediaList(z.id));
    return card;
  }

  function filePicker(label, accept, zone, max) {
    var drop = document.createElement('div');
    drop.className = 'drop';
    drop.innerHTML = '<div class="big">' + esc(label) + '</div>';
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.style.display = 'none';
    drop.onclick = function () { input.click(); };
    input.onchange = async function () {
      var files = Array.from(input.files || []);
      input.value = '';
      await handleFiles(zone, files, max);
    };
    var wrap = document.createElement('div');
    wrap.appendChild(drop);
    wrap.appendChild(input);
    return wrap;
  }

  async function handleFiles(zone, files, max) {
    if (!files.length) return;
    var cur = state.media.filter(function (m) { return m.zone === zone; }).length;
    var added = 0;
    for (var i = 0; i < files.length; i++) {
      if (max && cur + added >= max) { alert('该分类最多 ' + max + ' 个'); break; }
      var f = files[i];
      try {
        if (f.type.indexOf('image/') === 0) {
          var c = await M.compressImage(f);
          await DB.addMedia({
            projectId: pid, zone: zone, kind: 'image', name: c.name, mime: c.mime,
            size: c.size, blob: c.blob, thumb: c.thumb, w: c.w, h: c.h
          });
        } else {
          await DB.addMedia({
            projectId: pid, zone: zone, kind: 'file', name: f.name,
            mime: f.type || 'application/octet-stream', size: f.size, blob: f
          });
        }
        added++;
      } catch (e) {
        alert('添加失败（' + f.name + '）：' + e.message);
      }
    }
    if (added) { await reloadMedia(); renderMedia(); }
  }

  function mediaList(zone) {
    var wrap = document.createElement('div');
    wrap.className = 'att-grid';
    var items = state.media.filter(function (m) { return m.zone === zone; });
    if (!items.length) {
      var e = document.createElement('div');
      e.className = 'tiny';
      e.style.gridColumn = '1/-1';
      e.textContent = '还没有内容';
      wrap.appendChild(e);
      return wrap;
    }
    items.forEach(function (m) {
      var el = document.createElement('div');
      el.className = 'att';
      if (m.thumb) {
        var img = document.createElement('img');
        img.src = URL.createObjectURL(m.thumb);
        el.appendChild(img);
      } else {
        var d = document.createElement('div');
        d.className = 'ext';
        d.textContent = (m.name.split('.').pop() || 'FILE').toUpperCase();
        el.appendChild(d);
      }
      var tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = m.note ? m.note : m.name;
      el.appendChild(tag);
      el.onclick = function () { openPreview(m); };
      wrap.appendChild(el);
    });
    return wrap;
  }

  /* ---------------- 附件预览浮层 ---------------- */
  function openPreview(m) {
    var body = document.createElement('div');
    body.className = 'ov-body';
    var url = URL.createObjectURL(m.blob);
    if ((m.mime || '').indexOf('image/') === 0) {
      var img = document.createElement('img');
      img.src = url;
      img.alt = m.name;
      body.appendChild(img);
    } else {
      var f = document.createElement('div');
      f.className = 'ov-file';
      f.innerHTML = '<div class="big">' + esc(m.name) + '</div>' +
        '<div class="tiny">' + U.fileSize(m.size) + '　·　此格式无法在页面内预览</div>';
      var a = document.createElement('a');
      a.className = 'btn';
      a.href = url;
      a.download = m.name;
      a.textContent = '下载 / 打开文件';
      f.appendChild(a);
      body.appendChild(f);
    }
    var meta = document.createElement('div');
    meta.className = 'ov-meta';
    meta.textContent = m.name + '　·　' + U.fileSize(m.size) + (m.note ? '　·　备注：' + m.note : '');
    body.appendChild(meta);

    openOverlay('查看附件', body, true, [
      { text: '修改备注', primary: true, fn: async function () {
          var v = prompt('给这个附件加个说明（如"1F 地面接缝"）', m.note || '');
          if (v === null) return;
          m.note = v.trim();
          await DB.addMedia(m);
          await reloadMedia(); renderMedia(); closeOverlay();
        } },
      { text: '删除', danger: true, fn: async function () {
          if (!confirm('删除这个附件？')) return;
          await DB.deleteMedia(m.id);
          await reloadMedia(); renderMedia(); closeOverlay();
        } }
    ], function () { URL.revokeObjectURL(url); });
  }

  /* ---------------- 通用浮层 ---------------- */
  var overlayCloser = null;
  function openOverlay(title, contentEl, showFooter, buttons, onClose) {
    closeOverlay();
    var mask = document.createElement('div');
    mask.className = 'ov-mask';
    mask.id = 'overlay';

    var box = document.createElement('div');
    box.className = 'ov-box';

    var head = document.createElement('div');
    head.className = 'ov-head';
    var t = document.createElement('span');
    t.textContent = title;
    head.appendChild(t);
    var x = document.createElement('button');
    x.className = 'ov-x';
    x.textContent = '×';
    x.onclick = function () { closeOverlay(); };
    head.appendChild(x);
    box.appendChild(head);

    var bodyWrap = document.createElement('div');
    bodyWrap.className = 'ov-scroll';
    bodyWrap.appendChild(contentEl);
    box.appendChild(bodyWrap);

    if (showFooter && buttons && buttons.length) {
      var foot = document.createElement('div');
      foot.className = 'ov-foot';
      buttons.forEach(function (b) {
        var btn = document.createElement('button');
        btn.className = 'btn' + (b.primary ? ' primary' : '') + ' flex';
        if (b.danger) btn.style.color = 'var(--bad)';
        btn.textContent = b.text;
        btn.onclick = function () { b.fn(); };
        foot.appendChild(btn);
      });
      box.appendChild(foot);
    }

    mask.appendChild(box);
    mask.onclick = function (e) { if (e.target === mask) closeOverlay(); };
    document.body.appendChild(mask);
    overlayCloser = function () { if (onClose) onClose(); mask.remove(); overlayCloser = null; };
  }
  function closeOverlay() { if (overlayCloser) overlayCloser(); }

  /* ============================ 启动 ============================ */
  async function reloadMedia() { state.media = await DB.listMedia(pid); }

  function notice(kind, html) {
    var d = document.createElement('div');
    d.className = 'notice ' + kind;
    d.innerHTML = html;
    return d;
  }

  $('btn-back').onclick = async function () {
    await save();
    location.href = 'project.html?id=' + encodeURIComponent(pid);
  };
  $('btn-done').onclick = async function () {
    await save();
    location.href = 'project.html?id=' + encodeURIComponent(pid);
  };

  (async function boot() {
    if (!pid) { $('main').innerHTML = '<div class="notice bad">缺少方案 ID</div>'; return; }
    try {
      state.project = await DB.getProject(pid);
      if (!state.project) { $('main').innerHTML = '<div class="notice bad">方案不存在</div>'; return; }
      state.step = S.steps.filter(function (x) { return x.id === mid; })[0] || null;
      if (mid !== 'media' && !state.step) {
        $('main').innerHTML = '<div class="notice bad">未知模块：' + esc(mid) + '</div>';
        return;
      }
      setSave('已保存', 'ok');
      if (mid === 'media') await reloadMedia();
      render();
    } catch (e) {
      $('main').innerHTML = '<div class="notice bad">加载失败：' + esc(e.message) + '</div>';
    }
  })();

  window.addEventListener('pagehide', function () { if (state.dirty) save(); });
  window.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && state.dirty) save();
  });
})();
