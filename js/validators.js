/* ============================================================
 * VALIDATORS v1 — Проверка контрольных сумм и форматов
 * ИНН (10/12), СНИЛС, ОГРН/ОГРНИП, КПП, р/с + БИК (ключевание),
 * банковская карта (Лун), УНП РБ, IBAN (ISO 13616),
 * личный номер РБ, паспорт РФ (серия/регион/год).
 * Валидация резко снижает ложные срабатывания на номерах
 * дел, договоров и прочих «похожих» числах.
 * Работает в браузере (window.Validators) и Node.js.
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Validators = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function digits(s) { return (s || '').replace(/\D/g, ''); }

  /* ---------- ИНН ---------- */
  function innChecksum(num, weights) {
    var sum = 0;
    for (var i = 0; i < weights.length; i++) sum += parseInt(num[i], 10) * weights[i];
    return (sum % 11) % 10;
  }
  /** ИНН юрлица (10) или физлица/ИП (12) */
  function isValidINN(s) {
    var n = digits(s);
    if (n.length === 10) {
      return innChecksum(n, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === parseInt(n[9], 10);
    }
    if (n.length === 12) {
      var c11 = innChecksum(n, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === parseInt(n[10], 10);
      var c12 = innChecksum(n, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === parseInt(n[11], 10);
      return c11 && c12;
    }
    return false;
  }

  /* ---------- СНИЛС ---------- */
  function isValidSNILS(s) {
    var n = digits(s);
    if (n.length !== 11) return false;
    var sum = 0;
    for (var i = 0; i < 9; i++) sum += parseInt(n[i], 10) * (9 - i);
    var check;
    if (sum < 100) check = sum;
    else if (sum === 100 || sum === 101) check = 0;
    else { check = sum % 101; if (check === 100) check = 0; }
    return check === parseInt(n.slice(9), 10);
  }

  /* ---------- ОГРН / ОГРНИП ---------- */
  function isValidOGRN(s) {
    var n = digits(s);
    if (n.length === 13) {
      var rem = parseInt(n.slice(0, 12), 10) % 11; // безопасно: 12 цифр < 2^53
      return (rem % 10) === parseInt(n[12], 10);
    }
    if (n.length === 15) { // ОГРНИП
      var rem15 = bigMod(n.slice(0, 14), 13);
      return (rem15 % 10) === parseInt(n[14], 10);
    }
    return false;
  }
  function bigMod(numStr, mod) {
    var r = 0;
    for (var i = 0; i < numStr.length; i++) r = (r * 10 + parseInt(numStr[i], 10)) % mod;
    return r;
  }

  /* ---------- КПП ---------- */
  function isValidKPP(s) {
    var n = digits(s);
    if (n.length !== 9) return false;
    return /^[0-9]{4}[0-9A-ZА-Я]{2}[0-9]{3}$/.test(s.replace(/\s/g, '')) || /^[0-9]{9}$/.test(n);
  }

  /* ---------- Расчётный счёт РФ (20 цифр) + БИК (ключевание) ---------- */
  function checkAccountKey(bik, account) {
    var acc = digits(account);
    if (acc.length !== 20) return false;
    var keyStr;
    if (bik) {
      var b = digits(bik);
      if (b.length !== 9) return false;
      keyStr = b.slice(-3) + acc; // РКЦ/ГРКЦ: 0 + 5,6 разряды БИК — упрощённо
      if (b.slice(6, 8) === '00') keyStr = '0' + b.slice(4, 6) + acc;
    } else {
      keyStr = acc; // без БИК: контрольный разряд счёта (9-я цифра) проверяется по префиксу 000
      keyStr = '000' + acc;
    }
    var weights = [7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1];
    var sum = 0;
    for (var i = 0; i < keyStr.length; i++) {
      sum += (parseInt(keyStr[i], 10) * weights[i]) % 10;
    }
    return sum % 10 === 0;
  }
  function isValidBankAccount(s, bik) {
    return checkAccountKey(bik || null, s);
  }

  /* ---------- Банковская карта (алгоритм Луна) ---------- */
  function isValidCard(s) {
    var n = digits(s);
    if (n.length < 13 || n.length > 19) return false;
    var sum = 0;
    for (var i = 0; i < n.length; i++) {
      var d = parseInt(n[n.length - 1 - i], 10);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }

  /* ---------- УНП Республики Беларусь (9 цифр) ---------- */
  function isValidUNP(s) {
    var n = digits(s);
    if (n.length !== 9) return false;
    var weights = [29, 23, 19, 17, 13, 7, 5, 3];
    var sum = 0;
    for (var i = 0; i < 8; i++) sum += parseInt(n[i], 10) * weights[i];
    var check = sum % 11;
    if (check === 10) return false;
    return check === parseInt(n[8], 10);
  }

  /* ---------- IBAN (ISO 13616, mod-97) ---------- */
  function isValidIBAN(s) {
    var iban = (s || '').replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
    var rearranged = iban.slice(4) + iban.slice(0, 4);
    var numeric = '';
    for (var i = 0; i < rearranged.length; i++) {
      var ch = rearranged[i];
      if (/[A-Z]/.test(ch)) numeric += (ch.charCodeAt(0) - 55).toString();
      else numeric += ch;
    }
    return bigMod(numeric, 97) === 1;
  }
  /** IBAN Беларуси: BY + 2 контрольные + 4 буквы банка + 16 цифр/букв = 28 символов */
  function isValidIBANBY(s) {
    var iban = (s || '').replace(/\s/g, '').toUpperCase();
    if (!/^BY[0-9]{2}[A-Z]{4}[A-Z0-9]{16}$/.test(iban)) return false;
    return isValidIBAN(iban);
  }

  /* ---------- Личный (идентификационный) номер РБ ----------
   * Формат: DDMMYY X NNN PB N — напр. 3240580A001PB2 */
  function isValidPersonalIdBY(s) {
    var id = (s || '').replace(/\s/g, '').toUpperCase();
    var m = id.match(/^([0-9]{2})([0-9]{2})([0-9]{2})[0-9]([A-ZА-Я])([0-9]{3})(PB|РВ)([0-9])$/);
    if (!m) return false;
    var dd = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return false;
    return true;
  }

  /* ---------- Паспорт РФ: серия (регион + год выпуска бланка) ---------- */
  var RF_REGIONS = null;
  function rfRegions() {
    if (RF_REGIONS) return RF_REGIONS;
    RF_REGIONS = {};
    var list = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
      31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60,
      61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
      90, 91, 92, 93, 94, 95, 96, 97, 98, 99];
    for (var i = 0; i < list.length; i++) RF_REGIONS[list[i]] = true;
    return RF_REGIONS;
  }
  /** Эвристика: серия паспорта РФ XXYY — регион + год; номер 6 цифр не начинается с 00 */
  function isPlausiblePassportRU(series, number) {
    var s = digits(series), n = digits(number);
    if (s.length !== 4 || n.length !== 6) return false;
    var region = parseInt(s.slice(0, 2), 10);
    var year = parseInt(s.slice(2), 10);
    if (!rfRegions()[region]) return false;
    if (year > 30 && year < 97) return false; // год выпуска бланка 1997..2030
    if (n === '000000' || /^00/.test(n)) return false;
    return true;
  }

  /* ---------- Паспорт РБ: серия 2 буквы + 7 цифр ---------- */
  var BY_PASSPORT_SERIES = ('AB|BM|HB|KH|MP|MC|KB|PP|SP|DP|BA|BB|BC|BD|BE|BF|BG|BH|BI|BJ|BK|BL|BN|BO|BP|BQ|BR|BS|BT|BU|BV|BW|BX|BY|BZ|' +
    'MA|MB|MD|ME|MF|MG|MH|MI|MJ|MK|ML|MM|MN|MO|MQ|MR|MS|MT|MU|MV|MW|MX|MY|MZ|KA|KC|KD|KE|KF|KG|KH|KI|KJ|KK|KL|KM|KN|KO|KP|KQ|KR|KS|KT|KU|KV|KW|KX|KY|KZ').split('|');
  function isPlausiblePassportBY(series, number) {
    var s = (series || '').toUpperCase().replace(/\s/g, '');
    var n = digits(number);
    if (s.length !== 2 || n.length !== 7) return false;
    return BY_PASSPORT_SERIES.indexOf(s) !== -1 || /^[A-ZА-Я]{2}$/.test(s);
  }

  /* ---------- Госномер ТС ---------- */
  function isValidVehicleRU(s) {
    return /^[АВЕКМНОРСТУХ][0-9]{3}[АВЕКМНОРСТУХ]{2}[0-9]{2,3}$/.test((s || '').replace(/\s/g, '').toUpperCase());
  }
  function isValidVehicleBY(s) {
    return /^[0-9]{4}[A-ZА-Я]{2}-?[1-8]$/.test((s || '').replace(/\s/g, '').toUpperCase());
  }

  return {
    digits: digits,
    isValidINN: isValidINN,
    isValidSNILS: isValidSNILS,
    isValidOGRN: isValidOGRN,
    isValidKPP: isValidKPP,
    isValidBankAccount: isValidBankAccount,
    isValidCard: isValidCard,
    isValidUNP: isValidUNP,
    isValidIBAN: isValidIBAN,
    isValidIBANBY: isValidIBANBY,
    isValidPersonalIdBY: isValidPersonalIdBY,
    isPlausiblePassportRU: isPlausiblePassportRU,
    isPlausiblePassportBY: isPlausiblePassportBY,
    isValidVehicleRU: isValidVehicleRU,
    isValidVehicleBY: isValidVehicleBY
  };
}));
