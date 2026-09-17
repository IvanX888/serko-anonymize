/* ============================================================
 * DETECTORS v2 — Детекторы персональных данных (РФ + РБ)
 * Каждый детектор возвращает совпадения {start,end,text,type,score,reason,validated}.
 * - Валидация контрольных сумм (Validators) повышает score и отсекает мусор.
 * - Юридический whitelist: номера дел, статей, договоров НЕ маскуются.
 * Работает в браузере (window.Detectors) и Node.js.
 * ============================================================ */
(function (root, factory) {
  var D = (typeof module !== 'undefined' && module.exports) ? require('./dictionaries.js') : root.Dictionaries;
  var V = (typeof module !== 'undefined' && module.exports) ? require('./validators.js') : root.Validators;
  var api = factory(D, V);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Detectors = api;
}(typeof self !== 'undefined' ? self : this, function (Dict, Val) {
  'use strict';

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ============ ЮРИДИЧЕСКИЙ WHITELIST ============
   * Зоны, которые НЕ являются персональными данными. */
  var WHITELIST_PATTERNS = [
    // Номера судебных дел: 2-1234/2025, А56-12345/2024, 12-345/2025, 5к-123/25
    /(?:дел[аоу]|делом|материал[а-я]*)\s*№?\s*[А-ЯA-Z0-9]{0,4}-?[0-9]{1,6}-?[0-9]{0,6}\/[0-9]{2,4}[а-яА-Я0-9\-/.]*/gi,
    /(?<![0-9А-Яа-я])[А-ЯA-Z][0-9]{1,3}-[0-9]{1,6}\/[0-9]{4}(?![0-9])/g,
    /(?<![0-9А-Яа-я])[0-9]{1,2}[а-я]?-[0-9]{1,6}\/[0-9]{2,4}(?![0-9])/g,
    // Статьи кодексов: ст. 393 ГК РБ, ч. 2 ст. 10, п. 1.2, статья 395, ст. 131-132 ГПК РФ
    /(?<![А-Яа-яЁёІіЎў])(?:ст(?:атья|\.|атьёй|атье)|ч(?:асть|\.|астью|асти)|п(?:ункт|\.|унктом|пункта)|абз(?:ац|\.))\s*[0-9]{1,4}(?:[-–][0-9]{1,4})?(?:\.[0-9]{1,3})*(?:\s*[А-Яа-я]{0,4})?(?:\s*(?:ГК|ГПК|АПК|КоАП|УК|ТК|СК|НК|ЖК|ЗК|ВК|БК|СемК|ХПК|ПИКС|КЭО|КОБ|Закона|Кодекса)[А-Яа-я ]{0,15})?/gi,
    // Номера договоров/контрактов (контекстные)
    /(?:договор[а-я]*|контракт[а-я]*|соглашени[еяю]|доверенност[ьи]|акта?|сч[её]т[а-я]*|заявк[аие]|приказ[а-я]*|распоряжени[еяю]|постановлени[еяю]|решени[еяю]|определени[еяю]|выписк[аие]|справк[аие]|сертификат[а-я]*|лицензи[иияю]|патент[а-я]*|поручени[еяю]|накладн[аойые]+|квитанци[иияю]|заказ[а-я]*|досье|папк[аие])\s*№\s*[0-9А-ЯA-Z][0-9А-ЯA-Z\-/.]{0,24}/gi,
    // Пункты договора: п. 1.2, пункт 3.4.5
    /(?:^|[\s(])п{1,2}\.\s*[0-9]{1,3}(?:\.[0-9]{1,3}){0,3}(?![0-9])/gm,
    // Даты заседаний/номера в шапках: «г. Минск» «15 марта 2025 г.» — даты обрабатываются отдельно
    // Литеры дел в кассации: № 12-345/2025(2-123/2024)
    /(?<![0-9А-Яа-я])\([0-9]{1,3}-[0-9]{1,6}\/[0-9]{2,4}\)/g
  ];

  function computeProtectedSpans(text) {
    var spans = [];
    for (var i = 0; i < WHITELIST_PATTERNS.length; i++) {
      var re = WHITELIST_PATTERNS[i];
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(text)) !== null) {
        spans.push({ start: m.index, end: m.index + m[0].length });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
    return spans;
  }

  function inSpans(spans, start, end) {
    for (var i = 0; i < spans.length; i++) {
      if (start < spans[i].end && end > spans[i].start) return true;
    }
    return false;
  }

  /* ============ ВСПОМОГАТЕЛЬНОЕ ============ */
  function ctx(text, start, end, back, fwd) {
    return text.slice(Math.max(0, start - (back || 60)), Math.min(text.length, end + (fwd || 40)));
  }
  function hasCtx(text, start, end, re, back, fwd) {
    return re.test(ctx(text, start, end, back, fwd));
  }

  function push(out, start, end, text, type, score, reason, validated) {
    out.push({ start: start, end: end, text: text.slice(start, end), type: type, score: score, reason: reason, validated: !!validated });
  }

  /* Маскируем только чувствительную группу (число/серию), а слова-контексты
   * («паспорт», «серия», «ИНН», «р/с») оставляем в тексте. */
  function pushGroup(out, m, groupIdx, text, type, score, reason, validated) {
    var g = m[groupIdx];
    if (!g) return;
    var off = m[0].indexOf(g);
    if (off < 0) return;
    var start = m.index + off;
    push(out, start, start + g.length, text, type, score, reason, validated);
  }

  /* ============ ДЕТЕКТОРЫ ============ */

  /** Документы РФ: паспорт, ВУ, СТС, ПТС */
  function detectPassportRU(text, protectedSpans) {
    var out = [];
    var re = /(?:паспорт[а-я]*|удостоверение личности)[:\s]*(?:серия\s*)?(([0-9]{2})[\s-]?([0-9]{2})[\s,]*(?:(?:№|номер)\s*)?[0-9]{6})(?![0-9])/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      var valid = Val.isPlausiblePassportRU(m[2] + m[3], m[1].replace(/\D/g, '').slice(-6));
      pushGroup(out, m, 1, text, 'passport_ru', valid ? 98 : 85, valid ? 'Паспорт РФ (серия/регион корректны)' : 'Паспорт РФ (по контексту)', valid);
    }
    // Без слова «паспорт»: 45 06 123456 с валидной серией
    var re2 = /(?<![0-9])([0-9]{2})[\s-]([0-9]{2})[\s-]([0-9]{6})(?![0-9])/g;
    while ((m = re2.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (!Val.isPlausiblePassportRU(m[1] + m[2], m[3])) continue;
      if (!hasCtx(text, m.index, m.index + m[0].length, /паспорт|удостоверен|выдан|кем выдан|серия/i, 80, 30)) continue;
      push(out, m.index, m.index + m[0].length, text, 'passport_ru', 90, 'Паспорт РФ (валидная серия + контекст)', true);
    }
    // Водительское удостоверение / СТС / ПТС
    // v9.3: серия и номер могут разделяться «№»: «77 АА № 123456»
    var re3 = /(?:водительск(?:ое|ие|их|ого|им)?\s*(?:удостоверени[еяю]|прав[а-я]*)|СТС|ПТС|свидетельство о регистрации(?:\s+ТС)?)[:\s]*(?:№[\s]*)?([0-9]{2}[\s-]?[0-9А-ЯA-Z]{2}[\s-]?(?:№[\s]*)?[0-9]{6})/gi;
    while ((m = re3.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      pushGroup(out, m, 1, text, 'doc', 88, 'ВУ/СТС/ПТС (по контексту)', false);
    }
    // ВУ с раздельной серией: «серия 77 12 № 345678»
    var re3b = /серия\s+([0-9]{2}[\s-]+[0-9А-ЯA-Z]{2}[\s]*№[\s]*[0-9]{6})(?![0-9])/gi;
    while ((m = re3b.exec(text)) !== null) {
      var gs3 = m.index + m[0].indexOf(m[1]);
      if (inSpans(protectedSpans, gs3, gs3 + m[1].length)) continue;
      if (!hasCtx(text, m.index, m.index + m[0].length, /удостоверен|водительск|свидетельств/i, 60, 20)) continue;
      pushGroup(out, m, 1, text, 'doc', 86, 'Водительское удостоверение (серия №)', false);
    }
    // Старая числовая серия: «серия 4509 № 123456»
    var re4 = /серия\s+([0-9]{2}[\s-]?[0-9]{2}[\s]*№[\s]*[0-9]{6})(?![0-9])/gi;
    while ((m = re4.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (!hasCtx(text, m.index, m.index + m[0].length, /паспорт|удостоверен|выдан/i, 100, 40)) continue;
      pushGroup(out, m, 1, text, 'passport_ru', 88, 'Паспорт РФ (числовая серия)', false);
    }
    // Полис ОСАГО / КАСКО: «полис ОСАГО серии ХХХ № 1234567890», «КАСКО серии ААА № 9876543210»,
    // «полис е-ОСАГО № 025ЕЕ123456» (буквы в номере)
    var re5 = /(?:полис[а-я]*|КАСКО|ДМС)\s+(?:(?:[еe]-)?ОСАГО\s+)?(?:серии?\s+[А-ЯA-Z0-9]{2,4}\s+)?№[\s]*([0-9]{6,12}|[0-9]{2,4}[A-ZА-Я]{1,3}[0-9]{4,8})(?![0-9A-ZА-Я])/gi;
    while ((m = re5.exec(text)) !== null) {
      var gs = m.index + m[0].indexOf(m[1]);
      if (inSpans(protectedSpans, gs, gs + m[1].length)) continue;
      pushGroup(out, m, 1, text, 'polis', 90, 'Полис ОСАГО', false);
    }
    // Свидетельство о рождении: «свидетельство о рождении № 123456» (PII, не юр.-реф.)
    var re7 = /свидетельство о рождении[^№]{0,25}№[\s]*([0-9А-ЯA-Z-]{6,20})(?![0-9А-ЯA-Z-])/gi;
    while ((m = re7.exec(text)) !== null) {
      var gsB = m.index + m[0].indexOf(m[1]);
      if (inSpans(protectedSpans, gsB, gsB + m[1].length)) continue;
      pushGroup(out, m, 1, text, 'doc', 90, 'Свидетельство о рождении', false);
    }
    // «номер полиса 5554443333» без знака № — само слово «полис» уже контекст
    var re5c = /(?:полис[а-я]*\s+)(?:номер[а-я]*\s+)?([0-9]{9,12})(?![0-9])/gi;
    while ((m = re5c.exec(text)) !== null) {
      var gsC = m.index + m[0].indexOf(m[1]);
      if (inSpans(protectedSpans, gsC, gsC + m[1].length)) continue;
      pushGroup(out, m, 1, text, 'polis', 86, 'Полис (номер без №)', false);
    }
    // «серия УУУ № 5554443333» без слова «полис» — только с контекстом страхования
    var re6 = /серия\s+([А-ЯA-Z0-9]{2,4}[\s]*№[\s]*[0-9]{9,12})(?![0-9])/gi;
    while ((m = re6.exec(text)) !== null) {
      var gs6 = m.index + m[0].indexOf(m[1]);
      if (inSpans(protectedSpans, gs6, gs6 + m[1].length)) continue;
      if (!hasCtx(text, m.index, m.index + m[0].length, /ОСАГО|КАСКО|полис|страх/i, 60, 20)) continue;
      pushGroup(out, m, 1, text, 'polis', 86, 'Полис (серия №, по контексту)', false);
    }
    return out;
  }

  /** Документы РБ: паспорт (серия XX + 7 цифр), личный номер */
  function detectPassportBY(text, protectedSpans) {
    var out = [];
    // Личный номер: 3240580A001PB2
    var re = /(?<![0-9A-ZА-Я])([0-9]{7}[A-ZА-Я][0-9]{3}(?:PB|РВ)[0-9])(?![0-9A-ZА-Я])/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      var valid = Val.isValidPersonalIdBY(m[1]);
      push(out, m.index, m.index + m[0].length, text, 'personal_id_by', valid ? 99 : 70, valid ? 'Личный номер РБ (формат корректен)' : 'Похоже на личный номер РБ', valid);
    }
    // Паспорт РБ с контекстом: серия AB № 1234567 / AB1234567
    var re2 = /(?:паспорт[а-я]*|пашпарт[а-я]*)[^№\n]{0,30}?((?:сери[яи]\s+)?([A-ZА-Я]{2})[\s]*(?:№\s*)?[0-9]{7})(?![0-9])/gi;
    while ((m = re2.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      var valid2 = Val.isPlausiblePassportBY(m[2], m[1].replace(/\D/g, ''));
      pushGroup(out, m, 1, text, 'passport_by', valid2 ? 97 : 80, valid2 ? 'Паспорт РБ (серия корректна)' : 'Паспорт РБ (по контексту)', valid2);
    }
    // «паспортные данные: AB 1234567»
    var re3 = /(?:паспортн[а-я]+\s+данн[а-я]+|серия\s+)([A-ZА-Я]{2}[\s,]+(?:№|номер)?\s*[0-9]{7})(?![0-9])/gi;
    while ((m = re3.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      pushGroup(out, m, 1, text, 'passport_by', 88, 'Паспорт РБ (паспортные данные)', false);
    }
    return out;
  }

  /** ИНН с контрольной суммой */
  function detectINN(text, protectedSpans) {
    var out = [];
    // С контекстом «ИНН»
    var re = /ИНН[:\s]*([0-9]{10}|[0-9]{12})(?![0-9])/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      var valid = Val.isValidINN(m[1]);
      pushGroup(out, m, 1, text, 'inn', valid ? 99 : 90, valid ? 'ИНН (контрольная сумма ✓)' : 'ИНН (по контексту)', valid);
    }
    // Без контекста: только если контрольная сумма сошлась
    var re2 = /(?<![0-9])([0-9]{10}|[0-9]{12})(?![0-9])/g;
    while ((m = re2.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (!Val.isValidINN(m[1])) continue;
      if (!hasCtx(text, m.index, m.index + m[0].length, /инн|налог|реквизит|плательщик/i, 60, 30)) continue;
      push(out, m.index, m.index + m[0].length, text, 'inn', 92, 'ИНН (контрольная сумма ✓ + контекст)', true);
    }
    return out;
  }

  /** СНИЛС с контрольной суммой */
  function detectSNILS(text, protectedSpans) {
    var out = [];
    var re = /(?<![0-9])([0-9]{3}[\s-][0-9]{3}[\s-][0-9]{3}[\s-][0-9]{2})(?![0-9])/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      var valid = Val.isValidSNILS(m[1]);
      if (!valid && !hasCtx(text, m.index, m.index + m[0].length, /снилс|страхов[а-я]+\s+номер|пенсион/i, 60, 30)) continue;
      push(out, m.index, m.index + m[0].length, text, 'snils', valid ? 99 : 85, valid ? 'СНИЛС (контрольная сумма ✓)' : 'СНИЛС (по контексту)', valid);
    }
    var re2 = /СНИЛС[:\s]*([0-9]{11})(?![0-9])/gi;
    while ((m = re2.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      var valid2 = Val.isValidSNILS(m[1]);
      pushGroup(out, m, 1, text, 'snils', valid2 ? 99 : 90, valid2 ? 'СНИЛС (контрольная сумма ✓)' : 'СНИЛС (по контексту)', valid2);
    }
    return out;
  }

  /** ОГРН/ОГРНИП/КПП */
  function detectOGRN(text, protectedSpans) {
    var out = [];
    var re = /(ОГРНИП|ОГРН|КПП)[:\s]*([0-9]{9}|[0-9]{13}|[0-9]{15})(?![0-9])/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      var label = m[1].toUpperCase();
      var num = m[2], type, valid;
      if (label === 'КПП') { type = 'kpp'; valid = Val.isValidKPP(num); }
      else { type = 'ogrn'; valid = Val.isValidOGRN(num); }
      pushGroup(out, m, 2, text, type, valid ? 98 : 88, label + (valid ? ' (контрольная сумма ✓)' : ' (по контексту)'), valid);
    }
    // ОГРН без контекста — только с валидной контрольной суммой
    var re2 = /(?<![0-9])([0-9]{13}|[0-9]{15})(?![0-9])/g;
    while ((m = re2.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (!Val.isValidOGRN(m[1])) continue;
      if (!hasCtx(text, m.index, m.index + m[0].length, /огрн|егрюл|регистрац|реквизит/i, 60, 30)) continue;
      push(out, m.index, m.index + m[0].length, text, 'ogrn', 92, 'ОГРН (контрольная сумма ✓ + контекст)', true);
    }
    return out;
  }

  /** УНП Республики Беларусь */
  function detectUNP(text, protectedSpans) {
    var out = [];
    var re = /(?:УНП|UNP|уч[её]тн[а-я]+\s+номер[а-я]*\s+плательщик[а-я]*)[:\s]*([0-9]{9})(?![0-9])/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      var valid = Val.isValidUNP(m[1]);
      pushGroup(out, m, 1, text, 'unp', valid ? 99 : 90, valid ? 'УНП (контрольная сумма ✓)' : 'УНП (по контексту)', valid);
    }
    // Без контекста: валидный УНП + бухгалтерский контекст
    var re2 = /(?<![0-9])([0-9]{9})(?![0-9])/g;
    while ((m = re2.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (!Val.isValidUNP(m[1])) continue;
      if (!hasCtx(text, m.index, m.index + m[0].length, /унп|плательщик|реквизит|банковск/i, 60, 30)) continue;
      push(out, m.index, m.index + m[0].length, text, 'unp', 92, 'УНП (контрольная сумма ✓ + контекст)', true);
    }
    return out;
  }

  /** Банковские счета: р/с РФ (20 цифр + БИК), IBAN (BY и др.) */
  function detectBankAccounts(text, protectedSpans) {
    var out = [];
    // IBAN (в т.ч. BY28 XXXX ...)
    var re = /(?<![A-Z0-9])((?:BY|RU|KZ|UA|DE|GB|PL|LT|LV|EE)[0-9]{2}(?:[\s]?[A-Z0-9]{4}){3,7}[\s]?[A-Z0-9]{0,4})(?![A-Z0-9])/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      var trimmed = m[1].replace(/\s+$/, '');
      var compact = trimmed.replace(/\s/g, '');
      if (compact.length < 15 || compact.length > 34) continue;
      var valid = Val.isValidIBAN(compact);
      if (!valid && !hasCtx(text, m.index, m.index + m[0].length, /сч[её]т|iban|банк|р\/с|реквизит/i, 80, 30)) continue;
      push(out, m.index, m.index + trimmed.length, text, 'iban', valid ? 99 : 86, valid ? 'IBAN (mod-97 ✓)' : 'IBAN (по контексту)', valid);
    }
    // Расчётный счёт РФ: 20 цифр с контекстом
    var re2 = /(?:р\/с|расч[её]тн[а-я]+\s+сч[её]т|сч[её]т\s*№|корсч[её]т|к\/с|лицев[а-я]+\s+сч[её]т)[:\s]*([0-9]{20})(?![0-9])/gi;
    while ((m = re2.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      // ищем БИК рядом для ключевания
      var near = ctx(text, m.index, m.index + m[0].length, 300, 120);
      var bikM = near.match(/БИК[:\s]*([0-9]{9})/i);
      var valid = bikM ? Val.isValidBankAccount(m[1], bikM[1]) : false;
      pushGroup(out, m, 1, text, 'bank_account', valid ? 99 : 90, valid ? 'Расчётный счёт (ключевание с БИК ✓)' : 'Расчётный счёт (по контексту)', valid);
    }
    // Голый «счёт» + 20 цифр: без «№» после слова «счёт» — типичная
    // формулировка в претензиях («на счёт 4070… в Сбербанке, БИК …»).
    // 20-значные числа в документах встречаются только как банковские счета,
    // номера с «№» защищены юридическим whitelist'ом.
    var re2b = /(?:сч[её]т)[:\s]*([0-9]{20})(?![0-9])/gi;
    while ((m = re2b.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      var nearB = ctx(text, m.index, m.index + m[0].length, 300, 120);
      var bikB = nearB.match(/БИК[:\s]*([0-9]{9})/i);
      var validB = bikB ? Val.isValidBankAccount(m[1], bikB[1]) : false;
      pushGroup(out, m, 1, text, 'bank_account', validB ? 99 : 85, validB ? 'Расчётный счёт (ключевание с БИК ✓)' : 'Расчётный счёт (по контексту)', validB);
    }
    // БИК отдельно
    var re3 = /БИК[:\s]*([0-9]{9})(?![0-9])/gi;
    while ((m = re3.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      pushGroup(out, m, 1, text, 'bik', 85, 'БИК', false);
    }
    return out;
  }

  /** Банковские карты (Лун) */
  function detectCards(text, protectedSpans) {
    var out = [];
    var re = /(?<![0-9])((?:[0-9]{4}[\s-]?){3}[0-9]{4})(?![0-9])/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      var valid = Val.isValidCard(m[1]);
      if (!valid && !hasCtx(text, m.index, m.index + m[0].length, /карт[аыоеу]|карточк|visa|mastercard|мир[а-я]*|belkart|белкарт/i, 60, 30)) continue;
      push(out, m.index, m.index + m[0].length, text, 'card', valid ? 98 : 85, valid ? 'Банковская карта (Лун ✓)' : 'Банковская карта (по контексту)', valid);
    }
    var re2 = /(?:CVV|CVC)[:\s]*[0-9]{3}/gi;
    while ((m = re2.exec(text)) !== null) {
      push(out, m.index, m.index + m[0].length, text, 'card', 95, 'CVV/CVC', false);
    }
    return out;
  }

  /** Телефоны РФ и РБ */
  function detectPhones(text, protectedSpans) {
    var out = [];
    var patterns = [
      // +375 (17/25/29/33/44) XXX-XX-XX — Беларусь
      { re: /(?<![0-9+])(\+375[\s-]?\(?[0-9]{2}\)?[\s-]?[0-9]{3}[\s-]?[0-9]{2}[\s-]?[0-9]{2})(?![0-9])/g, score: 96, reason: 'Телефон РБ (+375)' },
      { re: /(?<![0-9])(80[\s-]?\(?[0-9]{2}\)?[\s-]?[0-9]{3}[\s-]?[0-9]{2}[\s-]?[0-9]{2})(?![0-9])/g, score: 90, reason: 'Телефон РБ (80)' },
      // +7 / 8 — Россия
      { re: /(?<![0-9+])(\+7[\s-]?\(?[0-9]{3}\)?[\s-]?[0-9]{3}[\s-]?[0-9]{2}[\s-]?[0-9]{2})(?![0-9])/g, score: 96, reason: 'Телефон РФ (+7)' },
      { re: /(?<![0-9])(8[\s-]?\(?[0-9]{3}\)?[\s-]?[0-9]{3}[\s-]?[0-9]{2}[\s-]?[0-9]{2})(?![0-9])/g, score: 92, reason: 'Телефон РФ (8)' },
      // +7 / 8 (XXX) XX-XX-XXX — мобильный с группировкой 2-2-3 («+7 (916) 42-32-473»)
      { re: /(?<![0-9+])(\+7[\s-]?\(?[0-9]{3}\)?[\s-]?[0-9]{2}[\s-]?[0-9]{2}[\s-]?[0-9]{3})(?![0-9])/g, score: 94, reason: 'Телефон РФ (+7, гр. 2-2-3)' },
      { re: /(?<![0-9])(8[\s-]?\(?[0-9]{3}\)?[\s-]?[0-9]{2}[\s-]?[0-9]{2}[\s-]?[0-9]{3})(?![0-9])/g, score: 90, reason: 'Телефон РФ (8, гр. 2-2-3)' },
      // (XXX) XX-XX-XXX без кода страны — только с телефонным контекстом
      { re: /(?<![0-9+])(\([0-9]{3}\)[\s-]?[0-9]{2}[\s-]?[0-9]{2}[\s-]?[0-9]{3})(?![0-9])/g, score: 85, reason: 'Телефон (скобки, гр. 2-2-3)', needCtx: /тел|телефон|звон|моб|сотов/i },
      // (017) 123-45-67 — городской РБ/РФ со скобками
      { re: /(?<![0-9+])(\([0-9]{3,5}\)[\s-]?[0-9]{3}[\s-]?[0-9]{2}[\s-]?[0-9]{2})(?![0-9])/g, score: 88, reason: 'Телефон (код в скобках)' },
      // Городской короткий: 123-45-67 — только с контекстом
      { re: /(?<![0-9])([0-9]{3}[\s-][0-9]{2}[\s-][0-9]{2})(?![0-9])/g, score: 70, reason: 'Короткий номер (нужен контекст)', needCtx: /тел|телефон|звон|контакт|моб/i }
    ];
    for (var p = 0; p < patterns.length; p++) {
      var pt = patterns[p];
      pt.re.lastIndex = 0;
      var m;
      while ((m = pt.re.exec(text)) !== null) {
        if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
        if (pt.needCtx && !hasCtx(text, m.index, m.index + m[0].length, pt.needCtx, 60, 30)) continue;
        push(out, m.index, m.index + m[0].length, text, 'phone', pt.score, pt.reason, false);
      }
    }
    return out;
  }

  /** Email */
  function detectEmails(text, protectedSpans) {
    var out = [];
    var re = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      push(out, m.index, m.index + m[0].length, text, 'email', 97, 'Email', false);
    }
    return out;
  }

  /** Даты рождения (только с контекстом) и даты документов */
  function detectDates(text, protectedSpans) {
    var out = [];
    var monthsFull = Dict.monthsFull, monthsShort = Dict.monthsShort;
    var dobCtx = /дата\s*рождения|д\s*[-.]\s*р\s*[-.]|родился|родилась|г\.?\s*р\.?(?=[\s0-9,).]|$)|года\s*рождения|д\.р\.|народзі[ўв]ся|нарадзілася/i;
    // Числовые даты с контекстом рождения
    var re = /([0-9]{1,2}[./-][0-9]{1,2}[./-](?:19|20)[0-9]{2})/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (hasCtx(text, m.index, m.index + m[0].length, dobCtx, 60, 40)) {
        push(out, m.index, m.index + m[0].length, text, 'dob', 95, 'Дата рождения (контекст)', false);
      }
    }
    // Текстовые даты: 15 марта 1985 года рождения / родился 15 марта 1985
    var re2 = new RegExp('([0-9]{1,2}[\\s]+(?:' + monthsFull + '|' + monthsShort + ')[\\s]+(?:19|20)[0-9]{2}[\\s]*(?:г(?:ода)?)?)(?![a-zа-я])', 'gi');
    while ((m = re2.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (hasCtx(text, m.index, m.index + m[0].length, dobCtx, 60, 40)) {
        push(out, m.index, m.index + m[0].length, text, 'dob', 95, 'Дата рождения (контекст)', false);
      }
    }
    // «1985 г.р.» / «1985 года рождения»
    var re3 = /([0-9]{4})[\s]*(?:г\.?\s*р\.?|года\s*рождения)/gi;
    while ((m = re3.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      push(out, m.index, m.index + m[0].length, text, 'dob', 95, 'Год рождения', false);
    }
    return out;
  }

  /** Адреса (РФ + РБ) */
  function detectAddresses(text, protectedSpans) {
    var out = [];
    var cityShort = 'г|гор|п|пос|пгт|д|дер|с|сел|ст|стан|хут|х|сл|мкр|микр|аг|агр|рп|кп';
    var streetShort = 'ул|улица|вул|вуліца|пр|просп|пр-т|проспект|пер|переулок|зав|завулак|б-р|бульвар|наб|набережная|ш|шоссе|туп|тупик|аллея|линия|проезд|тракт|пл|площадь|плошча|мкр|микр|мкрн';
    var houseShort = 'д|дом|кв|квартира|к|корп|корпус|стр|строение|оф|офис|комн|комната|эт|этаж|под|подъезд|лит|литера|пом|помещение';

    // Структурные блоки адреса
    // Продолжение города терпит перенос строки после дефиса: «г. Санкт-\r\nПетербург».
    // Слово продолжения обязано начинаться с заглавной, чтобы «проспект» в
    // «г. Москва\nпроспект Мира» не улетал в состав города.
    var cityBlock = '(?:' + cityShort + ')[.]?[\\s-]*[А-ЯЁІЎ][а-яёіўА-ЯЁІЎ-]+(?:[\\s-]+[А-ЯЁІЎ][а-яёіў-]+)?';
    var streetBlock = '(?:' + streetShort + ')[.]?[\\s-]*[А-ЯЁІЎA-Z0-9][^;,\\n]{0,35}?';
    var houseBlock = '(?:' + houseShort + ')(?:[.]\\s*|\\s+)[0-9]+[А-Яа-яA-Za-z]?(?:[/][0-9]+)?(?:[,\\s-]*(?:' + houseShort + ')[.]?[\\s]*[0-9]+[А-Яа-яA-Za-z]?){0,3}(?:[,\\s-]*лит[.]?[\\s]*[А-ЯA-Z](?![а-яa-z]))?';
    // Голый номер дома без префикса «д.»: «ул. Независимости, 1-32», «ул. Ленина, 5».
    // Исключения: годы, возраст, проценты, даты («12 мая») — рядом с улицей это не дом.
    var monthsAlt = [Dict.monthsNom, Dict.monthsShort,
      'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря']
      .filter(Boolean).join('|');
    // Имя улицы после префикса обязано начинаться с заглавной/цифры В ИСХОДНИКЕ:
    // под флагом /i класс [А-ЯЁІЎA-Z] матчит и строчные, поэтому «пр» цеплял
    // «Протокол», «Прогон», «пропуск» и ленивый мост доедал до цифр.
    function validStreetMatch(matched) {
      var mm = matched.match(/^(?:ул(?:ица)?|вул(?:іца)?|пр(?:-т|осп)?|проспект|пер(?:еулок)?|зав(?:улак)?|б-р|бульвар|наб(?:ережная)?|ш(?:оссе)?|туп(?:ик)?|аллея|линия|проезд|тракт|пл(?:ощадь|ошча)?|мкр|микр)[.]?\s*/i);
      if (!mm) return true; // матч начинается не с улицы (индекс/город) — ок
      return /^[А-ЯЁІЎA-Z0-9]/.test(matched.slice(mm[0].length));
    }
    // Глубокая проверка: СЕГМЕНТ улицы в любом месте матча должен иметь
    // заглавную/цифру после префикса в исходнике. Убивает связку
    // «голый город + “пр” внутри слова + цифры» («расходы на представителя
    // в размере 30 000», «доход бюджета штраф в размере 50»).
    function validStreetDeep(matched) {
      // NB: длинные альтернативы первыми — «проспект» иначе тенится «пр»+«осп»
      var re = /(?:проспект|ул(?:ица)?|вул(?:іца)?|пр-т|пер(?:еулок)?|зав(?:улак)?|б-р|бульвар|наб(?:ережная)?|ш(?:оссе)?|туп(?:ик)?|аллея|линия|проезд|тракт|пл(?:ощадь|ошча)?|мкр|микр|пр)[.]?[ \t]*/gi;
      var mm;
      while ((mm = re.exec(matched)) !== null) {
        var ch = matched[mm.index + mm[0].length]; // символ СРАЗУ ПОСЛЕ префикса
        // имя после префикса (ул. Ленина) ИЛИ префикс в конце имени (Невский проспект, д. 5)
        if (ch && (/[А-ЯЁІЎA-Z0-9]/.test(ch) || ch === ',' || ch === '.')) return true;
      }
      return false;
    }
    var bareHouse = '([0-9]{1,4}[А-Яа-яA-Za-z]?(?:[-/][0-9]{1,3}[А-Яа-я]?)?(?:[,\\s]+[0-9]{1,4}[А-Яа-я]?)?(?:[,\\s]+(?:эт|этаж|пом|помещ|оф|офис|комн|комната)[.]?(?:[/][а-я]+[.]?)*[\\s]*[0-9]{1,4}[А-Яа-я]?(?:[/][0-9]{1,4})?){0,2})(?![.][0-9])(?![/][0-9])(?![.,]\\s)(?![\\s.,;]*(?:г|года|год|лет|проц|%)[\\s.,;])(?!\\s*(?:' + monthsAlt + '))';
    var regionBlock = '(?:' + Dict.regions.map(esc).join('|') + ')[а-яёіў]*';
    var indexBlock = '[0-9]{6}';

    // 1. Полный адрес: индекс + регион + город + улица + дом
    var re1 = new RegExp('(?<![0-9])' + indexBlock + '[,\\s-]*(?:' + regionBlock + '[,\\s-]*)?' + cityBlock + '[,\\s-]+' + streetBlock + '[,\\s-]+' + houseBlock, 'gi');
    var m;
    while ((m = re1.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      push(out, m.index, m.index + m[0].length, text, 'address', 94, 'Адрес (полный)', false);
    }

    // Граница слова: с префиксами («г», «д», «ул»…) нельзя начинать матч
    // внутри слова — иначе «адресу» превращается в «дресу проспект…».
    // NB: флаг /i делает класс [А-ЯЁІЎ] чувствительным и к строчным буквам,
    // поэтому одного «заглавного» класса как границы недостаточно.
    var wordBoundary = '(?<![А-Яа-яЁёІіЎўA-Za-z-])';

    // Прилагательное перед префиксом улицы: «Невский проспект», «Советская ул.»
    var streetAdj = '(?:[А-ЯЁІЎ][а-яёіў]+[\\s-]+)?';

    // 2. Город + улица + дом (без индекса), с опциональным регионом.
    // Регион — прямой паттерн («X область/край/республика»), не зависит от словаря.
    var regionAny = '(?:(?:[А-ЯЁІЎ][а-яёіў-]+[\\s-]+(?:область|обл|край|округ|ао|країна|вобласць))|(?:(?:республика|респ)[\\s.]+[А-ЯЁІЎ][а-яёіў-]+))';
    // ФИАС-округ между городом и улицей: «г. Москва, вн.тер.г. муниципальный
    // округ Восточное Измайлово, ул 14-я Парковая, 8»
    var districtBlock = '(?:(?:вн\\.тер\\.г\\.|муниципальный округ|муниципальный район|городской округ|внутригородская территория|р-н|район|г\\.о\\.)[,\\s][^;,\\n]{0,60}?[,\\s]+)?';
    var re2 = new RegExp(wordBoundary + '(?:' + regionAny + '[,\\s]+)?' + '(?:' + cityBlock + '|[А-ЯЁІЎ][а-яёіў]+(?:[\\s-]+[А-ЯЁІЎ][а-яёіў-]+)?)' + '[,\\s-]+' + districtBlock + streetAdj + streetBlock + '[,\\s-]+' + '(?:' + houseBlock + '|' + bareHouse + ')', 'gi');
    while ((m = re2.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (/№/.test(m[0])) continue; // «…№ 15/2025» — номер договора, не дом
      if (!validStreetDeep(m[0])) continue; // «расходы…в размере 30 000» — не адрес
      push(out, m.index, m.index + m[0].length, text, 'address', 94, 'Адрес (город + улица + дом)', false);
    }

    // 3. Улица + дом: ул. Ленина, д. 5, кв. 10
    var re3 = new RegExp(wordBoundary + streetAdj + streetBlock + '[,\\s-]+' + '(?:' + houseBlock + '|' + bareHouse + ')', 'gi');
    while ((m = re3.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (/№/.test(m[0])) continue; // «…№ 5566» — номер чека/договора, не дом
      if (!validStreetDeep(m[0])) continue; // «на представителя в размере 30 000» — не адрес
      push(out, m.index, m.index + m[0].length, text, 'address', 89, 'Адрес (улица + дом)', false);
    }

    // 3c. Улица + дом через «№»: «ул. Ленина № 7» — только с адресным контекстом
    // (без контекста «чек №»/«договор №» отсекаются)
    var re3c = new RegExp(wordBoundary + streetAdj + streetBlock + '[,\\s-]+№[\\s]*([0-9]{1,4}[А-Яа-яA-Za-z]?)', 'gi');
    while ((m = re3c.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (!validStreetDeep(m[0])) continue; // «на представителя…» — не адрес
      if (!hasCtx(text, m.index, m.index + m[0].length, /адрес|прожива|зарегистрир|находится|зарегистрирован/i, 45, 10)) continue;
      push(out, m.index, m.index + m[0].length, text, 'address', 87, 'Адрес (улица + № дома)', false);
    }

    // 4. Адресные фразы: «проживающий по адресу: ...» — захват до точки с заглавной или конца строки
    var phrases = [
      'проживающ(?:ий|ая|ие|его|ей|их|ую|им|ей)? по адресу',
      'зарегистрирован(?:ный|ная|ные|ного|ной|ных|ным|ной|ными|ном|ной|ных)? по адресу',
      'место жительства', 'адрес регистрации', 'адрес места жительства',
      'почтовый адрес', 'фактический адрес', 'юридический адрес',
      'местонахождение', 'место пребывания', 'адрес проживания',
      'адрес постоянной регистрации', 'адрес временной регистрации',
      'зарэгістраван[а-я]* па адрасе', 'пражыва[а-я]* па адрасе', 'адрас рэгістрацыі'
    ];
    for (var i = 0; i < phrases.length; i++) {
      var re4 = new RegExp('(?:' + phrases[i] + ')[:\\s]*((?:' + indexBlock + '[,\\s-]*)?(?:' + regionAny + '[,\\s-]*)?(?:' + cityBlock + '[,\\s-]*)?(?:' + streetAdj + streetBlock + '[,\\s-]*)?' + houseBlock + ')', 'gi');
      while ((m = re4.exec(text)) !== null) {
        if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
        pushGroup(out, m, 1, text, 'address', 93, 'Адрес (по фразе-маркеру)', false);
      }
    }
    return out;
  }

  /** Госномера ТС РФ и РБ */
  function detectVehicles(text, protectedSpans) {
    var out = [];
    var re = /(?<![0-9A-ZА-Я])([0-9]{4}[\s]?[A-ZА-Я]{2}[\s-]?[1-8])(?![0-9A-ZА-Я])/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (Val.isValidVehicleBY(m[1])) push(out, m.index, m.index + m[0].length, text, 'vehicle', 92, 'Госномер РБ', true);
    }
    var re2 = /(?<![0-9A-ZА-Я])([АВЕКМНОРСТУХABEKMHOPCTYX][0-9]{3}[АВЕКМНОРСТУХABEKMHOPCTYX]{2}[0-9]{2,3})(?![0-9A-ZА-Я])/g;
    while ((m = re2.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      if (Val.isValidVehicleRU(m[1])) push(out, m.index, m.index + m[0].length, text, 'vehicle', 92, 'Госномер РФ', true);
    }
    return out;
  }

  /** Юридические лица РФ и РБ */
  function detectCompanies(text, protectedSpans) {
    var out = [];
    var forms = Dict.orgForms.join('|');
    // Форма + «Название» или Форма + Название
    // Левая граница слова обязательна: «дорогу» ≠ «ГУ», «обжаловано» ≠ «АНО»
    // Имя: либо в кавычках (закрывающая обязательна), либо до 4 слов с заглавной
    var re = new RegExp('(?<![а-яёa-zA-ZІіЎў])(?:' + forms + ')(?![а-яёa-zA-Z])[\\s]*(?:[«"\'„“]([^«»"\'“”]{1,60}?)[»"\'“”]|([А-ЯЁІЎA-Za-z][а-яёіўA-Za-zЁІЎ-]*(?:[\\s-]+[А-ЯЁІЎA-Z0-9][а-яёіўA-Za-zЁІЎ-]*){0,3}))(?=[\\s,.;:)\u2026\u2014\u2013-]|$)', 'gi');
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      // короткие формы (ГУ, НО, АНО…) — только верхний регистр
      var fm = m[0].match(/^[А-ЯЁІЎA-Z]+/);
      if (fm && fm[0].length <= 3 && fm[0] !== fm[0].toUpperCase()) continue;
      // форма без названия — не организация: «Общество с ограниченной
      // ответственностью заявило» (хвост-глагол со строчной) — пропускаем.
      // Только для БЕЗкавычечных матчей: имя в кавычках доверенное.
      if (m[0].indexOf('«') === -1 && m[0].indexOf('"') === -1) {
        var tailW = m[0].trim().split(/\s+/);
        var nameW = 0;
        for (var wi = tailW.length - 1; wi >= 0; wi--) {
          var cw = tailW[wi].replace(/^[«"'„“]+|[»"'”“]+$/g, '');
          if (/^[A-ZА-ЯЁІЎ0-9]/.test(cw) || /^[A-ZА-ЯЁІЎ]{2,5}$/.test(cw)) nameW++;
          else break;
        }
        if (nameW === 0) continue;
      }
      var full = m[0].trim();
      if (full.length < 4) continue;
      push(out, m.index, m.index + m[0].length, text, 'company', 88, 'Юр. лицо (орг. форма)', false);
    }
    // Латинские организации: «Google LLC», «Yandex Inc», «Siemens GmbH»
    var latOrgRe = /\b([A-Z][A-Za-z&.-]*(?:\s+[A-Z][A-Za-z&.-]*){0,3}\s+(?:LLC|Inc\.?|Corp\.?|Ltd\.?|GmbH|JV|Group|Holding)s?)\b/g;
    while ((m = latOrgRe.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      push(out, m.index, m.index + m[0].length, text, 'company', 88, 'Организация (латиница)', false);
    }
    // Полные формы РБ: «унитарное предприятие "Весна"»
    var fullForms = Dict.orgFormsByFull.join('|');
    var re2 = new RegExp('(?:' + fullForms + ')[\\s]*[«"\'„“]([^«»"\'“”\\n]{1,60})[»"\'“”]', 'gi');
    while ((m = re2.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      push(out, m.index, m.index + m[0].length, text, 'company', 90, 'Юр. лицо РБ (полная форма)', false);
    }
    return out;
  }

  /** Денежные суммы */
  function detectMoney(text, protectedSpans) {
    var out = [];
    var re = /(?<![0-9])([0-9]{1,3}(?:[\s\u00A0]?[0-9]{3})*(?:[.,][0-9]{2})?)(?:[\s\u00A0]*(?:руб(?:лей|ля|ь)?|₽|RUB|BYN|Br|бел\.\s*руб|USD|[$]|EUR|€|GBP|£|коп(?:еек|ейки)?))(?![a-zA-Zа-яёА-ЯЁ0-9])/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      // «00 копеек» при прописной сумме («3 200 000 (…) рублей 00 копеек») — не сумма
      var val = parseFloat(m[1].replace(/[\s\u00A0]/g, '').replace(',', '.'));
      if (!val) continue;
      push(out, m.index, m.index + m[0].length, text, 'money', 85, 'Денежная сумма', false);
    }
    return out;
  }

  /** IP / URL / MAC / GPS */
  function detectNet(text, protectedSpans) {
    var out = [];
    var patterns = [
      { re: /(?<![0-9])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?![0-9])/g, type: 'ip', score: 85, reason: 'IPv4' },
      { re: /(https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/g, type: 'url', score: 90, reason: 'URL' },
      { re: /(www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/g, type: 'url', score: 88, reason: 'URL (www)' },
      { re: /(?<![0-9A-Fa-f])((?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2})(?![0-9A-Fa-f])/g, type: 'net', score: 90, reason: 'MAC-адрес' },
      { re: /(?<![0-9.])(-?[0-9]{1,2}[.,][0-9]{4,},?\s*-?[0-9]{1,3}[.,][0-9]{4,})(?![0-9])/g, type: 'net', score: 85, reason: 'GPS-координаты' }
    ];
    for (var p = 0; p < patterns.length; p++) {
      var pt = patterns[p];
      pt.re.lastIndex = 0;
      var m;
      while ((m = pt.re.exec(text)) !== null) {
        if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
        push(out, m.index, m.index + m[0].length, text, pt.type, pt.score, pt.reason, false);
      }
    }
    return out;
  }

  /* ============ ОБЩИЙ ЗАПУСК ============ */
  /** Иностранные ФИО латиницей — только с маркером персоны (иначе это бренды и т.п.) */
  function detectLatinFio(text, protectedSpans) {
    var out = [];
    var re = /(?:свидетел[ьиа-я]*|гражданин[а-я]*|гражданка|истец|истица|ответчик|ответчица|мистер|миссис|мисс|mr|mrs|ms|miss|г-н|г-жа)\s+([A-Z][a-z]+(?:-[A-Z][a-z]+)?\s+[A-Z][a-z]+)/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (inSpans(protectedSpans, m.index, m.index + m[0].length)) continue;
      pushGroup(out, m, 1, text, 'fio_lat', 85, 'ФИО (латиница, по маркеру)', false);
    }
    return out;
  }

  var ALL_DETECTORS = {
    fio_lat: detectLatinFio,
    passport_ru: detectPassportRU,
    passport_by: detectPassportBY,
    personal_id_by: detectPassportBY, // тот же детектор
    inn: detectINN,
    snils: detectSNILS,
    ogrn: detectOGRN,
    kpp: detectOGRN,
    unp: detectUNP,
    bank_account: detectBankAccounts,
    iban: detectBankAccounts,
    bik: detectBankAccounts,
    card: detectCards,
    phone: detectPhones,
    email: detectEmails,
    dob: detectDates,
    address: detectAddresses,
    vehicle: detectVehicles,
    company: detectCompanies,
    money: detectMoney,
    ip: detectNet,
    url: detectNet,
    net: detectNet
  };

  /**
   * Запуск детекторов по активным типам.
   * activeTypes: массив типов ('inn','phone',...). 'fio' обрабатывается отдельно.
   * Возвращает { matches, protectedSpans }.
   */
  function detectAll(text, activeTypes) {
    var protectedSpans = computeProtectedSpans(text);
    var matches = [];
    var seen = {};
    var detectorsRun = {};
    for (var i = 0; i < activeTypes.length; i++) {
      var type = activeTypes[i];
      var fn = ALL_DETECTORS[type];
      if (!fn || detectorsRun[fn]) continue;
      detectorsRun[fn] = true;
      var found = fn(text, protectedSpans);
      for (var j = 0; j < found.length; j++) {
        var f = found[j];
        if (activeTypes.indexOf(f.type) === -1) continue;
        var key = f.start + ':' + f.end + ':' + f.type;
        if (seen[key]) continue;
        seen[key] = true;
        matches.push(f);
      }
    }
    return { matches: matches, protectedSpans: protectedSpans };
  }

  return {
    detectAll: detectAll,
    computeProtectedSpans: computeProtectedSpans,
    _detectors: ALL_DETECTORS
  };
}));
