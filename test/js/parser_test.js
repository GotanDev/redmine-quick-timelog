/*
 * Checks that the JavaScript parser produces exactly the same results as the Ruby
 * parser on the shared reference table.
 *
 *   node plugins/redmine_quick_timelog/test/js/parser_test.js
 */
'use strict';

var path = require('path');
var fs = require('fs');

var Parser = require(path.join(__dirname, '..', '..', 'assets', 'javascripts', 'redmine_quick_timelog_parser.js'));
var fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'duration_cases.json'), 'utf8'));

var failures = [];

fixture.cases.forEach(function (example) {
  var result = Parser.parse(example.input);
  var actual = result.ok ? result.minutes : null;
  if (actual !== example.minutes) {
    failures.push(JSON.stringify(example.input) + ' => expected ' + example.minutes +
                  ', got ' + actual + ' (' + example.why + ')');
  }
});

// Formatting
[
  [Parser.format(327, 'minutes'), '5:27'],
  [Parser.format(327, 'decimal'), '5.45'],
  [Parser.format(100, 'decimal'), '1.6667'],
  [Parser.format(60, 'decimal'), '1'],
  [Parser.format(0, 'decimal'), '0'],
  [Parser.format(5, 'minutes'), '0:05']
].forEach(function (pair) {
  if (pair[0] !== pair[1]) { failures.push('format: expected ' + pair[1] + ', got ' + pair[0]); }
});

// Expression detection (called twice to check for no leftover state).
['8 to 12', '8 to 12', '08:22 > 12:39', '9-12'].forEach(function (value) {
  if (!Parser.looksLikeExpression(value)) { failures.push('expression not detected: ' + value); }
});
['8h-12h', '2h - 1h'].forEach(function (value) {
  if (!Parser.looksLikeExpression(value)) { failures.push('expression not detected: ' + value); }
});
['5:27', '1h30', '2', '0.5', '1,5', '0,25', '45m', '', 'abc'].forEach(function (value) {
  if (Parser.looksLikeExpression(value)) { failures.push('falsely detected as an expression: ' + value); }
});

// A hostile input must never raise.
['9'.repeat(400), '1,' + '9'.repeat(400), '::::', '>>>>', '-'.repeat(50), '\u0000'].forEach(function (value) {
  try { Parser.parse(value); Parser.looksLikeExpression(value); }
  catch (e) { failures.push('exception on ' + JSON.stringify(value) + ': ' + e.message); }
});

if (failures.length) {
  console.error('FAILURES (' + failures.length + '):\n' + failures.join('\n'));
  process.exit(1);
}
console.log('OK -- ' + fixture.cases.length + ' reference cases + formatting + detection');
