/* ============================================================
 * TEST RUNNER — Метрики качества анонимизации (Node.js)
 * Запуск: node tests/run-tests.js
 * Precision — доля скрытого, что является ПД
 * Recall    — доля найденных ПД
 * F1        — гармоническое среднее
 * ============================================================ */
'use strict';

var Anonymizer = require('../js/anonymizer.js');
var TestCases = require('./test-cases.js');

// company и money — опциональные типы (в юр. документах реквизиты и суммы обычно оставляют)
var ALL_TYPES = ['fio', 'address', 'phone', 'email', 'passport_ru', 'passport_by', 'personal_id_by',
  'doc', 'inn', 'snils', 'ogrn', 'kpp', 'unp', 'bank_account', 'iban', 'bik', 'card', 'dob',
  'vehicle', 'ip', 'url', 'net'];

function norm(s) { return s.replace(/\s+/g, ' ').trim(); }

var totalTP = 0, totalFN = 0, totalFP = 0;
var failures = [];

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║   SERKO ANONYMIZE — ТЕСТЫ КАЧЕСТВА (юр. документы РФ/РБ) ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

for (var t = 0; t < TestCases.length; t++) {
  var tc = TestCases[t];
  var res = Anonymizer.anonymize(tc.text, { mode: 'mask', types: ALL_TYPES, fioThreshold: 40 });
  var out = res.result;

  var tp = 0, fn = 0, fp = 0;
  var caseFails = [];

  // Recall: каждый mustMask должен исчезнуть из результата
  for (var i = 0; i < tc.mustMask.length; i++) {
    var frag = tc.mustMask[i];
    if (out.indexOf(frag) === -1) tp++;
    else {
      fn++;
      caseFails.push('  ✗ НЕ СКРЫТО: «' + frag + '»');
    }
  }

  // Precision: каждый mustKeep должен остаться
  for (var k = 0; k < tc.mustKeep.length; k++) {
    var keep = tc.mustKeep[k];
    if (out.indexOf(keep) !== -1) {
      // ок
    } else {
      fp++;
      caseFails.push('  ✗ ЛИШНЕЕ СКРЫТО: «' + keep + '»');
    }
  }

  var recall = (tp + fn) > 0 ? tp / (tp + fn) : 1;
  var precision = (tp + fp) > 0 ? tp / (tp + fp) : 1;
  var f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

  totalTP += tp; totalFN += fn; totalFP += fp;

  var status = (fn === 0 && fp === 0) ? '✓' : '✗';
  console.log(status + ' ' + tc.name);
  console.log('    P=' + (precision * 100).toFixed(1) + '%  R=' + (recall * 100).toFixed(1) + '%  F1=' + (f1 * 100).toFixed(1) + '%  (совпадений: ' + res.matches.length + ')');
  if (caseFails.length) {
    for (var f = 0; f < caseFails.length; f++) console.log(caseFails[f]);
    failures.push({ name: tc.name, fails: caseFails });
  }
  console.log('');
}

var tRecall = (totalTP + totalFN) > 0 ? totalTP / (totalTP + totalFN) : 1;
var tPrecision = (totalTP + totalFP) > 0 ? totalTP / (totalTP + totalFP) : 1;
var tF1 = (tPrecision + tRecall) > 0 ? 2 * tPrecision * tRecall / (tPrecision + tRecall) : 0;

console.log('══════════════════════════════════════════════════════════');
console.log('ИТОГО:  P=' + (tPrecision * 100).toFixed(1) + '%  R=' + (tRecall * 100).toFixed(1) + '%  F1=' + (tF1 * 100).toFixed(1) + '%');
console.log('TP=' + totalTP + '  FN=' + totalFN + '  FP=' + totalFP);
console.log('══════════════════════════════════════════════════════════');

// Демонстрация режима псевдонимов на первом кейсе
console.log('\n--- ДЕМО: режим псевдонимов (первый документ) ---');
var demo = Anonymizer.anonymize(TestCases[0].text, { mode: 'pseudonym', types: ALL_TYPES });
console.log(demo.result.split('\n').slice(0, 6).join('\n'));

if (failures.length > 0) process.exit(1);
