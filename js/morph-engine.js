/* ============================================================
 * MORPH-ENGINE v2 — Движок склонения русского и белорусского языка
 * Полные парадигмы ФИО: фамилии, имена, отчества (РФ + РБ).
 * Обратный индекс «форма → лемма/тип/род/падеж» для точного
 * распознавания падежных форм и консистентной замены.
 * Работает в браузере (window.MorphEngine) и Node.js (module.exports).
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MorphEngine = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CASES = ['nom', 'gen', 'dat', 'acc', 'ins', 'pre'];
  var CASE_NAMES = {
    nom: 'nominative', gen: 'genitive', dat: 'dative',
    acc: 'accusative', ins: 'instrumental', pre: 'prepositional'
  };

  // Алфавит: русский + белорусские і, ў
  var RU_UPPER = 'А-ЯЁІЎ';
  var RU_LOWER = 'а-яёіў';

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function low(s) { return (s || '').toLowerCase(); }

  /* ============ ПАРАДИГМЫ СКЛОНЕНИЯ ============
   * Каждая парадигма: функция (stem) -> {nom,gen,dat,acc,ins,pre}
   * либо indeclinable: все формы равны слову. */

  function paradigmMaleNoun(stem) {          // Иван, Шевчук, Мюллер
    return { nom: stem, gen: stem + 'а', dat: stem + 'у', acc: stem + 'а', ins: stem + 'ом', pre: stem + 'е' };
  }
  function paradigmMaleNounSoft(stem) {      // Игорь
    return { nom: stem, gen: stem + 'я', dat: stem + 'ю', acc: stem + 'я', ins: stem + 'ем', pre: stem + 'е' };
  }
  function paradigmMaleY(stem) {             // Андрей (stem без -й)
    return { nom: stem + 'й', gen: stem + 'я', dat: stem + 'ю', acc: stem + 'я', ins: stem + 'ем', pre: stem + 'е' };
  }
  function paradigmA(stem, female) {         // Анна, Никита: stem без -а
    return {
      nom: stem + 'а', gen: stem + 'ы', dat: stem + 'е', acc: stem + 'у',
      ins: stem + (female ? 'ой' : 'ой'), pre: stem + 'е'
    };
  }
  function paradigmYa(stem) {                // Мария, Дарья: stem без -я
    return { nom: stem + 'я', gen: stem + 'и', dat: stem + 'е', acc: stem + 'ю', ins: stem + 'ей', pre: stem + 'е' };
  }
  function paradigmFemaleSoft(stem) {        // Любовь
    return { nom: stem, gen: stem + 'и', dat: stem + 'и', acc: stem, ins: stem + 'ью', pre: stem + 'и' };
  }
  function paradigmSurnameOv(stem, gender) { // Иванов/Иванова
    if (gender === 'f') {
      return { nom: stem + 'а', gen: stem + 'ой', dat: stem + 'ой', acc: stem + 'у', ins: stem + 'ой', pre: stem + 'ой' };
    }
    return { nom: stem, gen: stem + 'а', dat: stem + 'у', acc: stem + 'а', ins: stem + 'ым', pre: stem + 'е' };
  }
  function paradigmSurnameSky(stem, gender) {// Смоленский/Смоленская
    if (gender === 'f') {
      return { nom: stem + 'ая', gen: stem + 'ой', dat: stem + 'ой', acc: stem + 'ую', ins: stem + 'ой', pre: stem + 'ой' };
    }
    return { nom: stem + 'ий', gen: stem + 'ого', dat: stem + 'ому', acc: stem + 'ого', ins: stem + 'им', pre: stem + 'ом' };
  }
  function paradigmSurnameOy(stem, gender) { // Толстой/Толстая
    if (gender === 'f') {
      return { nom: stem + 'ая', gen: stem + 'ой', dat: stem + 'ой', acc: stem + 'ую', ins: stem + 'ой', pre: stem + 'ой' };
    }
    return { nom: stem + 'ой', gen: stem + 'ого', dat: stem + 'ому', acc: stem + 'ого', ins: stem + 'ым', pre: stem + 'ом' };
  }
  function paradigmIch(stem) {               // Шушкевич (муж.)
    return { nom: stem, gen: stem + 'а', dat: stem + 'у', acc: stem + 'а', ins: stem + 'ем', pre: stem + 'е' };
  }
  function paradigmEts(stem) {               // Кузнец (беглая е)
    var s = stem.slice(0, -2) + 'ц';         // Кузнец -> Кузнец
    return { nom: stem, gen: s + 'а', dat: s + 'у', acc: s + 'а', ins: s + 'ом', pre: s + 'е' };
  }
  function paradigmPatrM(stem) {             // Иванович
    return { nom: stem, gen: stem + 'а', dat: stem + 'у', acc: stem + 'а', ins: stem + 'ем', pre: stem + 'е' };
  }
  function paradigmPatrF(stem) {             // Ивановна (stem без -а)
    return { nom: stem + 'а', gen: stem + 'ы', dat: stem + 'е', acc: stem + 'у', ins: stem + 'ой', pre: stem + 'е' };
  }
  function indeclinable(word) {
    return { nom: word, gen: word, dat: word, acc: word, ins: word, pre: word };
  }

  /* Исключения и беглые гласные в именах */
  var NAME_IRREGULAR = {
    'павел': { nom: 'Павел', gen: 'Павла', dat: 'Павлу', acc: 'Павла', ins: 'Павлом', pre: 'Павле' },
    'лев':   { nom: 'Лев', gen: 'Льва', dat: 'Льву', acc: 'Льва', ins: 'Львом', pre: 'Льве' },
    'олег':  { nom: 'Олег', gen: 'Олега', dat: 'Олегу', acc: 'Олега', ins: 'Олегом', pre: 'Олеге' },
    'яков':  { nom: 'Яков', gen: 'Якова', dat: 'Якову', acc: 'Якова', ins: 'Яковом', pre: 'Якове' },
    'пётр':  { nom: 'Пётр', gen: 'Петра', dat: 'Петру', acc: 'Петра', ins: 'Петром', pre: 'Петре' },
    'петр':  { nom: 'Петр', gen: 'Петра', dat: 'Петру', acc: 'Петра', ins: 'Петром', pre: 'Петре' },
    'фёдор': { nom: 'Фёдор', gen: 'Фёдора', dat: 'Фёдору', acc: 'Фёдора', ins: 'Фёдором', pre: 'Фёдоре' },
    'николай': { nom: 'Николай', gen: 'Николая', dat: 'Николаю', acc: 'Николая', ins: 'Николаем', pre: 'Николае' },
    'любовь': { nom: 'Любовь', gen: 'Любови', dat: 'Любови', acc: 'Любовь', ins: 'Любовью', pre: 'Любови' },
    'нинель': { nom: 'Нинель', gen: 'Нинели', dat: 'Нинели', acc: 'Нинель', ins: 'Нинелью', pre: 'Нинели' },
    'раиса': { nom: 'Раиса', gen: 'Раисы', dat: 'Раисе', acc: 'Раису', ins: 'Раисой', pre: 'Раисе' }
  };

  /* ============ КЛАССИФИКАЦИЯ СЛОВА ============
   * Определяет морфологический класс фамилии/имени по форме номинатива. */

  function classifySurname(lemma, gender) {
    var w = low(lemma);
    // Несклоняемые: -ко/-енко/-ейко/-ло/-во/-со/-их/-ых/-о/-е/-и/-у/-ю
    if (/(?:енко|ейко|ько|ко|ло|во|со|но)$/.test(w)) return { cls: 'indecl', gender: gender || null };
    if (/(?:ых|их)$/.test(w)) return { cls: 'indecl', gender: null };
    if (/[оеиуюэ]$/.test(w)) return { cls: 'indecl', gender: null };
    // -ский/-цкий/-ной
    if (/(?:ский|цкий|зкий|жский|чский|шский)$/.test(w)) return { cls: 'sky', gender: gender || 'm' };
    if (/(?:ская|цкая)$/.test(w)) return { cls: 'sky', gender: 'f' };
    if (/ой$/.test(w)) return { cls: 'oy', gender: gender || 'm' };
    if (/ая$/.test(w) && gender === 'f') return { cls: 'oy', gender: 'f' };
    // -ов/-ев/-ёв/-ин/-ын
    if (/(?:ов|ев|ёв|ин|ын)$/.test(w)) return { cls: 'ov', gender: gender || 'm' };
    if (/(?:ова|ева|ёва|ина|ына)$/.test(w)) return { cls: 'ov', gender: 'f' };
    // -ич (белорусские/сербские): муж. склоняется, жен. нет
    if (/(?:вич|лич|рич|мич|тич|дич|кич|нич|пич|сич|шич|чич|зич|бич|гич|фич|хич|жич|щич)$/.test(w)) {
      return { cls: gender === 'f' ? 'indecl' : 'ich', gender: gender || 'm' };
    }
    // -ец: беглая гласная
    if (/ец$/.test(w)) return { cls: gender === 'f' ? 'indecl' : 'ets', gender: gender || 'm' };
    // -ук/-юк (украинско-белорусские): муж. склоняется, жен. нет
    if (/(?:ук|юк)$/.test(w)) return { cls: gender === 'f' ? 'indecl' : 'mnoun', gender: gender || 'm' };
    // -ь муж.
    if (/ь$/.test(w)) return { cls: gender === 'f' ? 'indecl' : 'msoft', gender: gender || 'm' };
    // Согласная на конце: муж. склоняется, жен. нет
    if (/[бвгджзйклмнпрстфхцчшщ]$/.test(w)) {
      return { cls: gender === 'f' ? 'indecl' : 'mnoun', gender: gender || 'm' };
    }
    return { cls: 'indecl', gender: null };
  }

  function declineSurname(lemma, gender) {
    var c = classifySurname(lemma, gender);
    var w = low(lemma);
    var res;
    switch (c.cls) {
      case 'ov':
        if (/(?:ова|ева|ёва|ина|ына)$/.test(w)) res = paradigmSurnameOv(w.slice(0, -1), 'f'); // лемма уже женская: Иванова
        else res = paradigmSurnameOv(w, c.gender === 'f' ? 'f' : 'm');            // муж. лемма: Иванов -> Иванова
        break;
      case 'sky':
        if (c.gender === 'f') res = paradigmSurnameSky(w.slice(0, -2), 'f');      // -ская -> -ск
        else res = paradigmSurnameSky(w.slice(0, -2), 'm');                       // -ский -> -ск
        break;
      case 'oy':
        if (/ая$/.test(w)) res = paradigmSurnameOy(w.slice(0, -2), 'f');          // лемма женская: Толстая
        else res = paradigmSurnameOy(w.slice(0, -2), c.gender === 'f' ? 'f' : 'm');
        break;
      case 'ich': res = paradigmIch(w); break;
      case 'ets': res = paradigmEts(w); break;
      case 'mnoun': res = paradigmMaleNoun(w); break;
      case 'msoft': res = paradigmMaleNounSoft(w); break;
      default: res = indeclinable(w);
    }
    var out = {};
    for (var i = 0; i < CASES.length; i++) out[CASES[i]] = cap(res[CASES[i]]);
    out.__class = c.cls; out.__gender = c.gender;
    return out;
  }

  function classifyName(lemma, gender) {
    var w = low(lemma);
    if (NAME_IRREGULAR[w]) return { cls: 'irregular' };
    if (gender === 'f') {
      if (/я$/.test(w)) return { cls: 'ya' };
      if (/а$/.test(w)) return { cls: 'a' };
      if (/ь$/.test(w)) return { cls: 'fsoft' };
      return { cls: 'indecl' };                 // женские на согласную не склоняются
    }
    if (/й$/.test(w)) return { cls: 'my' };
    if (/ь$/.test(w)) return { cls: 'msoft' };
    if (/[ая]$/.test(w)) return { cls: w.endsWith('я') ? 'ya' : 'a' }; // Никита, Саша, Илья
    if (/[оеиуэю]$/.test(w)) return { cls: 'indecl' };
    return { cls: 'mnoun' };
  }

  function declineName(lemma, gender) {
    var w = low(lemma);
    if (NAME_IRREGULAR[w]) {
      var irr = NAME_IRREGULAR[w], out = {};
      for (var i = 0; i < CASES.length; i++) out[CASES[i]] = irr[CASES[i]];
      return out;
    }
    var c = classifyName(lemma, gender);
    var res;
    switch (c.cls) {
      case 'my': res = paradigmMaleY(w.slice(0, -1)); break;
      case 'msoft': res = paradigmMaleNounSoft(w); break;
      case 'a': res = paradigmA(w.slice(0, -1), gender === 'f'); break;
      case 'ya': res = paradigmYa(w.slice(0, -1)); break;
      case 'fsoft': res = paradigmFemaleSoft(w); break;
      case 'mnoun': res = paradigmMaleNoun(w); break;
      default: res = indeclinable(w);
    }
    var out = {};
    for (var j = 0; j < CASES.length; j++) out[CASES[j]] = cap(res[CASES[j]]);
    return out;
  }

  function declinePatronymic(lemma) {
    var w = low(lemma);
    var res;
    if (/(?:овна|евна|ична|инична)$/.test(w)) res = paradigmPatrF(w.slice(0, -1));
    else res = paradigmPatrM(w);
    var out = {};
    for (var i = 0; i < CASES.length; i++) out[CASES[i]] = cap(res[CASES[i]]);
    return out;
  }

  function isPatronymicForm(word) {
    return /[а-яёіў]+(?:ович|евич|ьевич|иевич|еевич|вич|ич|овна|евна|ична|инична|ьевна|иевна|еевна|вна|улы|уулу|кызы|оглы|глы)$/i.test(word);
  }

  /* ============ ОБРАТНЫЙ ИНДЕКС СЛОВАРЕЙ ============
   * form(lower) -> [{lemma, type, gender, case}]
   * Строится один раз по словарям, запрос O(1). */

  var formIndex = null;
  var indexStats = { forms: 0, lemmas: 0 };

  function addForms(index, forms, lemma, type, gender) {
    for (var i = 0; i < CASES.length; i++) {
      var f = low(forms[CASES[i]]);
      if (!f || f.length < 2) continue;
      if (!index[f]) index[f] = [];
      // не дублируем одинаковые записи
      var dup = false;
      for (var k = 0; k < index[f].length; k++) {
        var e = index[f][k];
        if (e.lemma === lemma && e.type === type && e.gender === gender && e.case === CASES[i]) { dup = true; break; }
      }
      if (!dup) {
        index[f].push({ lemma: lemma, type: type, gender: gender, case: CASES[i] });
        indexStats.forms++;
      }
    }
  }

  /**
   * Построение индекса.
   * dict = { surnames: [..], namesM: [..], namesF: [..], patronymics: [..] }
   */
  function buildIndex(dict) {
    formIndex = {};
    indexStats = { forms: 0, lemmas: 0 };
    var i, w;

    for (i = 0; i < dict.surnames.length; i++) {
      w = dict.surnames[i];
      var cls = classifySurname(w, null);
      var genders = (cls.gender === 'f') ? ['f'] : (cls.cls === 'indecl' && cls.gender === null) ? [null] : ['m', 'f'];
      for (var g = 0; g < genders.length; g++) {
        addForms(formIndex, declineSurname(w, genders[g]), low(w), 'surname', genders[g]);
      }
      indexStats.lemmas++;
    }
    for (i = 0; i < dict.namesM.length; i++) {
      w = dict.namesM[i];
      addForms(formIndex, declineName(w, 'm'), low(w), 'name', 'm');
      indexStats.lemmas++;
    }
    for (i = 0; i < dict.namesF.length; i++) {
      w = dict.namesF[i];
      addForms(formIndex, declineName(w, 'f'), low(w), 'name', 'f');
      indexStats.lemmas++;
    }
    for (i = 0; i < dict.patronymics.length; i++) {
      w = dict.patronymics[i];
      var gender = /(?:овна|евна|ична|инична|вна|кызы)$/i.test(w) ? 'f' : 'm';
      addForms(formIndex, declinePatronymic(w), low(w), 'patronymic', gender);
      indexStats.lemmas++;
    }
    return indexStats;
  }

  /**
   * Анализ слова: возвращает массив возможных разборов
   * [{lemma, type, gender, case, source: 'dict'|'heuristic'}]
   */
  function analyzeWord(word) {
    var w = low((word || '').replace(/[^а-яёіўА-ЯЁІЎ-]/g, ''));
    if (w.length < 2) return [];
    var out = [];
    if (formIndex && formIndex[w]) {
      for (var i = 0; i < formIndex[w].length; i++) {
        var e = formIndex[w][i];
        out.push({ lemma: e.lemma, type: e.type, gender: e.gender, case: e.case, source: 'dict' });
      }
    }
    // Эвристика для слов вне словаря (редкие фамилии)
    if (out.length === 0) {
      var h = heuristicParse(w);
      if (h) out.push(h);
    }
    // Отчества распознаём всегда (даже вне словаря)
    if (isPatronymicForm(w) && !out.some(function (o) { return o.type === 'patronymic'; })) {
      var pf = patronymicParse(w);
      if (pf) out.push(pf);
    }
    return out;
  }

  /* Эвристический разбор неизвестной фамилии по окончанию */
  function heuristicParse(w) {
    var m;
    // Мужские -ов/-ев/-ин/-ын и формы
    if ((m = w.match(/^([а-яёіў]{2,}?)(ов|ев|ёв|ин|ын)$/))) {
      return { lemma: w, type: 'surname', gender: 'm', case: 'nom', source: 'heuristic' };
    }
    if ((m = w.match(/^([а-яёіў]{2,}?)(ова|ева|ёва|ина|ына)$/))) {
      return { lemma: m[1] + m[2].slice(0, -1), type: 'surname', gender: 'm', case: 'gen', source: 'heuristic' };
    }
    if ((m = w.match(/^([а-яёіў]{2,}?)(ову|еву|ёву|ину|ыну)$/))) {
      return { lemma: m[1] + m[2].slice(0, -1), type: 'surname', gender: 'm', case: 'dat', source: 'heuristic' };
    }
    if ((m = w.match(/^([а-яёіў]{2,}?)(овым|евым|ёвым|иным|ыным)$/))) {
      return { lemma: m[1] + m[2].replace(/ым$/, ''), type: 'surname', gender: 'm', case: 'ins', source: 'heuristic' };
    }
    if ((m = w.match(/^([а-яёіў]{2,}?)(ове|еве|ёве|ине|ыне)$/))) {
      return { lemma: m[1] + m[2].slice(0, -1), type: 'surname', gender: 'm', case: 'pre', source: 'heuristic' };
    }
    if ((m = w.match(/^([а-яёіў]{2,}?)(овой|евой|ёвой|иной|ыной)$/))) {
      return { lemma: m[1] + m[2].slice(0, -2) + 'а', type: 'surname', gender: 'f', case: 'gen', source: 'heuristic' };
    }
    // -ский
    if ((m = w.match(/^([а-яёіў]{2,}?)ский$/))) return { lemma: w, type: 'surname', gender: 'm', case: 'nom', source: 'heuristic' };
    if ((m = w.match(/^([а-яёіў]{2,}?)ского$/))) return { lemma: m[1] + 'ский', type: 'surname', gender: 'm', case: 'gen', source: 'heuristic' };
    if ((m = w.match(/^([а-яёіў]{2,}?)скому$/))) return { lemma: m[1] + 'ский', type: 'surname', gender: 'm', case: 'dat', source: 'heuristic' };
    if ((m = w.match(/^([а-яёіў]{2,}?)ским$/))) return { lemma: m[1] + 'ский', type: 'surname', gender: 'm', case: 'ins', source: 'heuristic' };
    if ((m = w.match(/^([а-яёіў]{2,}?)ском$/))) return { lemma: m[1] + 'ский', type: 'surname', gender: 'm', case: 'pre', source: 'heuristic' };
    if ((m = w.match(/^([а-яёіў]{2,}?)ская$/))) return { lemma: m[1] + 'ский', type: 'surname', gender: 'f', case: 'nom', source: 'heuristic' };
    if ((m = w.match(/^([а-яёіў]{2,}?)ской$/))) return { lemma: m[1] + 'ский', type: 'surname', gender: 'f', case: 'gen', source: 'heuristic' };
    if ((m = w.match(/^([а-яёіў]{2,}?)скую$/))) return { lemma: m[1] + 'ский', type: 'surname', gender: 'f', case: 'acc', source: 'heuristic' };
    // -ич мужские формы
    if ((m = w.match(/^([а-яёіў]{2,}?ич)(а|у|ем|е)$/))) {
      return { lemma: m[1], type: 'surname', gender: 'm', case: { a: 'gen', у: 'dat', ем: 'ins', е: 'pre' }[m[2]], source: 'heuristic' };
    }
    // -ук/-юк мужские формы
    if ((m = w.match(/^([а-яёіў]{2,}?(?:ук|юк))(а|у|ом|е)$/))) {
      return { lemma: m[1], type: 'surname', gender: 'm', case: { a: 'gen', у: 'dat', ом: 'ins', е: 'pre' }[m[2]], source: 'heuristic' };
    }
    // -ко/-енко — несклоняемые, но это почти наверняка фамилия
    if (/(?:енко|ейко|ько)$/.test(w) && w.length >= 5) {
      return { lemma: w, type: 'surname', gender: null, case: 'nom', source: 'heuristic' };
    }
    return null;
  }

  /* Разбор отчества: лемма = номинатив */
  function patronymicParse(w) {
    var m;
    // Мужские: -ович/-евич/-ич
    if ((m = w.match(/^([а-яёіў]{2,}?(?:ович|евич|ьевич|иевич|еевич|вич|ич))$/))) {
      return { lemma: m[1], type: 'patronymic', gender: 'm', case: 'nom', source: 'heuristic' };
    }
    if ((m = w.match(/^([а-яёіў]{2,}?(?:ович|евич|ьевич|иевич|еевич|вич|ич))(а|у|ем|е)$/))) {
      return { lemma: m[1], type: 'patronymic', gender: 'm', case: { a: 'gen', у: 'dat', ем: 'ins', е: 'pre' }[m[2]], source: 'heuristic' };
    }
    // Женские: -овна/-евна/-ична
    if ((m = w.match(/^([а-яёіў]{2,}?(?:овн|евн|ичн|иничн|вн))(а|ы|е|у|ой)$/))) {
      var caseMap = { а: 'nom', ы: 'gen', е: 'dat', у: 'acc', ой: 'ins' };
      return { lemma: m[1] + 'а', type: 'patronymic', gender: 'f', case: caseMap[m[2]], source: 'heuristic' };
    }
    return null;
  }

  /* ============ API: все формы слова ============ */

  function allForms(lemma, type, gender) {
    var forms;
    if (type === 'surname') forms = declineSurname(lemma, gender);
    else if (type === 'name') forms = declineName(lemma, gender);
    else if (type === 'patronymic') forms = declinePatronymic(lemma);
    else return [cap(lemma)];
    var out = [];
    for (var i = 0; i < CASES.length; i++) {
      if (out.indexOf(forms[CASES[i]]) === -1) out.push(forms[CASES[i]]);
    }
    return out;
  }

  /** Карта «форма(lower) -> падеж» для леммы */
  function formCaseMap(lemma, type, gender) {
    var forms;
    if (type === 'surname') forms = declineSurname(lemma, gender);
    else if (type === 'name') forms = declineName(lemma, gender);
    else if (type === 'patronymic') forms = declinePatronymic(lemma);
    else { var m0 = {}; m0[low(lemma)] = 'nom'; return m0; }
    var map = {};
    for (var i = 0; i < CASES.length; i++) {
      var f = low(forms[CASES[i]]);
      if (!map[f]) map[f] = CASES[i];
    }
    return map;
  }

  /** Определить падеж конкретной формы конкретной леммы */
  function caseOf(lemma, type, gender, form) {
    var map = formCaseMap(lemma, type, gender);
    return map[low(form)] || null;
  }

  /* Совместимость со старым API (detectCase/lemmatize/isProperNoun) */
  function detectCase(word) {
    var arr = analyzeWord(word);
    if (!arr.length) return null;
    var best = arr[0];
    return {
      type: best.type, gender: best.gender, case: CASE_NAMES[best.case] || best.case,
      base: best.lemma, ending: '', source: best.source
    };
  }

  function lemmatize(word) {
    var arr = analyzeWord(word);
    return arr.length ? cap(arr[0].lemma) : word;
  }

  function isProperNoun(word, context) {
    var arr = analyzeWord(word);
    if (arr.length) {
      var conf = arr[0].source === 'dict' ? 0.9 : 0.65;
      return { isProper: true, confidence: conf, reason: arr[0].source + ': ' + arr[0].type, morph: detectCase(word) };
    }
    if (/^[А-ЯЁІЎ][а-яёіў-]{1,29}$/.test(word)) {
      return { isProper: true, confidence: 0.35, reason: 'слово с заглавной' };
    }
    return { isProper: false, confidence: 0 };
  }

  return {
    CASES: CASES,
    RU_UPPER: RU_UPPER,
    RU_LOWER: RU_LOWER,
    classifySurname: classifySurname,
    classifyName: classifyName,
    declineSurname: declineSurname,
    declineName: declineName,
    declinePatronymic: declinePatronymic,
    isPatronymicForm: isPatronymicForm,
    buildIndex: buildIndex,
    analyzeWord: analyzeWord,
    allForms: allForms,
    formCaseMap: formCaseMap,
    caseOf: caseOf,
    detectCase: detectCase,
    lemmatize: lemmatize,
    isProperNoun: isProperNoun,
    _stats: function () { return indexStats; }
  };
}));
