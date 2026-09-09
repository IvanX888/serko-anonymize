/* ============================================================
 * SERKO Anonymize Pro v9 — UI
 * ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* ============ ТЕМА ============ */
  var themeBtns = document.querySelectorAll('.theme-btn');
  function applyTheme(t) {
    var eff = t;
    if (t === 'system') eff = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', eff);
    themeBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.theme === t); });
    try { localStorage.setItem('serko-theme', t); } catch (e) {}
  }
  themeBtns.forEach(function (b) { b.addEventListener('click', function () { applyTheme(b.dataset.theme); }); });
  var savedTheme = 'system';
  try { savedTheme = localStorage.getItem('serko-theme') || 'system'; } catch (e) {}
  applyTheme(savedTheme);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    var t; try { t = localStorage.getItem('serko-theme') || 'system'; } catch (e) { t = 'system'; }
    if (t === 'system') applyTheme('system');
  });

  $('year').textContent = new Date().getFullYear();

  /* ============ ТОСТ ============ */
  var toastEl = null;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }

  /* ============ СОСТОЯНИЕ ============ */
  var state = {
    mode: 'mask',
    source: '',
    matches: [],        // после resolveOverlaps
    persons: [],
    map: null,
    result: '',
    edits: [],          // стек правок: {kind:'off'|'on'|'add', match|span}
    customSpans: [],    // пользовательские спаны
    clickMode: 'hide'
  };

  var MODE_HINTS = {
    mask: 'Заменяет данные на плейсхолдеры [ФИО-1], [ИНН] и т.д.',
    pseudonym: 'Заменяет данные на реалистичные фиктивные: ФИО склоняются по падежам, документ читается естественно.',
    reversible: 'Плейсхолдеры + карта восстановления (.json). Храните карту отдельно и в секрете!'
  };

  /* ============ РЕЖИМ ============ */
  document.querySelectorAll('.toggle-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.toggle-btn').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      state.mode = b.dataset.mode;
      $('modeHint').textContent = MODE_HINTS[state.mode];
    });
  });

  /* ============ ЧИПЫ ============ */
  var DEFAULT_OFF = { company: 1, money: 1, vehicle: 1, ip: 1 };
  function chipEls() { return Array.prototype.slice.call(document.querySelectorAll('#typeChips .chip')); }
  chipEls().forEach(function (chip) {
    chip.addEventListener('click', function () {
      var inp = chip.querySelector('input');
      inp.checked = !inp.checked;
      chip.classList.toggle('checked', inp.checked);
    });
  });
  function setChips(fn) {
    chipEls().forEach(function (chip) {
      var on = fn(chip.dataset.type);
      chip.querySelector('input').checked = on;
      chip.classList.toggle('checked', on);
    });
  }
  $('chipsAll').addEventListener('click', function () { setChips(function () { return true; }); });
  $('chipsNone').addEventListener('click', function () { setChips(function () { return false; }); });
  $('chipsDefault').addEventListener('click', function () { setChips(function (t) { return !DEFAULT_OFF[t]; }); });
  var TYPE_EXPAND = { bank_account: ['bank_account', 'bik'], ogrn: ['ogrn', 'kpp'], doc: ['doc', 'passport_ru'], ip: ['ip', 'url', 'net'] };
  function activeTypes() {
    var out = [];
    chipEls().forEach(function (chip) {
      if (!chip.querySelector('input').checked) return;
      var t = chip.dataset.type;
      (TYPE_EXPAND[t] || [t]).forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); });
    });
    return out;
  }

  /* ============ ФАЙЛЫ ============ */
  var dz = $('dropzone'), fi = $('fileInput');
  dz.addEventListener('click', function () { fi.click(); });
  dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', function () { dz.classList.remove('drag'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer.files.length) readFile(e.dataTransfer.files[0]);
  });
  fi.addEventListener('change', function () { if (fi.files.length) readFile(fi.files[0]); });

  function readFile(file) {
    $('fileStatus').textContent = 'Загрузка: ' + file.name + '…';
    var name = file.name.toLowerCase();
    if (name.endsWith('.docx')) {
      var fr = new FileReader();
      fr.onload = function () {
        mammoth.extractRawText({ arrayBuffer: fr.result }).then(function (r) {
          setSource(r.value, file.name);
        }).catch(function () { $('fileStatus').textContent = 'Ошибка чтения docx'; });
      };
      fr.readAsArrayBuffer(file);
    } else if (name.endsWith('.pdf')) {
      var fr2 = new FileReader();
      fr2.onload = function () {
        pdfjsLib.getDocument({
          data: new Uint8Array(fr2.result),
          cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/standard_fonts/'
        }).promise.then(function (pdf) {
          var pages = [];
          var seq = Promise.resolve();
          for (var i = 1; i <= pdf.numPages; i++) {
            (function (p) {
              seq = seq.then(function () {
                return pdf.getPage(p).then(function (page) {
                  return page.getTextContent().then(function (tc) {
                    var line = '', lastY = null;
                    tc.items.forEach(function (it) {
                      var y = it.transform ? it.transform[5] : 0;
                      if (lastY !== null && Math.abs(y - lastY) > 3) { pages.push(line); line = ''; }
                      line += it.str + ' ';
                      lastY = y;
                    });
                    pages.push(line);
                  });
                });
              });
            })(i);
          }
          return seq.then(function () { setSource(pages.join('\n'), file.name); });
        }).catch(function () { $('fileStatus').textContent = 'Ошибка чтения pdf'; });
      };
      fr2.readAsArrayBuffer(file);
    } else {
      var fr3 = new FileReader();
      fr3.onload = function () { setSource(fr3.result, file.name); };
      fr3.readAsText(file, 'utf-8');
    }
  }
  function setSource(text, fname) {
    $('sourceText').value = text;
    $('fileStatus').textContent = 'Загружен: ' + fname + ' (' + text.length + ' симв.)';
    updateCharCount();
    toast('Файл загружен');
  }
  function updateCharCount() {
    var n = $('sourceText').value.length;
    $('charCount').textContent = n ? (n.toLocaleString('ru') + ' симв.') : '';
  }
  $('sourceText').addEventListener('input', updateCharCount);

  /* ============ ТЕСТОВЫЙ ТЕКСТ ============ */
  var TEST_TEXT = 'ДОГОВОР КУПЛИ-ПРОДАЖИ КВАРТИРЫ № 15/2025\n' +
    'г. Гродно                                                    15 марта 2025 г.\n\n' +
    'Гражданин Республики Беларусь Серко Иван Иванович, паспорт серия MP № 2404060, выдан Гродненским ГОВД 20.05.2015, ' +
    'личный номер 1204800A001PB2, зарегистрирован по адресу: г. Гродно, ул. Ожешко, д. 22, кв. 15, именуемый в дальнейшем «Продавец», с одной стороны, и\n' +
    'гражданка Ковалёва Мария Сергеевна, паспорт серия KB № 1234567, личный номер 0102900B002PB5, проживающая по адресу: г. Минск, пр. Независимости, д. 100, кв. 5, именуемая «Покупатель», с другой стороны, заключили настоящий договор о нижеследующем:\n\n' +
    '1. ПРЕДМЕТ ДОГОВОРА\n' +
    '1.1. Продавец обязуется передать в собственность Покупателя квартиру по адресу: г. Гродно, ул. Советская, д. 10, кв. 44, а Покупатель обязуется принять и оплатить её.\n' +
    '1.2. Цена квартиры составляет 250 000,00 (двести пятьдесят тысяч) белорусских рублей.\n\n' +
    '2. ПОРЯДОК РАСЧЁТОВ\n' +
    '2.1. Оплата производится на счёт Продавца: BY03 ALFA 3014 1234 5678 9012 в ОАО «Альфа-Банк», УНП 101541906.\n' +
    '2.2. Контактный телефон Продавца: +375 (29) 123-45-67, email: serko@example.by.\n' +
    '2.3. Контактный телефон Покупателя: +375 (33) 987-65-43.\n\n' +
    '3. ПРОЧИЕ УСЛОВИЯ\n' +
    '3.1. Настоящий договор составлен в соответствии со ст. 393 ГК РБ.\n' +
    '3.2. Споры разрешаются в суде по делу № 2-1234/2025.\n\n' +
    'Продавец: Серко И.И. ____________\n' +
    'Покупатель: Ковалёва М.С. ____________';

  $('btnTest').addEventListener('click', function () {
    $('sourceText').value = TEST_TEXT;
    updateCharCount();
    toast('Загружен тестовый текст');
  });
  $('btnClear').addEventListener('click', function () {
    $('sourceText').value = '';
    updateCharCount();
    $('resultSection').classList.add('hidden');
  });

  /* ============ АНОНИМИЗАЦИЯ ============ */
  $('btnAnonymize').addEventListener('click', function () {
    var text = $('sourceText').value;
    if (!text.trim()) { toast('Вставьте текст документа'); return; }
    $('progressWrap').classList.remove('hidden');
    $('progressBar').style.width = '30%';
    setTimeout(function () {
      try {
        var res = Anonymizer.anonymize(text, {
          mode: state.mode,
          types: activeTypes(),
          customWords: parseWords($('customNames').value),
          stopWords: parseWords($('stopWordsInput').value)
        });
        $('progressBar').style.width = '100%';
        state.source = text;
        state.matches = res.matches;
        state.persons = res.persons;
        state.map = res.map;
        state.result = res.result;
        state.edits = [];
        state.customSpans = [];
        renderAll(res);
        $('resultSection').classList.remove('hidden');
        $('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        console.error(err);
        toast('Ошибка обработки: ' + err.message);
      } finally {
        setTimeout(function () { $('progressWrap').classList.add('hidden'); $('progressBar').style.width = '0'; }, 400);
      }
    }, 60);
  });

  function parseWords(s) {
    return (s || '').split(/[,;\n]+/).map(function (w) { return w.trim(); }).filter(Boolean);
  }

  /* ============ РЕНДЕР ============ */
  function renderAll(res) {
    renderStats(res);
    renderWarn(res);
    renderPreview();
    renderMatches();
    $('cleanText').value = state.result;
    $('matchCountBadge').textContent = state.matches.length;
    $('btnDownloadMap').classList.toggle('hidden', state.mode !== 'reversible');
    updateEditButtons();
  }

  function renderStats(res) {
    var el = $('stats');
    el.innerHTML = '';
    var labels = Anonymizer.TYPE_LABELS;
    var keys = Object.keys(res.stats).sort(function (a, b) { return res.stats[b] - res.stats[a]; });
    keys.forEach(function (t) {
      var chip = document.createElement('span');
      chip.className = 'stat-chip';
      var validated = res.matches.some(function (m) { return m.type === t && m.validated; });
      if (validated) chip.classList.add('validated');
      chip.textContent = (labels[t] || t) + ': ' + res.stats[t];
      chip.title = validated ? 'Есть совпадения с подтверждённой контрольной суммой' : '';
      el.appendChild(chip);
    });
    var total = document.createElement('span');
    total.className = 'stat-chip';
    total.style.background = 'var(--accent)';
    total.style.color = '#fff';
    total.textContent = 'Всего: ' + res.matches.length;
    el.appendChild(total);
  }

  function renderWarn(res) {
    var wb = $('warnBox');
    var msgs = [];
    if (res.persons && res.persons.length) {
      msgs.push('👤 Найдено персон: ' + res.persons.length + ' (' + res.persons.map(function (p) { return p.lemma || p.display || '—'; }).join(', ') + ').');
    }
    if (res.protectedSpans && res.protectedSpans.length) {
      msgs.push('⚖️ Сохранено юридически значимых фрагментов (номера дел, статей, договоров): ' + res.protectedSpans.length + '.');
    }
    if (state.mode === 'reversible') msgs.push('🔑 Скачайте карту восстановления и храните её отдельно от документа.');
    if (msgs.length) { wb.innerHTML = msgs.join('<br>'); wb.classList.remove('hidden'); }
    else wb.classList.add('hidden');
  }

  /* --- Превью: строим из исходника + активных спанов --- */
  function activeMatches() {
    return state.matches.filter(function (m) { return !m._off; }).concat(state.customSpans);
  }

  function renderPreview() {
    var el = $('preview');
    var text = state.source;
    var spans = activeMatches().slice().sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    // убираем вложенные/пересекающиеся (после resolveOverlaps их быть не должно, но customSpans могут)
    var clean = [], lastEnd = -1;
    spans.forEach(function (s) {
      if (s.start >= lastEnd) { clean.push(s); lastEnd = s.end; }
    });
    var html = '', pos = 0;
    clean.forEach(function (s) {
      html += esc(text.slice(pos, s.start));
      var cls = 'mk mk-' + s.type + (s._off ? ' mk-kept' : '') + (s.validated ? ' mk-validated' : '');
      html += '<span class="' + cls + '" data-start="' + s.start + '" data-end="' + s.end + '" title="' +
        esc((Anonymizer.TYPE_LABELS[s.type] || s.type) + (s.reason ? ' — ' + s.reason : '')) + '">' +
        esc(text.slice(s.start, s.end)) + '</span>';
      pos = s.end;
    });
    html += esc(text.slice(pos));
    el.innerHTML = html;
    renderLegend();
  }

  function renderLegend() {
    var el = $('legend');
    var seen = {};
    activeMatches().forEach(function (m) { seen[m.type] = true; });
    var html = [];
    Object.keys(seen).forEach(function (t) {
      html.push('<span class="legend-item"><span class="legend-dot mk mk-' + t + '"></span>' + esc(Anonymizer.TYPE_LABELS[t] || t) + '</span>');
    });
    el.innerHTML = html.join('');
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* --- Список совпадений --- */
  function renderMatches() {
    var el = $('matchList');
    el.innerHTML = '';
    var sorted = state.matches.slice().sort(function (a, b) { return a.start - b.start; });
    sorted.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'match-item';
      row.innerHTML =
        '<span class="match-type">' + esc(Anonymizer.TYPE_LABELS[m.type] || m.type) + '</span>' +
        '<span class="match-text">' + esc(m.text) + '</span>' +
        (m.validated ? '<span class="match-ok" title="Контрольная сумма сошлась">✓</span>' : '') +
        '<span class="match-reason">' + esc(m.reason || '') + '</span>';
      row.addEventListener('click', function () {
        var pe = $('preview').querySelector('[data-start="' + m.start + '"][data-end="' + m.end + '"]');
        if (pe) { pe.scrollIntoView({ behavior: 'smooth', block: 'center' }); pe.style.outline = '2px solid var(--accent)'; setTimeout(function () { pe.style.outline = ''; }, 1200); }
        switchTab('preview');
      });
      el.appendChild(row);
    });
  }

  /* ============ ИНТЕРАКТИВНОЕ РЕДАКТИРОВАНИЕ ============ */
  $('anmModeHide').addEventListener('click', function () { setClickMode('hide'); });
  $('anmModeKeep').addEventListener('click', function () { setClickMode('keep'); });
  function setClickMode(m) {
    state.clickMode = m;
    $('anmModeHide').classList.toggle('on', m === 'hide');
    $('anmModeKeep').classList.toggle('on', m === 'keep');
  }

  $('preview').addEventListener('click', function (e) {
    var t = e.target.closest('.mk');
    if (!t) return;
    var start = +t.dataset.start, end = +t.dataset.end;
    var m = findMatch(start, end);
    if (!m) return;
    if (state.clickMode === 'hide' && m._off) { m._off = false; state.edits.push({ kind: 'on', match: m }); }
    else if (state.clickMode === 'keep' && !m._off) { m._off = true; state.edits.push({ kind: 'off', match: m }); }
    else if (state.clickMode === 'hide' && !m._off) { m._off = true; state.edits.push({ kind: 'off', match: m }); }
    else { m._off = false; state.edits.push({ kind: 'on', match: m }); }
    reapply();
  });

  function findMatch(start, end) {
    var all = state.matches.concat(state.customSpans);
    for (var i = 0; i < all.length; i++) if (all[i].start === start && all[i].end === end) return all[i];
    return null;
  }

  // выделение → кнопка «Скрыть выделенное»
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    var ok = false;
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      var anc = sel.anchorNode && sel.anchorNode.parentElement;
      if (anc && anc.closest && anc.closest('#preview')) ok = true;
    }
    $('anmHideSel').disabled = !ok;
  });

  $('anmHideSel').addEventListener('click', function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    var pre = $('preview');
    // вычисляем offsets через TreeWalker по текстовым узлам
    var tw = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    var node, pos = 0, start = -1, end = -1;
    while ((node = tw.nextNode())) {
      var len = node.nodeValue.length;
      if (node === range.startContainer) start = pos + range.startOffset;
      if (node === range.endContainer) { end = pos + range.endOffset; break; }
      pos += len;
    }
    if (start < 0 || end < 0 || end <= start) { toast('Не удалось определить границы выделения'); return; }
    var span = { start: start, end: end, text: state.source.slice(start, end), type: 'custom', score: 100, reason: 'Добавлено вручную', validated: false };
    state.customSpans.push(span);
    state.edits.push({ kind: 'add', span: span });
    sel.removeAllRanges();
    reapply();
  });

  $('anmUndo').addEventListener('click', function () {
    var e = state.edits.pop();
    if (!e) return;
    if (e.kind === 'off') e.match._off = false;
    else if (e.kind === 'on') e.match._off = true;
    else if (e.kind === 'add') state.customSpans = state.customSpans.filter(function (s) { return s !== e.span; });
    reapply();
  });

  $('anmReset').addEventListener('click', function () {
    state.matches.forEach(function (m) { m._off = false; });
    state.customSpans = [];
    state.edits = [];
    reapply();
  });

  function updateEditButtons() {
    $('anmUndo').disabled = !state.edits.length;
    $('anmReset').disabled = !state.edits.length;
  }

  function reapply() {
    var matches = activeMatches();
    matches = Anonymizer.resolveOverlaps(state.source, matches);
    var res = Anonymizer.applyReplacements(state.source, matches, state.mode, state.persons);
    state.result = res.result;
    state.map = res.map;
    $('cleanText').value = state.result;
    renderPreview();
    updateEditButtons();
  }

  /* ============ ТАБЫ ============ */
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { switchTab(t.dataset.tab); });
  });
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.toggle('active', c.id === 'content-' + name); });
  }

  /* ============ ЭКСПОРТ ============ */
  $('btnCopy').addEventListener('click', function () {
    navigator.clipboard.writeText(state.result).then(function () { toast('Скопировано в буфер обмена'); });
  });

  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  $('btnDownloadTxt').addEventListener('click', function () {
    download(new Blob([state.result], { type: 'text/plain;charset=utf-8' }), 'анонимизированный.txt');
  });

  $('btnDownloadDocx').addEventListener('click', function () {
    if (typeof docx === 'undefined') { toast('Библиотека docx не загружена'); return; }
    var paragraphs = state.result.split('\n').map(function (line) {
      return new docx.Paragraph({ children: [new docx.TextRun({ text: line, font: 'Times New Roman', size: 24 })] });
    });
    var d = new docx.Document({ sections: [{ children: paragraphs }] });
    docx.Packer.toBlob(d).then(function (blob) { download(blob, 'анонимизированный.docx'); });
  });

  $('btnDownloadMap').addEventListener('click', function () {
    if (!state.map) return;
    download(new Blob([JSON.stringify(state.map, null, 2)], { type: 'application/json' }), 'карта-восстановления.json');
    toast('Карта сохранена. Храните её в секрете!');
  });

  /* ============ ВОССТАНОВЛЕНИЕ ============ */
  $('btnRestore').addEventListener('click', function () {
    var text = $('restoreText').value;
    var file = $('restoreMapFile').files[0];
    if (!text.trim()) { toast('Вставьте анонимизированный текст'); return; }
    if (!file) { toast('Выберите файл карты (.json)'); return; }
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var map = JSON.parse(fr.result);
        var restored = Anonymizer.restore(text, map);
        $('restoreResult').value = restored;
        $('restoreResultWrap').classList.remove('hidden');
        toast('Документ восстановлен');
      } catch (e) {
        toast('Ошибка: неверный формат карты');
      }
    };
    fr.readAsText(file, 'utf-8');
  });

  $('btnRestoreDownload').addEventListener('click', function () {
    download(new Blob([$('restoreResult').value], { type: 'text/plain;charset=utf-8' }), 'восстановленный.txt');
  });
})();
