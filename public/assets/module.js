/* =============================================================================
 * module.js —— 模块编辑页
 *   ?id=<projectId>&m=<stepId|media>
 * 特性：每次改动立即落盘（防丢）；重复组可增删；组合 C 用 S3 选物料/载具
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

  var TITLES = {
    media: { t: '附件', s: '现场照片、视频、图纸' }
  };

  /* ============================ 保存 ============================ */
  function touch() {
    state.dirty = true;
    setSave('保存中…', '');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(save, 450);
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

  /* ============================ 渲染 ============================ */
  function render() {
    var main = $('main');
    main.innerHTML = '';

    if (mid === 'media') return renderMedia();

    var st = state.step;
    $('ttl').textContent = st.no + '. ' + st.title;
    $('sub').textContent = st.sub || '';

    if (st.id === 'extra') {
      main.appendChild(notice('info',
        '以下三项原调研表没有，但直接影响车型能否选对。不确定可以选「不确定」。'));
    }
    if (st.id === 'other') {
      main.appendChild(notice('info', '客户特别指定的车型、特殊工况、品牌偏好等，都可以写在这里。'));
    }

    // 普通分组
    (st.groups || []).forEach(function (grp) {
      var card = document.createElement('div');
      card.className = 'card';
      if (grp.title) {
        var h = document.createElement('div');
        h.className = 'group-title';
        h.textContent = grp.title;
        card.appendChild(h);
      }
      if (grp.id === 'extra' && grp.title) {
        var t = document.createElement('div');
        t.className = 'tiny';
        t.style.marginBottom = '10px';
        t.textContent = grp.title;
        card.appendChild(t);
      }
      var store = groupStore(grp.id);
      grp.fields.forEach(function (f) {
        card.appendChild(C.renderField(f, store[f.key], function (v) {
          store[f.key] = v;
          touch();
        }));
      });
      main.appendChild(card);
    });

    // 重复区块
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
        add.onclick = function () {
          repeatStore(r.id, r.min).push({});
          touch(); redraw();
        };
        host.appendChild(add);
        var cnt = document.createElement('div');
        cnt.className = 'tiny';
        cnt.style.marginTop = '8px';
        cnt.textContent = '当前 ' + list.length + ' 组' +
          (r.id === 'material' ? '（物料 A1…）' : r.id === 'carrier' ? '（载具 B1…）' :
           r.id === 'combo' ? '（组合 C1…，每组自己选由哪个物料+载具构成）' : '（流程 D1…）');
        host.appendChild(cnt);
      }
      redraw();
      main.appendChild(host);
    }
  }

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
        list.splice(idx, 1);
        touch(); redraw();
      };
      head.appendChild(del);
    }
    box.appendChild(head);

    var body = document.createElement('div');
    body.className = 'rep-body';

    // S3：组合 C 选"由哪个物料 + 哪个载具"
    if (r.refs && r.refs.length) {
      var refRow = document.createElement('div');
      refRow.className = 'rep-refs';
      r.refs.forEach(function (rf) {
        var refList = repeatStore(rf.ref, 1);
        var opts = ['<option value="">请选择…</option>'];
        refList.forEach(function (x, i) {
          var extra = x.carrier_type || x.pack_form || '';
          opts.push('<option value="' + (i + 1) + '"' +
            (String(item[rf.key] || '') === String(i + 1) ? ' selected' : '') + '>' +
            esc(rf.prefix + (i + 1) + (extra ? '（' + extra + '）' : '')) + '</option>');
        });
        var w = document.createElement('div');
        w.className = 'field';
        w.style.marginBottom = '0';
        w.innerHTML = '<label class="flabel">' + esc(rf.label) + '</label>';
        var sel = document.createElement('select');
        sel.innerHTML = opts.join('');
        sel.addEventListener('change', function () {
          item[rf.key] = sel.value ? Number(sel.value) : null;
          touch();
        });
        w.appendChild(sel);
        refRow.appendChild(w);
      });
      body.appendChild(refRow);
    }

    r.fields.forEach(function (f) {
      body.appendChild(C.renderField(f, item[f.key], function (v) {
        item[f.key] = v;
        touch();
      }));
    });

    box.appendChild(body);
    return box;
  }

  /* ============================ 附件模块 ============================ */
  function renderMedia() {
    $('ttl').textContent = '附件';
    $('sub').textContent = '照片 / 视频 / 图纸，导出时一并打包';
    var main = $('main');
    main.innerHTML = '';

    S.uploadZones.forEach(function (z) {
      main.appendChild(mediaZone(z));
    });

    // 录视频
    var rec = document.createElement('div');
    rec.className = 'card';
    rec.innerHTML = '<div class="group-title">现场视频</div>';
    var row = document.createElement('div');
    row.className = 'row-flex';
    var b1 = document.createElement('button');
    b1.className = 'btn primary';
    b1.textContent = '🎥 录制视频';
    b1.onclick = startRec;
    row.appendChild(b1);
    if (!M.supportsRecording()) {
      var tip = document.createElement('span');
      tip.className = 'tiny';
      tip.textContent = '当前浏览器不支持录制，可用下面的「选择视频文件」';
      row.appendChild(tip);
    }
    rec.appendChild(row);
    var drop2 = filePicker('选择视频文件（相册/文件）', 'video/*', 'videos');
    rec.appendChild(drop2);
    rec.appendChild(mediaList('videos'));
    main.appendChild(rec);
  }

  function mediaZone(z) {
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div class="group-title">' + esc(z.title) + '</div>' +
      '<div class="tiny" style="margin-bottom:9px">' + esc(z.desc) + '　·　最多 ' + z.max + ' 个</div>';
    card.appendChild(filePicker('点击选择 / 拍照', z.accept, z.id, z.max));
    card.appendChild(mediaList(z.id));
    return card;
  }

  function filePicker(label, accept, zone, max) {
    var drop = document.createElement('div');
    drop.className = 'drop';
    drop.innerHTML = '<div class="big">' + esc(label) + '</div>' +
      '<div class="small">图片会自动压缩，单张约 200~500KB</div>';
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
          var warn = M.checkVideo(f);
          if (warn && !confirm(warn + '\n\n仍要添加吗？')) continue;
          await DB.addMedia({
            projectId: pid, zone: zone, kind: 'video', name: f.name,
            mime: f.type || 'video/mp4', size: f.size, blob: f
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
      } else if (m.kind === 'video') {
        var v = document.createElement('div');
        v.className = 'ext';
        v.textContent = '▶ 视频';
        el.appendChild(v);
        var p = document.createElement('div');
        p.className = 'play';
        p.textContent = '▶';
        el.appendChild(p);
      } else {
        var d = document.createElement('div');
        d.className = 'ext';
        d.textContent = (m.name.split('.').pop() || 'FILE').toUpperCase();
        el.appendChild(d);
      }
      var tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = (m.note ? m.note : m.name) + ' · ' + U.fileSize(m.size);
      el.appendChild(tag);

      var x = document.createElement('button');
      x.className = 'x'; x.textContent = '×';
      x.onclick = async function (ev) {
        ev.stopPropagation();
        if (!confirm('删除这个附件？')) return;
        await DB.deleteMedia(m.id);
        await reloadMedia(); renderMedia();
      };
      el.appendChild(x);

      el.onclick = async function () {
        var note = prompt('给这个附件加个说明（如"1F 地面接缝"）', m.note || '');
        if (note === null) return;
        m.note = note.trim();
        await DB.addMedia(m);
        await reloadMedia(); renderMedia();
      };
      wrap.appendChild(el);
    });
    return wrap;
  }

  /* ============================ 录制 ============================ */
  var recTimer = null;
  async function startRec() {
    try {
      await M.startRecording({ audio: true });
    } catch (e) {
      alert('无法启动摄像头/麦克风：' + (e.message || e) + '\n\n请确认已授权，且页面在 https 下打开。');
      return;
    }
    $('recMask').classList.remove('hidden');
    recTimer = setInterval(function () {
      var s = M.elapsed();
      $('recTime').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 300);
  }
  async function stopRec(save) {
    clearInterval(recTimer);
    $('recMask').classList.add('hidden');
    if (!save) {
      try { var r = await M.stopRecording(); } catch (e) { }
      return;
    }
    try {
      var v = await M.stopRecording();
      await DB.addMedia({
        projectId: pid, zone: 'videos', kind: 'video', name: v.name,
        mime: v.mime, size: v.size, blob: v.blob, duration: v.duration
      });
      await reloadMedia(); renderMedia();
    } catch (e) {
      alert('保存视频失败：' + e.message);
    }
  }
  $('btn-rec-stop').onclick = function () { stopRec(true); };
  $('btn-rec-cancel').onclick = function () { stopRec(false); };

  /* ============================ 启动 ============================ */
  async function reloadMedia() {
    state.media = await DB.listMedia(pid);
  }

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
