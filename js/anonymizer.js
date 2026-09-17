/* ============================================================
 * ANONYMIZER v2 — Ядро анонимизации
 * Режимы:
 *   mask       — плейсхолдеры [ФИО-1], [АДРЕС-1] (безвозвратно)
 *   pseudonym  — реалистичные фиктивные данные с правильным
 *                склонением (документ остаётся читаемым)
 *   reversible — плейсхолдеры + карта замен для восстановления
 * Работает в браузере (window.Anonymizer) и Node.js.
 * ============================================================ */
(function (root, factory) {
  var isNode = (typeof module !== 'undefined' && module.exports);
  var D = isNode ? require('./dictionaries.js') : root.Dictionaries;
  var M = isNode ? require('./morph-engine.js') : root.MorphEngine;
  var Det = isNode ? require('./detectors.js') : root.Detectors;
  var Fio = isNode ? require('./fio-engine.js') : root.FioEngine;
  var api = factory(D, M, Det, Fio);
  if (isNode) module.exports = api;
  root.Anonymizer = api;
}(typeof self !== 'undefined' ? self : this, function (Dict, Morph, Detectors, FioEngine) {
  'use strict';

  var TYPE_LABELS = {
    fio: 'ФИО', address: 'АДРЕС', phone: 'ТЕЛЕФОН', email: 'EMAIL',
    passport_ru: 'ПАСПОРТ', passport_by: 'ПАСПОРТ-РБ', personal_id_by: 'ЛИЧНЫЙ-НОМЕР',
    doc: 'ДОКУМЕНТ', inn: 'ИНН', snils: 'СНИЛС', ogrn: 'ОГРН', kpp: 'КПП', unp: 'УНП',
    bank_account: 'СЧЁТ', iban: 'IBAN', bik: 'БИК', card: 'КАРТА', dob: 'ДАТА-РОЖДЕНИЯ',
    vehicle: 'ГОСНОМЕР', company: 'ОРГАНИЗАЦИЯ', money: 'СУММА', ip: 'IP', url: 'URL', net: 'СЕТЬ', custom: 'СКРЫТО', fio_lat: 'ФИО', polis: 'ПОЛИС'
  };

  /* Приоритет типов при разрешении пересечений (больше = важнее) */
  var TYPE_PRIORITY = {
    personal_id_by: 100, passport_ru: 99, passport_by: 99, iban: 98, bank_account: 97,
    snils: 96, inn: 95, ogrn: 94, unp: 94, card: 93, email: 92, phone: 90,
    fio: 80, fio_lat: 80, dob: 78, address: 70, company: 60, vehicle: 55, money: 40,
    ip: 50, url: 50, net: 50, doc: 65, kpp: 65, bik: 65, custom: 101
  };

  /* ============ ПСЕВДОНИМЫ ============ */
  var FAKE_SURNAMES_M = ['Смирнов', 'Козлов', 'Волков', 'Соколов', 'Морозов', 'Новиков', 'Лебедев', 'Павлов', 'Семёнов', 'Егоров', 'Орлов', 'Захаров', 'Борисов', 'Романов', 'Тарасов'];
  var FAKE_SURNAMES_F = ['Смирнова', 'Козлова', 'Волкова', 'Соколова', 'Морозова', 'Новикова', 'Лебедева', 'Павлова', 'Семёнова', 'Егорова', 'Орлова', 'Захарова', 'Борисова', 'Романова', 'Тарасова'];
  var FAKE_NAMES_M = ['Андрей', 'Дмитрий', 'Сергей', 'Максим', 'Николай', 'Владимир', 'Артём', 'Кирилл', 'Олег', 'Роман'];
  var FAKE_NAMES_F = ['Ольга', 'Наталья', 'Елена', 'Марина', 'Ирина', 'Светлана', 'Татьяна', 'Анна', 'Юлия', 'Виктория'];
  var FAKE_PATR_M = ['Андреевич', 'Дмитриевич', 'Сергеевич', 'Николаевич', 'Владимирович', 'Олегович', 'Романович', 'Кириллович'];
  var FAKE_PATR_F = ['Андреевна', 'Дмитриевна', 'Сергеевна', 'Николаевна', 'Владимировна', 'Олеговна', 'Романовна', 'Кирилловна'];
  var FAKE_STREETS = ['ул. Центральная', 'ул. Садовая', 'ул. Лесная', 'ул. Парковая', 'ул. Школьная', 'ул. Новая', 'ул. Полевая', 'ул. Солнечная'];
  var FAKE_CITIES = ['г. Смоленск', 'г. Тверь', 'г. Рязань', 'г. Калуга', 'г. Орёл', 'г. Курск'];

  function hashCode(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  function fakeDigits(len, seed) {
    var out = '';
    var x = seed || 42;
    for (var i = 0; i < len; i++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      out += (x % 10).toString();
    }
    return out;
  }

  /* ============ ОСНОВНАЯ ФУНКЦИЯ ============ */

  /**
   * options = {
   *   mode: 'mask' | 'pseudonym' | 'reversible',
   *   types: ['fio','address','phone',...],
   *   fioThreshold: 40,
   *   customWords: [], stopWords: []
   * }
   * Возвращает { result, matches, map, stats, persons }
   */
  function anonymize(text, options) {
    options = options || {};
    var mode = options.mode || 'mask';
    var types = options.types || Object.keys(TYPE_LABELS);
    var allMatches = [];

    /* 1. Детекторы (не-ФИО) */
    var detResult = Detectors.detectAll(text, types.filter(function (t) { return t !== 'fio'; }));
    allMatches = detResult.matches;
    var protectedSpans = detResult.protectedSpans;

    /* 2. ФИО */
    var persons = [];
    if (types.indexOf('fio') !== -1) {
      var fioResult = FioEngine.detectFio(text, {
        threshold: options.fioThreshold != null ? options.fioThreshold : 40,
        customWords: options.customWords || [],
        stopWords: options.stopWords || [],
        protectedSpans: protectedSpans
      });
      persons = fioResult.persons;
      for (var i = 0; i < fioResult.matches.length; i++) allMatches.push(fioResult.matches[i]);
    }

    /* 2c. «ФИО (Latin)» — латинская форма сразу после кириллической = та же персона.
     * Латиница может прийти как fio_lat, так и как обычное fio (fallback словаря фамилий). */
    for (var li = 0; li < allMatches.length; li++) {
      var lm2 = allMatches[li];
      var isLatin = (lm2.type === 'fio_lat') || (lm2.type === 'fio' && /^[A-Za-z .-]{5,}$/.test(lm2.text.trim()));
      if (!isLatin) continue;
      for (var fi = 0; fi < allMatches.length; fi++) {
        var fm2 = allMatches[fi];
        if (fm2.type !== 'fio' || fm2.personId == null || fm2 === lm2) continue;
        if (/^[A-Za-z .-]{5,}$/.test(fm2.text.trim())) continue; // не к латинскому
        if (lm2.start >= fm2.end && lm2.start - fm2.end <= 4) { lm2.personId = fm2.personId; break; }
      }
    }

    /* 2d. «(в девичестве — Фамилия)» — девичья фамилия относится к персоне
     * непосредственно предшествующего ФИО («И.И. Иванова (в девичестве —
     * Петрова)»). Без этого девичья фамилия прилипает к первому встречному
     * носителю фамилии (например, к представителю «Петрова Анна В.»). */
    for (var bi = 0; bi < allMatches.length; bi++) {
      var bm = allMatches[bi];
      if (bm.type !== 'fio') continue;
      var beforeBm = text.slice(Math.max(0, bm.start - 40), bm.start);
      var devM = beforeBm.match(/(?:в|до)\s+девичеств[ае]\s*[—–\-]\s*[*_]*$/);
      if (!devM) continue;
      var ctxStart = Math.max(0, bm.start - 40) + devM.index;
      var bestF = null;
      for (var fj = 0; fj < allMatches.length; fj++) {
        var fm3 = allMatches[fj];
        if (fm3.type !== 'fio' || fm3.personId == null || fm3 === bm) continue;
        if (fm3.end <= ctxStart && fm3.end >= ctxStart - 60 && (!bestF || fm3.end > bestF.end)) bestF = fm3;
      }
      if (bestF) bm.personId = bestF.personId;
    }

    /* 2e. «(Фамилия) И.И.» — висячие инициалы сразу после ФИО/скобки
     * относятся к той же персоне («- Иванова (Петрова) И.И. — 1/4 доли»).
     * Иначе инициалы у скобки остаются незамаскированными. */
    var hangRe = /(?<![А-ЯЁІЎA-Zа-яёіўa-z])([А-ЯЁІЎA-Z]\.\s*[А-ЯЁІЎA-Z]\.)(?![А-ЯЁІЎA-Za-zа-яёіў])/g;
    var hm2;
    while ((hm2 = hangRe.exec(text)) !== null) {
      var hs = hm2.index, he = hs + hm2[0].length;
      var covered = false;
      for (var ci2 = 0; ci2 < allMatches.length; ci2++) {
        var cm2 = allMatches[ci2];
        if (hs < cm2.end && he > cm2.start) { covered = true; break; }
      }
      if (covered) continue;
      var protHit = false;
      for (var pj = 0; pj < protectedSpans.length; pj++) {
        if (hs < protectedSpans[pj].end && he > protectedSpans[pj].start) { protHit = true; break; }
      }
      if (protHit) continue;
      var bestH = null;
      for (var hj = 0; hj < allMatches.length; hj++) {
        var hmm = allMatches[hj];
        if (hmm.type !== 'fio' || hmm.personId == null) continue;
        if (hmm.end <= hs && hs - hmm.end <= 3 && (!bestH || hmm.end > bestH.end)) bestH = hmm;
      }
      if (!bestH) continue;
      allMatches.push({
        start: hs, end: he, text: hm2[0], type: 'fio', score: 85,
        reason: 'инициалы после ФИО (персона #' + bestH.personId + ')',
        personId: bestH.personId
      });
    }

    /* 2b. Консолидация организаций: одна организация — один ID + повторные упоминания */
    if (types.indexOf('company') !== -1) {
      var orgGroups = {};
      var orgList = [];
      for (var oi = 0; oi < allMatches.length; oi++) {
        var om = allMatches[oi];
        if (om.type !== 'company') continue;
        // ключ: форма + имя — ООО «Весна» и АНО «Весна» разные юрлица, разные ID
        var formM = om.text.match(/^(?:страхов[а-яё]+\s+компани[а-яё]+|страхов[а-яё]+\s+организаци[а-яё]+|обществ[а-яё]+\s+с\s+(?:ограниченной|дополнительной)\s+ответственностью|медицинск[а-яё]+\s+организаци[а-яё]+|некоммерческ[а-яё]+\s+организаци[а-яё]+|[А-ЯЁІЎA-Z]{2,6})/i);
        var orgForm = formM ? formM[0].toLowerCase().replace(/\s+/g, ' ') : '';
        // имя: содержимое кавычек либо текст без короткой формы
        var nm = om.text;
        var q = nm.indexOf('«');
        var wasQuoted = q >= 0;
        nm = (wasQuoted ? nm.slice(q) : nm)
          .replace(/^(?:обществ[а-яё]+\s+с\s+(?:ограниченной|дополнительной)\s+ответственностью|страхов[а-яё]+\s+компани[а-яё]+|страхов[а-яё]+\s+организаци[а-яё]+|медицинск[а-яё]+\s+организаци[а-яё]+|некоммерческ[а-яё]+\s+организаци[а-яё]+)\s+/i, '')
          .replace(/^(?:ооо|оао|зао|пао|нао|ао|ип|чуп|чтуп|уп|руп|куп|гуп|муп|ск|гбуз|гбу|ду|уз|тоо|сп|нп|ано|спк|фонд|тд)\s+/i, '')
          .replace(/[«»"'„“”]/g, '').trim();
        // хвост отрезаем ТОЛЬКО у безкавычечных имен и только глагольный:
        // «Google LLC приложено» → «Google LLC»; «Северная гарантия» — целиком
        if (!wasQuoted) {
          var nmWords = nm.split(/\s+/);
          while (nmWords.length > 1 &&
                 /(ло|ла|ле|ли|но|на|ны|ет|ют|ит|ат|ят|ено|ена|вше|ющ|ящ|аш|ивш)$/.test(nmWords[nmWords.length - 1])) nmWords.pop();
          nm = nmWords.join(' ');
        }
        nm = nm.toLowerCase();
        if (nm.length < 4) { om.orgId = null; continue; } // короткие имена не распространяем
        // Ключ: имя. Описательные формы (страховая компания, общество с огр.
        // ответственностью) не различают юрлица — мержим; короткие формы
        // (ООО/АНО/ИП…) различают — сплитим при конфликте (ООО «Весна» ≠ АНО «Весна»).
        var effForm = /страхов|обществ|медицинск|некоммерческ|компани|фирм|организац/i.test(orgForm) ? '' : orgForm;
        var orgKey = nm;
        if (orgGroups[orgKey] && effForm && orgGroups[orgKey].form && orgGroups[orgKey].form !== effForm) {
          orgKey = effForm + '|' + nm;
        }
        if (!orgGroups[orgKey]) {
          orgGroups[orgKey] = { id: orgList.length, name: nm, form: effForm };
          orgList.push(orgGroups[orgKey]);
        }
        om.orgId = orgGroups[orgKey].id;
      }
      // имена, встречающиеся у нескольких юрлиц («Весна» у ООО и АНО), не распространяем —
      // неоднозначное упоминание нельзя отнести к конкретной организации
      var nameCount = {};
      for (var nc = 0; nc < orgList.length; nc++) { nameCount[orgList[nc].name] = (nameCount[orgList[nc].name] || 0) + 1; }
      for (var nf = 0; nf < orgList.length; nf++) { orgList[nf].ambiguous = nameCount[orgList[nf].name] > 1; }
      // повторные упоминания: маскируем все вхождения имени в документе
      for (var gj = 0; gj < orgList.length; gj++) {
        var g = orgList[gj];
        if (g.ambiguous) continue; // имя принадлежит нескольким юрлицам — не распространяем
        var escName = g.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var reOrg = new RegExp('(?<![А-Яа-яЁёІіЎўA-Za-z])(' + escName + ')(?![А-Яа-яЁёІіЎўA-Za-z])', 'gi');
        var mo;
        while ((mo = reOrg.exec(text)) !== null) {
          var inProt = false;
          for (var ps = 0; ps < protectedSpans.length; ps++) {
            if (mo.index < protectedSpans[ps].end && mo.index + mo[0].length > protectedSpans[ps].start) { inProt = true; break; }
          }
          if (inProt) continue;
          var exists = false;
          for (var mi = 0; mi < allMatches.length; mi++) {
            if (mo.index < allMatches[mi].end && mo.index + mo[0].length > allMatches[mi].start) { exists = true; break; }
          }
          if (exists) continue;
          allMatches.push({
            start: mo.index, end: mo.index + mo[0].length, text: mo[0], type: 'company',
            score: 82, reason: 'Организация (повторное упоминание)', orgId: g.id
          });
        }
      }
    }

    /* 3. Разрешение пересечений */
    allMatches = resolveOverlaps(text, allMatches);

    /* 4. Замена */
    var replaceResult = applyReplacements(text, allMatches, mode, persons);

    /* 5. Статистика */
    var stats = {};
    for (var s = 0; s < allMatches.length; s++) {
      var t = allMatches[s].type;
      stats[t] = (stats[t] || 0) + 1;
    }

    return {
      result: replaceResult.result,
      matches: allMatches,
      map: replaceResult.map,
      stats: stats,
      persons: persons,
      protectedSpans: protectedSpans
    };
  }

  /* ============ РАЗРЕШЕНИЕ ПЕРЕСЕЧЕНИЙ ============ */
  function resolveOverlaps(text, matches) {
    // валидность координат
    matches = matches.filter(function (m) { return text.slice(m.start, m.end) === m.text; });
    matches.sort(function (a, b) {
      var pa = (TYPE_PRIORITY[a.type] || 0) * 1000 + (a.score || 0) * 10 + (a.end - a.start);
      var pb = (TYPE_PRIORITY[b.type] || 0) * 1000 + (b.score || 0) * 10 + (b.end - b.start);
      return pb - pa;
    });
    var accepted = [];
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      var conflict = false;
      for (var j = 0; j < accepted.length; j++) {
        if (m.start < accepted[j].end && m.end > accepted[j].start) { conflict = true; break; }
      }
      if (!conflict) accepted.push(m);
    }
    accepted.sort(function (a, b) { return a.start - b.start; });
    return accepted;
  }

  /* ============ ЗАМЕНА ============ */
  function applyReplacements(text, matches, mode, persons) {
    var result = '';
    var last = 0;
    var map = {};
    var counters = {};
    var personPlaceholders = {};   // personId -> placeholder или псевдоним-набор
    var orgPlaceholders = {};      // orgId -> placeholder (консистентность организаций)
    var idPlaceholders = {};       // «тип|номер» -> placeholder (один номер = один ID)
    var ID_TYPES = { inn: 1, ogrn: 1, snils: 1, unp: 1, bik: 1, card: 1, bank_account: 1, iban: 1, passport_ru: 1, passport_by: 1, personal_id_by: 1, doc: 1, polis: 1, vehicle: 1 };
    var pseudonymCache = {};

    function placeholderFor(m) {
      var label = TYPE_LABELS[m.type] || 'ДАННЫЕ';
      // Консистентность: одна персона — один номер (включая латинскую форму ФИО)
      if ((m.type === 'fio' || m.type === 'fio_lat') && m.personId != null) {
        if (personPlaceholders[m.personId]) return personPlaceholders[m.personId];
      }
      // Консистентность: одна организация — один номер
      if (m.type === 'company' && m.orgId != null) {
        if (orgPlaceholders[m.orgId]) return orgPlaceholders[m.orgId];
      }
      // Консистентность: один номер документа/реквизита — один номер маски
      if (ID_TYPES[m.type]) {
        var idKey = m.type + '|' + m.text.replace(/[^0-9A-ZА-Я]/gi, '');
        if (idPlaceholders[idKey]) return idPlaceholders[idKey];
      }
      counters[label] = (counters[label] || 0) + 1;
      var ph = '[' + label + '-' + counters[label] + ']';
      if ((m.type === 'fio' || m.type === 'fio_lat') && m.personId != null) personPlaceholders[m.personId] = ph;
      if (m.type === 'company' && m.orgId != null) orgPlaceholders[m.orgId] = ph;
      if (ID_TYPES[m.type]) idPlaceholders[m.type + '|' + m.text.replace(/[^0-9A-ZА-Я]/gi, '')] = ph;
      return ph;
    }

    var PREP_CASE = { 'с': 'ins', 'со': 'ins', 'за': 'ins', 'между': 'ins', 'к': 'dat', 'по': 'dat',
      'о': 'pre', 'об': 'pre', 'при': 'pre', 'для': 'gen', 'от': 'gen', 'до': 'gen', 'у': 'gen', 'без': 'gen', 'после': 'gen' };
    function caseHintFor(m) {
      var before = text.slice(Math.max(0, m.start - 14), m.start);
      var pm = before.match(/([а-яёіў]+)[\s]+$/i);
      if (!pm) return null;
      return PREP_CASE[pm[1].toLowerCase()] || null;
    }
    function pseudonymFor(m) {
      var key = m.type + '|' + m.text.toLowerCase();
      if (pseudonymCache[key]) return pseudonymCache[key];
      var seed = hashCode(key);
      var fake;
      switch (m.type) {
        case 'fio':
          // единый псевдоним для одной персоны: seed от леммы фамилии, а не от формы слова
          var p = (m.personId != null && persons[m.personId]) ? persons[m.personId] : null;
          var pSeed = (p && p.surname) ? hashCode('person|' + p.surname) : seed;
          fake = fakeFio(m, persons, pSeed, caseHintFor(m));
          break;
        case 'fio_lat':
          // латинская форма той же персоны: кириллический псевдоним + транслитерация,
          // чтобы «(Ivanov I.I.)» стало «(Taraskin R.D.)», а не плейсхолдером
          var pL = (m.personId != null && persons[m.personId]) ? persons[m.personId] : null;
          var pSeedL = (pL && pL.surname) ? hashCode('person|' + pL.surname) : seed;
          fake = transliterate(fakeFio(m, persons, pSeedL, caseHintFor(m)));
          break;
        case 'phone': fake = fakePhone(m.text, seed); break;
        case 'email': fake = 'user' + (seed % 9000 + 1000) + '@example.com'; break;
        case 'address': fake = fakeAddress(m.text, seed); break;
        case 'passport_ru':
          fake = fakeDigits(2, seed) + ' ' + fakeDigits(2, seed + 1) + (/№/.test(m.text) ? ' № ' : ' ') + fakeDigits(6, seed + 2);
          break;
        case 'passport_by':
          fake = ['MP', 'KB', 'PP', 'AB'][seed % 4] + (/№/.test(m.text) ? ' № ' : '') + fakeDigits(7, seed);
          break;
        case 'personal_id_by': fake = fakeDigits(7, seed) + 'X' + fakeDigits(3, seed + 1) + 'PB' + (seed % 10); break;
        case 'inn': fake = fakeDigits(m.text.replace(/\D/g, '').length, seed); break;
        case 'snils': fake = fakeDigits(3, seed) + '-' + fakeDigits(3, seed + 1) + '-' + fakeDigits(3, seed + 2) + ' ' + fakeDigits(2, seed + 3); break;
        case 'ogrn': fake = fakeDigits(m.text.replace(/\D/g, '').length, seed); break;
        case 'unp': fake = fakeDigits(9, seed); break;
        case 'kpp': fake = fakeDigits(9, seed); break;
        case 'bank_account': fake = fakeDigits(20, seed); break;
        case 'iban': fake = m.text.slice(0, 2) + fakeDigits(2, seed) + 'XXXX' + fakeDigits(16, seed + 1); break;
        case 'bik': fake = fakeDigits(9, seed); break;
        case 'card': fake = fakeDigits(4, seed) + ' ' + fakeDigits(4, seed + 1) + ' ' + fakeDigits(4, seed + 2) + ' ' + fakeDigits(4, seed + 3); break;
        case 'dob': fake = m.text.replace(/[0-9]/g, function (ch, pos) { return fakeDigits(1, seed + pos); }); break;
        case 'vehicle': fake = fakeDigits(4, seed) + ' XX-' + ((seed % 7) + 1); break;
        case 'company': fake = fakeCompany(m.text, seed); break;
        case 'money': fake = m.text; break; // суммы не псевдонимизируем
        default: fake = placeholderFor(m);
      }
      pseudonymCache[key] = fake;
      return fake;
    }

    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      result += text.slice(last, m.start);
      var replacement;
      if (mode === 'pseudonym') {
        replacement = pseudonymFor(m);
      } else {
        replacement = placeholderFor(m);
      }
      if (mode === 'reversible' || mode === 'pseudonym') {
        map[replacement] = m.text;
      }
      result += replacement;
      last = m.end;
    }
    result += text.slice(last);
    return { result: result, map: map };
  }

  /* Псевдоним ФИО с учётом пола и падежа */
  function fakeFio(m, persons, seed, caseHint) {
    var gender = 'm';
    if (m.personId != null && persons[m.personId] && persons[m.personId].gender) {
      gender = persons[m.personId].gender;
    } else {
      // определяем по словам совпадения (имя/отчество важнее фамилии)
      var parts = m.text.split(/[\s]+/);
      for (var i = 0; i < parts.length; i++) {
        var role = FioEngine.wordRole(parts[i]);
        if (role && role.gender && (role.type === 'name' || role.type === 'patronymic')) { gender = role.gender; break; }
      }
    }
    var sIdx = seed % FAKE_SURNAMES_M.length;
    var nIdx = seed % FAKE_NAMES_M.length;
    var pIdx = seed % FAKE_PATR_M.length;
    var fakeSurname = gender === 'f' ? FAKE_SURNAMES_F[sIdx] : FAKE_SURNAMES_M[sIdx];
    var fakeName = gender === 'f' ? FAKE_NAMES_F[nIdx] : FAKE_NAMES_M[nIdx];
    var fakePatr = gender === 'f' ? FAKE_PATR_F[pIdx] : FAKE_PATR_M[pIdx];

    // Склоняем псевдоним в падеж оригинала
    var parts = m.text.split(/[\s]+/);
    var outParts = [];
    var usedS = false, usedN = false, usedP = false;
    for (var j = 0; j < parts.length; j++) {
      var w = parts[j];
      // слитные инициалы «И.И.» → инициалы псевдонима
      var initPair = w.match(/^([А-ЯЁІЎA-Z])\.([А-ЯЁІЎA-Z])\.$/);
      if (initPair) {
        outParts.push(fakeName.charAt(0) + '.' + fakePatr.charAt(0) + '.');
        usedN = true; usedP = true;
        continue;
      }
      if (/^[А-ЯЁІЎA-Z]\.?$/.test(w)) {
        // инициал — заменяем на инициал псевдонима
        if (!usedN) { outParts.push(fakeName.charAt(0) + '.'); usedN = true; }
        else if (!usedP) { outParts.push(fakePatr.charAt(0) + '.'); usedP = true; }
        else outParts.push(w);
        continue;
      }
      var role = FioEngine.wordRole(w, gender);
      var type = role ? role.type : null;
      var caseName = role ? role.case : null;
      if (caseHint) {
        // несклоняемая фамилия (-ко/-енко/-их): форма не даёт падеж → берём падеж от предлога
        var an = MorphEngine.analyzeWord(w);
        var caseSet = {};
        for (var ai = 0; ai < an.length; ai++) caseSet[an[ai].case] = 1;
        if (Object.keys(caseSet).length > 3 || !caseName) caseName = caseHint;
      }
      if (!type && !usedS) type = 'surname';
      if (type === 'surname' && !usedS) {
        outParts.push(declineTo(fakeSurname, 'surname', gender, caseName));
        usedS = true;
      } else if (type === 'name' && !usedN) {
        outParts.push(declineTo(fakeName, 'name', gender, caseName));
        usedN = true;
      } else if (type === 'patronymic' && !usedP) {
        outParts.push(declineTo(fakePatr, 'patronymic', gender, caseName));
        usedP = true;
      } else if (!usedS) {
        outParts.push(declineTo(fakeSurname, 'surname', gender, caseName));
        usedS = true;
      } else if (!usedN) {
        outParts.push(declineTo(fakeName, 'name', gender, caseName));
        usedN = true;
      } else {
        outParts.push(declineTo(fakePatr, 'patronymic', gender, caseName));
        usedP = true;
      }
    }
    return outParts.join(' ');
  }

  function declineTo(lemma, type, gender, caseName) {
    var forms;
    if (type === 'surname') forms = Morph.declineSurname(lemma, gender);
    else if (type === 'name') forms = Morph.declineName(lemma, gender);
    else forms = Morph.declinePatronymic(lemma);
    return forms[caseName] || forms.nom;
  }

  /* Простая транслитерация кириллицы → латиница (для fio_lat-псевдонимов) */
  var TRANSLIT = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y',
    'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
    'х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
  };
  function transliterate(s) {
    return s.replace(/[А-ЯЁа-яё]/g, function (ch) {
      var low = ch.toLowerCase();
      var t = TRANSLIT[low] != null ? TRANSLIT[low] : ch;
      return ch === low ? t : t.charAt(0).toUpperCase() + t.slice(1);
    });
  }

  function fakePhone(orig, seed) {
    if (/^\+375/.test(orig.replace(/[\s(]/g, ''))) {
      return '+375 (' + (17 + seed % 4 * 4) + ') ' + fakeDigits(3, seed) + '-' + fakeDigits(2, seed + 1) + '-' + fakeDigits(2, seed + 2);
    }
    if (/^\+?7|^8/.test(orig.replace(/[\s(]/g, ''))) {
      return '+7 (9' + fakeDigits(2, seed) + ') ' + fakeDigits(3, seed + 1) + '-' + fakeDigits(2, seed + 2) + '-' + fakeDigits(2, seed + 3);
    }
    return fakeDigits(3, seed) + '-' + fakeDigits(2, seed + 1) + '-' + fakeDigits(2, seed + 2);
  }

  function fakeAddress(orig, seed) {
    var city = FAKE_CITIES[seed % FAKE_CITIES.length];
    var street = FAKE_STREETS[seed % FAKE_STREETS.length];
    var house = (seed % 90) + 1;
    var flat = (seed % 60) + 1;
    if (/кв/.test(orig)) return city + ', ' + street + ', д. ' + house + ', кв. ' + flat;
    return city + ', ' + street + ', д. ' + house;
  }

  function fakeCompany(orig, seed) {
    var formM = orig.match(/^(ООО|ОАО|АО|ЗАО|ПАО|ЧУП|ЧТУП|ОДО|РУП|УП|ГУ|СООО|ИП)/);
    var form = formM ? formM[1] : 'ООО';
    var names = ['Вега', 'Сатурн', 'Меридиан', 'Горизонт', 'Импульс', 'Вектор', 'Альфа', 'Орион'];
    return form + ' «' + names[seed % names.length] + '»';
  }

  /* ============ ВОССТАНОВЛЕНИЕ ============ */
  function restore(anonymizedText, map) {
    var result = anonymizedText;
    var keys = Object.keys(map).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      result = result.split(keys[i]).join(map[keys[i]]);
    }
    return result;
  }

  return {
    anonymize: anonymize,
    restore: restore,
    applyReplacements: applyReplacements,
    resolveOverlaps: resolveOverlaps,
    TYPE_LABELS: TYPE_LABELS,
    TYPE_PRIORITY: TYPE_PRIORITY
  };
}));
