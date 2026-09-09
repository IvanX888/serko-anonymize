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
    vehicle: 'ГОСНОМЕР', company: 'ОРГАНИЗАЦИЯ', money: 'СУММА', ip: 'IP', url: 'URL', net: 'СЕТЬ', custom: 'СКРЫТО'
  };

  /* Приоритет типов при разрешении пересечений (больше = важнее) */
  var TYPE_PRIORITY = {
    personal_id_by: 100, passport_ru: 99, passport_by: 99, iban: 98, bank_account: 97,
    snils: 96, inn: 95, ogrn: 94, unp: 94, card: 93, email: 92, phone: 90,
    fio: 80, dob: 78, address: 70, company: 60, vehicle: 55, money: 40,
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
    var pseudonymCache = {};

    function placeholderFor(m) {
      var label = TYPE_LABELS[m.type] || 'ДАННЫЕ';
      // Консистентность: одна персона — один номер
      if (m.type === 'fio' && m.personId != null) {
        if (personPlaceholders[m.personId]) return personPlaceholders[m.personId];
      }
      counters[label] = (counters[label] || 0) + 1;
      var ph = '[' + label + '-' + counters[label] + ']';
      if (m.type === 'fio' && m.personId != null) personPlaceholders[m.personId] = ph;
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
