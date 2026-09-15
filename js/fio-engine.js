/* ============================================================
 * FIO-ENGINE v2 — Распознавание ФИО в юридических документах (РФ+РБ)
 * Пайплайн:
 *   1. Токенизация с позициями
 *   2. Генерация кандидатов (маркеры, структура, инициалы, подписи)
 *   3. Скоринг (словари + морфология + контекст − штрафы)
 *   4. Консолидация персон (леммы + пол)
 *   5. Распространение по всем падежным формам и инициалам
 * Работает в браузере (window.FioEngine) и Node.js.
 * ============================================================ */
(function (root, factory) {
  var D = (typeof module !== 'undefined' && module.exports) ? require('./dictionaries.js') : root.Dictionaries;
  var M = (typeof module !== 'undefined' && module.exports) ? require('./morph-engine.js') : root.MorphEngine;
  var api = factory(D, M);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FioEngine = api;
}(typeof self !== 'undefined' ? self : this, function (Dict, Morph) {
  'use strict';

  var U = 'А-ЯЁІЎA-Z';
  var L = 'а-яёіўa-z';

  var markerSet = null;
  var stopSet = null;
  var blacklistSet = null;
  var citySet = null;
  var streetSet = null;
  var orgFormSet = null;
  var roleSet = null;
  var minusRoots = null;
  var nameSet = null;
  var geoSet = null;

  /* Должности, которые никогда не бывают персонами сами по себе */
  var ROLE_ONLY = { секретарь: 1, судья: 1, истец: 1, ответчик: 1, представитель: 1,
    свидетель: 1, директор: 1, эксперт: 1, переводчик: 1, прокурор: 1, адвокат: 1 };

  /* Фамилии-омонимы: совпадают с общеупотребительными словами.
   * Одиночные формы таких фамилий при распространении по падежам маскируем
   * только при подтверждающем контексте (маркер персоны, инициалы или
   * продолжение ФИО) — иначе «Сорока села на плетень» улетит в маску,
   * если в документе есть Сорока М.И. */
  var AMBIGUOUS_SURNAMES = {
    'белый': 1, 'черный': 1, 'волк': 1, 'ворона': 1, 'гусак': 1,
    'дубина': 1, 'жук': 1, 'мороз': 1, 'синяк': 1, 'сорока': 1
  };

  /* Нормализация нераспознанных падежных форм имён по словарю:
   * «Дмитрии»→дмитрий, «Ольги»→ольга, «Ольгой»→ольга, «Марией»→мария.
   * Возвращает нормализованную лемму или null (тогда слово не имя). */
  function normNameLemma(l) {
    if (!l || nameSet == null) return null;
    var tries = [[/ии$/, 'ий'], [/и$/, 'а'], [/ы$/, 'а'], [/ой$/, 'а'], [/ей$/, 'я'], [/е$/, 'а'], [/ю$/, 'я']];
    for (var i = 0; i < tries.length; i++) {
      var cand = l.replace(tries[i][0], tries[i][1]);
      if (cand !== l && nameSet.has(cand)) return cand;
    }
    return null;
  }

  function init() {
    if (markerSet) return;
    markerSet = new Set(Dict.fioMarkers.concat(Dict.fioMarkersCases).concat(Dict.participles).map(function (w) { return w.toLowerCase(); }));
    stopSet = new Set(Dict.fioStopWords.map(function (w) { return w.toLowerCase(); }));
    blacklistSet = new Set(Dict.blacklist.map(function (w) { return w.toLowerCase(); }));
    citySet = new Set(Dict.cities.map(function (w) { return w.toLowerCase(); }));
    streetSet = new Set(Dict.streets.map(function (w) { return w.toLowerCase(); }));
    orgFormSet = new Set(Dict.orgForms.map(function (w) { return w.toLowerCase(); }));
    roleSet = new Set(Dict.roles.map(function (w) { return w.toLowerCase(); }));
    // Корни минус-слов (нормализуем ё→е, т.к. проверка идёт по префиксу)
    minusRoots = (Dict.ambiguousMinus || []).map(function (w) { return w.toLowerCase().replace(/ё/g, 'е'); });
    nameSet = new Set(Dict.namesM.concat(Dict.namesF).map(function (w) { return w.toLowerCase(); }));
    // гео-названия не начинают ФИО: «г. Москвы Романова…» — «Москвы» не персона
    // гео: «Москвы» (род. п.) нет в списке номинативов — генерируем простую парадигму
    var geoRaw = (Array.isArray(Dict.cities) ? Dict.cities : ('' + (Dict.cities || '')).split(/[,|]/))
      .concat(Array.isArray(Dict.regions) ? Dict.regions : ('' + (Dict.regions || '')).split(/[,|]/));
    geoSet = new Set();
    geoRaw.forEach(function (w) {
      var lw = ('' + w).toLowerCase().trim();
      if (!lw) return;
      geoSet.add(lw);
      // NB: парадигму генерируем ТОЛЬКО для городов на -а («Москва»→москвы/москве…).
      // Склонение -о/-е-основ (Иваново→иванова) коллидирует с фамилиями
      // («Иванова») и ломает ФИО — точные формы города всё ещё в geoSet.
      if (/а$/.test(lw)) { var b = lw.slice(0, -1); ['ы', 'е', 'у', 'ой', 'ю'].forEach(function (e) { geoSet.add(b + e); }); }
    });
    // Строим морфологический индекс словарей
    Morph.buildIndex({
      surnames: Dict.surnames,
      namesM: Dict.namesM,
      namesF: Dict.namesF,
      patronymics: Dict.patronymics
    });
  }

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ============ ТОКЕНИЗАЦИЯ ============ */
  var WORD_RE = new RegExp('[' + U + '][' + L + ']*(?:-[' + U + '][' + L + ']*)*|[' + U + ']\\.(?:[' + U + ']\\.)?|[0-9]+[.,]?[0-9]*|[' + L + ']+(?:-[' + U + '][' + L + ']*)*|[^\\s]', 'g');

  function tokenize(text) {
    var tokens = [];
    WORD_RE.lastIndex = 0;
    var m;
    while ((m = WORD_RE.exec(text)) !== null) {
      tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
    }
    return tokens;
  }

  function isCapitalizedWord(w) {
    return new RegExp('^[' + U + '][' + L + ']+(-[' + U + '][' + L + ']+)*$').test(w);
  }
  function isInitial(w) {
    return new RegExp('^[' + U + ']\\.$').test(w);
  }
  function isDoubleInitial(w) {
    return new RegExp('^[' + U + ']\\.[' + U + ']\\.$').test(w);
  }
  function cleanWord(w) {
    return w.replace(new RegExp('[^' + U + L + '-]', 'g'), '');
  }

  /* ============ АНАЛИЗ СЛОВА (роль в ФИО) ============ */
  function wordRole(word, genderHint) {
    var w = cleanWord(word);
    if (w.length < 2) return null;
    var lw = w.toLowerCase();
    if (blacklistSet.has(lw) || stopSet.has(lw)) return null;
    if (citySet.has(lw) || streetSet.has(lw)) return { type: 'geo' };
    var analyses = Morph.analyzeWord(w);
    var best = null, priority = { patronymic: 3, surname: 2, name: 1 };
    for (var i = 0; i < analyses.length; i++) {
      var a = analyses[i];
      if (!best) { best = a; continue; }
      var pa = (priority[a.type] || 0) * 10 + ((genderHint && a.gender === genderHint) ? 5 : 0) + (a.source === 'dict' ? 1 : 0);
      var pb = (priority[best.type] || 0) * 10 + ((genderHint && best.gender === genderHint) ? 5 : 0) + (best.source === 'dict' ? 1 : 0);
      if (pa > pb) best = a;
    }
    return best;
  }

  /* ============ ГЕНЕРАЦИЯ КАНДИДАТОВ ============ */

  /**
   * Собирает последовательность ФИО начиная с токена i:
   * слова с заглавной + инициалы, максимум 4 токена.
   */
  function collectFioSequence(tokens, i, maxTokens) {
    var parts = [];
    var j = i;
    while (j < tokens.length && parts.length < (maxTokens || 4)) {
      var t = tokens[j];
      // разрыв больше 2 пробельных символов или перевод строки — стоп
      if (parts.length > 0) {
        var gap = tokens[j].start - tokens[j - 1].end;
        var gapText = gap > 0 ? ' ' : '';
        if (gap > 2) break;
        if (j > 0 && /\n/.test(' ')) { /* проверяем через исходник ниже */ }
      }
      if (isCapitalizedWord(t.word) || isInitial(t.word) || isDoubleInitial(t.word)) {
        parts.push(t);
        j++;
      } else break;
    }
    return parts;
  }

  function detectFio(text, options) {
    init();
    options = options || {};
    var threshold = options.threshold != null ? options.threshold : 40;
    var customWords = (options.customWords || []).map(function (w) { return w.toLowerCase(); });
    var userStop = (options.stopWords || []).map(function (w) { return w.toLowerCase(); });
    var protectedSpans = options.protectedSpans || [];

    var tokens = tokenize(text);
    var candidates = [];

    function isProtected(start, end) {
      for (var i = 0; i < protectedSpans.length; i++) {
        if (start < protectedSpans[i].end && end > protectedSpans[i].start) return true;
      }
      return false;
    }

    /* --- A. Маркер-якоря: «гражданин Иванов И.И.», «истец Петрова Мария Ивановна» --- */
    for (var i = 0; i < tokens.length; i++) {
      var lw = tokens[i].word.toLowerCase().replace(/[.,:;]/g, '');
      // роли («судья», «врач»…) работают как маркеры — иначе «Судья Иванова Мария Петровна»
      // теряет отчество (якорь B упирается в лимит 3 слов, начиная с самой роли)
      var isMarker = markerSet.has(lw) || roleSet.has(lw);
      // «ИП» / «И.П.» как маркер
      if (!isMarker && /^(ип|и\.п\.)$/i.test(tokens[i].word)) isMarker = true;
      if (!isMarker) continue;

      var seq = collectFioSequence(tokens, i + 1, 4);
      if (seq.length === 0) continue;
      // фильтр: первое слово не должно быть стоп-словом/маркером
      var firstClean = cleanWord(seq[0].word).toLowerCase();
      if (stopSet.has(firstClean) || blacklistSet.has(firstClean) || markerSet.has(firstClean)) continue;
      if (orgFormSet.has(firstClean)) continue;
      // роли/маркеры недопустимы ВНУТРИ кандидата: «Мария Ивановна\nСекретарь»
      // (якорь B перепрыгивает через перенос строки) — не персона
      var roleInsideA = false;
      for (var riA = 0; riA < seq.length; riA++) {
        var cwA = cleanWord(seq[riA].word).toLowerCase();
        if (riA > 0 && (roleSet.has(cwA) || markerSet.has(cwA) || stopSet.has(cwA))) { roleInsideA = true; break; }
      }
      if (roleInsideA) continue;
      // словарь минусов действует и в маркер-ветке (после P1 маркеры стали
      // видны в середине предложения): «гражданин Волков воет» — не персона
      var nextTokA = tokens[i + 1 + seq.length];
      var minusHitA = false;
      if (nextTokA && minusRoots && minusRoots.length > 0) {
        var nrA = nextTokA.word.toLowerCase().replace(/[.,:;»"')]/g, '').replace(/ё/g, 'е');
        for (var mrA = 0; mrA < minusRoots.length; mrA++) {
          if (nrA.indexOf(minusRoots[mrA]) === 0) { minusHitA = true; break; }
        }
      }
      if (minusHitA) continue;

      addCandidate(candidates, text, seq, 80, 'маркер «' + tokens[i].word + '»', isProtected);
    }

    /* --- B. Структурные якоря: 2-3 слова с заглавной, где есть отчество или ≥2 словарных --- */
    for (var i2 = 0; i2 < tokens.length; i2++) {
      if (!isCapitalizedWord(tokens[i2].word)) continue;
      var firstB = cleanWord(tokens[i2].word).toLowerCase();
      // гео проверяем и по лемме: «Москвы» (род. п.) нет в списке, но «Москва» есть
      var firstLemma = null;
      try { firstLemma = Morph.lemmatize(firstB).toLowerCase(); } catch (e) { }
      if (markerSet.has(firstB) || stopSet.has(firstB) || blacklistSet.has(firstB) || orgFormSet.has(firstB) || roleSet.has(firstB) || (geoSet && (geoSet.has(firstB) || (firstLemma && geoSet.has(firstLemma))))) continue;
      var seq2 = collectFioSequence(tokens, i2, 3);
      if (seq2.length < 2) continue;
      // роли/маркеры недопустимы внутри кандидата (перепрыг через «\n»):
      // «Мария Ивановна\nСекретарь» — не персона
      var roleInsideB = false;
      for (var riB = 0; riB < seq2.length; riB++) {
        var cwB = cleanWord(seq2[riB].word).toLowerCase();
        if (riB > 0 && (roleSet.has(cwB) || markerSet.has(cwB) || stopSet.has(cwB))) { roleInsideB = true; break; }
      }
      if (roleInsideB) continue;
      var roles = seq2.map(function (t) { return wordRole(t.word); });
      var hasPatr = roles.some(function (r) { return r && r.type === 'patronymic'; });
      var dictHits = roles.filter(function (r) { return r && r.source === 'dict' && (r.type === 'surname' || r.type === 'name'); }).length;
      var customHits = seq2.filter(function (t) { return customWords.indexOf(cleanWord(t.word).toLowerCase()) !== -1; }).length;
      if (hasPatr || dictHits >= 2 || customHits >= 1) {
        // проверяем, не является ли это географией/организацией
        var geo = roles.some(function (r) { return r && r.type === 'geo'; });
        if (geo && !hasPatr) continue;
        addCandidate(candidates, text, seq2, hasPatr ? 85 : 70, hasPatr ? 'структура: отчество' : 'структура: словарь', isProtected);
      }
    }

    /* --- C. Инициалы: «Иванов И.И.», «И.И. Иванов», «Иванову И.И.» --- */
    var initRe = new RegExp('(?<![' + U + L + '])([' + U + '][' + L + ']{2,25}(?:-[' + U + '][' + L + ']{2,25})?)[\\s]+([' + U + '])\\.[\\s]*([' + U + '])?\\.?(?![' + L + '])', 'g');
    var m;
    while ((m = initRe.exec(text)) !== null) {
      if (isProtected(m.index, m.index + m[0].length)) continue;
      var surnameW = m[1];
      var lwS = surnameW.toLowerCase();
      if (stopSet.has(lwS) || blacklistSet.has(lwS) || citySet.has(lwS) || streetSet.has(lwS)) continue;
      if (orgFormSet.has(lwS)) continue;
      var role = wordRole(surnameW);
      var score = 72;
      var reason = 'фамилия + инициалы';
      if (role && role.type === 'surname') { score += 13; reason += ' (словарь/морфо)'; }
      if (customWords.indexOf(lwS) !== -1) { score += 15; reason += ' (польз. слово)'; }
      pushCandidate(candidates, m.index, m.index + m[0].length, text, score, reason);
    }
    // Обратный порядок: «И.И. Иванов»
    var initRe2 = new RegExp('(?<![' + U + L + '])([' + U + '])\\.([\\s]*)([' + U + '])\\.[\\s]+([' + U + '][' + L + ']{2,25})(?![' + L + '])', 'g');
    while ((m = initRe2.exec(text)) !== null) {
      if (isProtected(m.index, m.index + m[0].length)) continue;
      var sw = m[4], lw2 = sw.toLowerCase();
      if (stopSet.has(lw2) || blacklistSet.has(lw2) || citySet.has(lw2) || streetSet.has(lw2) || orgFormSet.has(lw2)) continue;
      pushCandidate(candidates, m.index, m.index + m[0].length, text, 75, 'инициалы + фамилия');
    }

    /* --- D. Подписи: «_______ /Иванов И.И./», «(подпись) (Иванов И.И.)» --- */
    var sigRe = new RegExp('[/_(]\\s*([' + U + '][' + L + ']{2,25}(?:-[' + U + '][' + L + ']+)?(?:[\\s]+[' + U + ']\\.[\\s]*[' + U + ']?\\.?|[\\s]+[' + U + '][' + L + ']+){0,2})\\s*[/_)](?![a-z])', 'g');
    while ((m = sigRe.exec(text)) !== null) {
      if (isProtected(m.index, m.index + m[0].length)) continue;
      var inner = m[1];
      var innerStart = m.index + m[0].indexOf(inner);
      var firstW = cleanWord(inner.split(/[\s]+/)[0]).toLowerCase();
      if (stopSet.has(firstW) || blacklistSet.has(firstW) || citySet.has(firstW) || streetSet.has(firstW)) continue;
      pushCandidate(candidates, innerStart, innerStart + inner.length, text, 85, 'подпись /Ф.И.О./');
    }

    /* --- E. «в лице директора Иванова Ивана Ивановича, действующего на основании» --- */
    var vliceRe = new RegExp('в лице[\\s]+(?:[а-яёіў]+[\\s]+){0,3}([' + U + '][' + L + ']+[\\s]+[' + U + '][' + L + ']+[\\s]+[' + U + '][' + L + ']+)', 'gi');
    while ((m = vliceRe.exec(text)) !== null) {
      if (isProtected(m.index, m.index + m[0].length)) continue;
      var fioStart = m.index + m[0].indexOf(m[1]);
      pushCandidate(candidates, fioStart, fioStart + m[1].length, text, 92, 'конструкция «в лице»');
    }

    /* --- F. Пользовательские слова --- */
    for (var cw = 0; cw < customWords.length; cw++) {
      var w = customWords[cw];
      if (w.length < 2) continue;
      var cwRe = new RegExp('(?<![' + U + L + '0-9])' + esc(w) + '(?<![' + U + L + '0-9])', 'gi');
      while ((m = cwRe.exec(text)) !== null) {
        if (isProtected(m.index, m.index + m[0].length)) continue;
        pushCandidate(candidates, m.index, m.index + m[0].length, text, 88, 'пользовательское слово');
      }
    }

    /* ============ СКОРИНГ И ФИЛЬТРАЦИЯ ============ */
    var filtered = [];
    var seenSpans = {};
    for (var c = 0; c < candidates.length; c++) {
      var cand = candidates[c];
      var key = cand.start + ':' + cand.end;
      if (seenSpans[key]) {
        // оставляем с максимальным score
        for (var f2 = 0; f2 < filtered.length; f2++) {
          if (filtered[f2].start === cand.start && filtered[f2].end === cand.end && filtered[f2].score < cand.score) {
            filtered[f2] = cand;
          }
        }
        continue;
      }
      seenSpans[key] = true;
      var scored = scoreCandidate(text, cand, customWords, userStop);
      if (scored.score >= threshold) filtered.push(scored);
    }

    /* ============ КОНСОЛИДАЦИЯ ПЕРСОН ============ */
    var persons = extractPersons(filtered, text);

    /* ============ РАСПРОСТРАНЕНИЕ ПО ПАДЕЖАМ ============ */
    var propagated = propagatePersons(text, persons, filtered, userStop, isProtected);

    var all = filtered.concat(propagated);
    // сортируем, удаляем пересечения (приоритет — более длинным и высокоскорым)
    all.sort(function (a, b) { return a.start - b.start || (b.end - b.start) - (a.end - a.start) || b.score - a.score; });
    var final = [];
    for (var i3 = 0; i3 < all.length; i3++) {
      var cur = all[i3];
      var overlapped = false;
      for (var j3 = 0; j3 < final.length; j3++) {
        if (cur.start < final[j3].end && cur.end > final[j3].start) { overlapped = true; break; }
      }
      if (!overlapped) final.push(cur);
    }
    return { matches: final, persons: persons };
  }

  function addCandidate(out, text, seq, baseScore, reason, isProtected) {
    if (seq.length === 0) return;
    var start = seq[0].start;
    var end = seq[seq.length - 1].end;
    if (isProtected(start, end)) return;
    pushCandidate(out, start, end, text, baseScore, reason);
  }

  function pushCandidate(out, start, end, text, score, reason) {
    var t = text.slice(start, end).replace(/[\s]+$/, '');
    if (t.length < 2) return;
    out.push({ start: start, end: start + t.length, text: t, type: 'fio', score: score, reason: reason });
  }

  /* ============ СКОРИНГ КАНДИДАТА ============ */
  function scoreCandidate(text, cand, customWords, userStop) {
    var score = cand.score;
    var reasons = [cand.reason];
    var parts = cand.text.split(/[\s-]+/).filter(function (p) { return p.length > 0; });

    var hasLower = false, hasDigit = false, hasStop = false, hasOrg = false, hasGeo = false;
    var dictHits = 0, patrHits = 0;
    for (var i = 0; i < parts.length; i++) {
      var w = parts[i];
      if (/^[А-ЯЁІЁа-яёіў]\.?$/.test(w)) continue;
      if (/^[а-яёіў]/.test(w)) hasLower = true;
      if (/[0-9a-zA-Z]/.test(w)) hasDigit = true;
      var cw = cleanWord(w).toLowerCase();
      if (cw.length > 2 && (stopSet.has(cw) || blacklistSet.has(cw))) hasStop = true;
      if (userStop.indexOf(cw) !== -1) hasStop = true;
      if (orgFormSet.has(cw)) hasOrg = true;
      if (citySet.has(cw) || streetSet.has(cw)) hasGeo = true;
      var role = wordRole(w);
      if (role && role.source === 'dict') dictHits++;
      if (role && role.type === 'patronymic') patrHits++;
      if (customWords.indexOf(cw) !== -1) dictHits++;
    }

    if (hasLower) { score -= 80; reasons.push('строчная буква'); }
    if (hasDigit) { score -= 50; reasons.push('цифры/латиница'); }
    if (hasStop) { score -= 75; reasons.push('стоп-слово'); }
    if (hasOrg) { score -= 100; reasons.push('орг. форма'); }
    if (hasGeo && patrHits === 0) { score -= 60; reasons.push('география'); }
    if (dictHits > 0) { score += dictHits * 8; reasons.push('словарь ×' + dictHits); }
    if (patrHits > 0) { score += 15; reasons.push('отчество'); }
    if (parts.length === 1 && dictHits === 0 && patrHits === 0) { score -= 25; reasons.push('одно слово вне словаря'); }
    if (parts.length === 3) { score += 10; reasons.push('три слова'); }

    // КАПС-слова (аббревиатуры) — не ФИО
    for (var k = 0; k < parts.length; k++) {
      var wc = cleanWord(parts[k]);
      if (wc.length >= 3 && /^[А-ЯЁІЎA-Z]+$/.test(wc)) { score -= 60; reasons.push('КАПС'); break; }
    }

    // Географическое прилагательное: «гродненский», «минская»
    for (var g = 0; g < parts.length; g++) {
      var gm = cleanWord(parts[g]).toLowerCase().match(/^([а-яёіў]+?)ск(ий|ого|ому|им|ом|ая|ое|ие|их|ым|ую|ем|ее)$/);
      if (gm && (citySet.has(gm[1] + 'ск') || citySet.has(gm[1]))) { score -= 80; reasons.push('гео-прилагательное'); break; }
    }

    // Улица после маркера улицы — это адрес, не ФИО
    var before = text.slice(Math.max(0, cand.start - 14), cand.start);
    if (/(?:ул|улица|вул|вуліца|пр|просп|пр-т|пер|переулок|зав|б-р|бульвар|наб|набережная|ш|шоссе|туп|тупик|аллея|проезд|тракт|пл|площадь)\.?[\s-]*$/i.test(before)) {
      score -= 100; reasons.push('после маркера улицы');
    }

    score = Math.max(0, Math.min(100, score));
    return {
      start: cand.start, end: cand.end, text: cand.text, type: 'fio',
      score: score, reason: reasons.join('; ')
    };
  }

  /* ============ КОНСОЛИДАЦИЯ ПЕРСОН ============ */
  function extractPersons(matches, text) {
    var persons = [];
    var personByKey = {};
    var bySurname = {};

    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      var parts = m.text.split(/[\s]+/).filter(function (p) { return p.length > 0; });
      var person = { surname: null, name: null, patronymic: null, gender: null, initials: [] };

      for (var p = 0; p < parts.length; p++) {
        var w = parts[p];
        if (isInitial(w) || isDoubleInitial(w)) {
          var letters = w.replace(/[^А-ЯЁІЎA-Z]/g, '');
          for (var li = 0; li < letters.length; li++) person.initials.push(letters[li].toUpperCase());
          continue;
        }
        var role = wordRole(w, person.gender);
        if (!role) {
          var wl = cleanWord(w).toLowerCase();
          // нераспознанная падежная форма имени («о Дмитрии», «Ольгой») — имя
          var nmFix = normNameLemma(wl);
          if (nmFix) {
            if (!person.name) person.name = nmFix;
            continue;
          }
          // неизвестное слово с заглавной — считаем фамилией, если фамилии ещё нет
          if (!person.surname && isCapitalizedWord(w)) {
            person.surname = wl;
            person.surnameType = 'unknown';
          }
          continue;
        }
        // нераспознанные падежные формы имён (морф. лемма вне словаря → эвристика
        // приняла слово за фамилию): «Дмитрии», «Ольги», «Ольгой», «Марией»…
        var normNm = normNameLemma(role.lemma);
        if (normNm) role = { type: 'name', lemma: normNm, gender: role.gender, source: role.source };
        if (role.type === 'surname' && !person.surname) {
          person.surname = role.lemma;
          person.surnameType = role.source;
          if (role.gender) person.gender = role.gender;
        } else if (role.type === 'name' && !person.name) {
          // «о Дмитрии» лемматизируется как «дмитрии» → приводим к «дмитрий» по словарю,
          // иначе предложная форма не сливается с именительной (персона дублируется)
          var nmL = role.lemma;
          if (nmL && /ии$/.test(nmL)) {
            var nmAlt = nmL.slice(0, -1) + 'й';
            if (nameSet.has(nmAlt)) nmL = nmAlt;
          }
          person.name = nmL;
          if (role.gender) person.gender = role.gender;
        } else if (role.type === 'patronymic' && !person.patronymic) {
          person.patronymic = role.lemma;
          person.gender = role.gender || person.gender;
        }
      }

      if (!person.surname && !person.name && !person.patronymic) continue;
      // стражи фантомных персон: должность-одиночка и осиротевшее отчество
      if (!person.surname && !person.name && person.patronymic) continue; // «Ивановна» одна — не персона
      if (person.surname && !person.name && !person.patronymic && ROLE_ONLY[person.surname]) continue; // «Секретарь» один
      if (person.surname && !person.name && !person.patronymic && /(вна|вич|ична)$/.test(person.surname)) continue; // «Петровна» одна
      var key = (person.surname || '') + '|' + (person.name || '') + '|' + (person.patronymic || '');
      // «Кузнецов Д.С.» сливается с уже найденным «Кузнецов Дмитрий Сергеевич»
      // (иначе одна персона получает два номера псевдонима)
      if (person.surname && !person.name && person.initials.length > 0) {
        var cands = bySurname[person.surname] || [];
        for (var ci = 0; ci < cands.length; ci++) {
          var c = cands[ci];
          var cName = c.name ? c.name.charAt(0).toUpperCase() : '';
          var cPatr = c.patronymic ? c.patronymic.charAt(0).toUpperCase() : '';
          if (person.initials.length === 1 && cName === person.initials[0]) { personByKey[key] = c; break; }
          if (person.initials.length >= 2 && cName === person.initials[0] && cPatr === person.initials[1]) { personByKey[key] = c; break; }
        }
      }
      if (!personByKey[key]) {
        person.id = persons.length;
        persons.push(person);
        personByKey[key] = person;
        if (person.surname) { (bySurname[person.surname] = bySurname[person.surname] || []).push(person); }
      }
      m.personId = personByKey[key].id;
    }
    return persons;
  }

  /* ============ РАСПРОСТРАНЕНИЕ ПО ПАДЕЖАМ ============ */
  function propagatePersons(text, persons, existingMatches, userStop, isProtected) {
    var out = [];
    if (persons.length === 0) return out;

    function overlapsExisting(start, end) {
      for (var i = 0; i < existingMatches.length; i++) {
        if (start < existingMatches[i].end && end > existingMatches[i].start) return true;
      }
      for (var j = 0; j < out.length; j++) {
        if (start < out[j].end && end > out[j].start) return true;
      }
      return false;
    }

    for (var pi = 0; pi < persons.length; pi++) {
      var person = persons[pi];
      var components = [];
      if (person.surname) components.push({ lemma: person.surname, type: 'surname', gender: person.gender });
      if (person.name) components.push({ lemma: person.name, type: 'name', gender: person.gender });
      if (person.patronymic) components.push({ lemma: person.patronymic, type: 'patronymic', gender: person.gender });

      for (var ci = 0; ci < components.length; ci++) {
        var comp = components[ci];
        var forms = Morph.allForms(comp.lemma, comp.type, comp.gender);
        if (forms.length === 0) continue;
        var alt = forms.map(function (f) { return esc(f); }).join('|');
        // одиночные формы компонентов — только с заглавной
        var re = new RegExp('(?<![' + U + L + '])(' + alt + ')(?![' + L + '])', 'g');
        var m;
        while ((m = re.exec(text)) !== null) {
          if (isProtected(m.index, m.index + m[0].length)) continue;
          if (overlapsExisting(m.index, m.index + m[0].length)) continue;
          var lw = m[0].toLowerCase();
          if (userStop.indexOf(lw) !== -1) continue;
          if (blacklistSet.has(lw) || stopSet.has(lw)) continue;
          // форма должна быть с заглавной (кроме случаев, когда форма совпадает с леммой нерегистрозависимо)
          if (!/^[А-ЯЁІЎA-Z]/.test(m[0])) continue;
          // Омонимы: одиночная форма фамилии-коммон-нейма — только с подтверждающим контекстом
          // фамилия-дериват омонима тоже омоним: «Волков» ← «Волк», «Морозов» ← «Мороз»
          var ambBase = comp.lemma && AMBIGUOUS_SURNAMES[comp.lemma] ? comp.lemma
            : (comp.lemma ? comp.lemma.replace(/(ов|ев|ин|ын|ский|цкий)$/, '') : null);
          if (comp.type === 'surname' && ambBase && AMBIGUOUS_SURNAMES[ambBase]) {
            // Словарь минусов: соседнее слово-корень («воет», «гнезд», «крыл»…)
            // доказывает нарицательное значение и перекрывает даже маркеры —
            // действует и для дериватов («Морозов выет» → «выет»)
            if (minusRoots && minusRoots.length > 0) {
              var nb = text.slice(Math.max(0, m.index - 25), m.index) + ' ' + text.slice(m.index + m[0].length, m.index + m[0].length + 25);
              var nearWords = nb.toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z]+/g) || [];
              for (var nw = 0; nw < nearWords.length; nw++) {
                for (var mr = 0; mr < minusRoots.length; mr++) {
                  if (nearWords[nw].indexOf(minusRoots[mr]) === 0) { var minusHit = true; break; }
                }
                if (minusHit) break;
              }
              if (minusHit) continue;
            }
            // полный гвард (маркер/инициалы/продолжение ФИО) — только для точных
            // омонимов («Волк», «Сорока»); дериваты («Волков»←«Волк», «Морозов»←«Мороз»)
            // — обычные фамилии, без минус-слов маскируются как раньше
            if (ambBase === comp.lemma) {
              var beforeAmb = text.slice(Math.max(0, m.index - 30), m.index);
              var afterAmb = text.slice(m.index + m[0].length, m.index + m[0].length + 5);
            var afterAmb = text.slice(m.index + m[0].length, m.index + m[0].length + 5);
            var nextW = (text.slice(m.index + m[0].length).match(/^\s+([А-ЯЁІЎ][а-яёіў-]+)/) || [])[1];
            var nextRole = nextW ? wordRole(nextW) : null;
            var hasMarker = /(?:граждан|ист[ея]ц|истиц|ответчик|судь|продав|покупат|заявит|работник|нанимат|представит|доверит|указанн|именуем|родивш|зарегистр|прожива|в лице|г-н|г-жа|господ|товарищ|паспорт)[а-яёіў]*[:\s]*$/i.test(beforeAmb);
            var hasInitials = /^\s+[А-ЯЁІЎA-Z]\.\s*[А-ЯЁІЎA-Z]?\.?/.test(afterAmb);
            var hasFioContinuation = !!(nextRole && (nextRole.type === 'name' || nextRole.type === 'patronymic'));
              if (!hasMarker && !hasInitials && !hasFioContinuation) continue;
            }   // конец «только точные омонимы»
          }     // конец гварда омонимов
          // осторожно у кавычек: «ООО «Иванов»» — часть названия, не трогаем;
          // но «Иванов пояснил…» в прямой речи — персона, маскируем
          var after = text.slice(m.index + m[0].length, m.index + m[0].length + 2);
          var beforeCh = text.slice(Math.max(0, m.index - 2), m.index);
          var beforeWide = text.slice(Math.max(0, m.index - 15), m.index);
          if (/^[»"']/.test(after)) continue;
          if (/[«"']$/.test(beforeCh) && /(?:ООО|ЗАО|ОАО|ПАО|НАО|АО|ИП|ЧУП|ЧТУП|УП|РУП|КУП|ГУП|МУП|СК|ТД|НП|АНО|Фонд|ТОО|ГБУЗ|ГБУ)\s*[«"']?$/i.test(beforeWide)) continue;
          var caseOf = Morph.caseOf(comp.lemma, comp.type, comp.gender, m[0]);
          out.push({
            start: m.index, end: m.index + m[0].length, text: m[0], type: 'fio',
            score: 90, reason: 'форма «' + comp.lemma + '» (' + (caseOf || '?') + ')',
            personId: person.id, propagated: true, caseOf: caseOf, component: comp.type
          });
        }
      }

      // Инициалы персоны: «Фамилия И.О.» во всех падежах
      if (person.surname && person.initials.length > 0) {
        var sForms = Morph.allForms(person.surname, 'surname', person.gender);
        var initStr = person.initials.map(function (c) { return esc(c) + '\\.[\\s]*'; }).join('');
        var re2 = new RegExp('(?<![' + U + L + '])(' + sForms.map(esc).join('|') + ')[\\s]+' + initStr + '(?![' + L + '])', 'g');
        var m2;
        while ((m2 = re2.exec(text)) !== null) {
          if (isProtected(m2.index, m2.index + m2[0].length)) continue;
          if (overlapsExisting(m2.index, m2.index + m2[0].length)) continue;
          out.push({
            start: m2.index, end: m2.index + m2[0].length, text: m2[0], type: 'fio',
            score: 95, reason: 'фамилия + инициалы (персона #' + person.id + ')',
            personId: person.id, propagated: true
          });
        }
        // «И.О. Фамилия»
        var re3 = new RegExp('(?<![' + U + L + '])' + initStr + '[\\s]*(' + sForms.map(esc).join('|') + ')(?![' + L + '])', 'g');
        while ((m2 = re3.exec(text)) !== null) {
          if (isProtected(m2.index, m2.index + m2[0].length)) continue;
          if (overlapsExisting(m2.index, m2.index + m2[0].length)) continue;
          out.push({
            start: m2.index, end: m2.index + m2[0].length, text: m2[0], type: 'fio',
            score: 95, reason: 'инициалы + фамилия (персона #' + person.id + ')',
            personId: person.id, propagated: true
          });
        }
      }
    }
    return out;
  }

  return {
    detectFio: detectFio,
    tokenize: tokenize,
    wordRole: wordRole,
    _init: init
  };
}));
