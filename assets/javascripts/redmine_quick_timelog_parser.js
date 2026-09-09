/*
 * redmine_quick_timelog -- time-range expression parser.
 *
 * Translates free-form input into a number of minutes:
 *
 *   08:22 > 12:39, 13:22 > 14:32   -> 327 minutes (5:27)
 *   9-12, 13h30 > 17h, -15m        -> 435 minutes
 *   1h30 + 45m                     -> 135 minutes
 *
 * Grammar (see test/fixtures/duration_cases.json for the reference table):
 *
 *   expression := segment ( (',' | ';' | '+' | newline) segment )*
 *   segment    := term ( operator term )*
 *   operator   := '>' (range)  |  '-' (subtraction)
 *   term       := a clock time   if the segment chains at least two terms with '>'
 *               | a duration     if the term stands alone
 *
 * The '-' is ambiguous: in a segment with no other range separator, the first
 * internal '-' opens a range ("9-12"); any further one subtracts a duration
 * ("9 > 17 - 1h"). A segment that starts with '-' is a subtraction.
 *
 * The module exposes itself as a global (window.RedmineQuickTimelogParser) and as CommonJS
 * (node tests).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  root.RedmineQuickTimelogParser = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // Explicit range separators, normalized to '>'.
  var RANGE_TOKENS = /\s*(?:-->|->|=>|>>|>|→|⟶|–|—|\.{2,})\s*/g;
  // Range separators spelled out in words ("8h a 12h", "8 to 12").
  var RANGE_WORDS = /\s+(?:jusqu['’]?(?:a|à)|(?:a|à|au)|to|until|till)\s+/gi;
  // A duration's decimal comma ("1,5h"): must be protected before splitting into segments.
  var DECIMAL_COMMA = /(?<![:\dh])(\d+),(\d+)(\s*(?:heures?|hours?|hrs?|h)\b)/gi;
  // A bare "1,5": a French-style decimal, which Redmine already knows how to read.
  // Without this guard the comma would be taken for a segment separator
  // (1 h + 5 h = 6 h).
  var BARE_DECIMAL = /^(\d+)[.,](\d+)$/;
  var SEGMENT_SPLIT = /[,;+\n\r]+/;
  // Exotic whitespace from a copy-paste; \n and \r stay segment separators.
  var UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/g;
  var MAX_TOKEN_LENGTH = 40;
  var MAX_MINUTES = 60000000;

  var CLOCK_HM = /^(\d{1,2})\s*[:hH]\s*(\d{1,2})?\s*(am|pm)?$/i;
  var CLOCK_MIL = /^(\d{3,4})\s*(am|pm)?$/i;
  var CLOCK_H = /^(\d{1,2})\s*(am|pm)?$/i;

  var DUR_HM = /^(\d+(?:\.\d+)?)\s*(?:heures?|hours?|hrs?|h)\s*(\d{1,2})?\s*(?:minutes?|mins?|mn|m)?$/i;
  var DUR_M = /^(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|mn|m)$/i;
  var DUR_COLON = /^(\d{1,3}):(\d{1,2})$/;
  var DUR_NUM = /^(\d+(?:[.]\d+)?)$/;

  var MINUTES_PER_DAY = 24 * 60;

  /** Folds exotic whitespace back to a plain space. */
  function normalize(input) {
    return String(input === null || input === undefined ? '' : input).replace(UNICODE_SPACES, ' ').trim();
  }

  /** Rejects an infinite or absurd value rather than writing "NaN" into the field. */
  function bounded(minutes) {
    if (!isFinite(minutes) || Math.abs(minutes) > MAX_MINUTES) { return null; }
    return Math.round(minutes);
  }

  function fail(code, token) {
    return { ok: false, error: code, token: token === undefined ? null : token, minutes: 0, parts: [] };
  }

  /** Clock time -> minutes since midnight, or null. */
  function parseClock(token) {
    var h = null, m = 0, meridiem = null, match;

    if ((match = CLOCK_HM.exec(token))) {
      h = parseInt(match[1], 10);
      m = match[2] === undefined ? 0 : parseInt(match[2], 10);
      meridiem = match[3];
    } else if ((match = CLOCK_MIL.exec(token))) {
      var digits = match[1];
      h = parseInt(digits.slice(0, digits.length - 2), 10);
      m = parseInt(digits.slice(-2), 10);
      meridiem = match[2];
    } else if ((match = CLOCK_H.exec(token))) {
      h = parseInt(match[1], 10);
      m = 0;
      meridiem = match[2];
    } else {
      return null;
    }

    if (meridiem) {
      var lower = meridiem.toLowerCase();
      if (h < 1 || h > 12) { return null; }
      if (lower === 'pm' && h < 12) { h += 12; }
      if (lower === 'am' && h === 12) { h = 0; }
    }

    if (m > 59) { return null; }
    if (h > 24 || (h === 24 && m > 0)) { return null; }
    return h * 60 + m;
  }

  /** Duration -> minutes, or null. */
  function parseDuration(token) {
    var match;
    if (String(token).length > MAX_TOKEN_LENGTH) { return null; }

    if ((match = DUR_HM.exec(token))) {
      var mins = match[2] === undefined ? 0 : parseInt(match[2], 10);
      return bounded(parseFloat(match[1]) * 60 + mins);
    }
    if ((match = DUR_M.exec(token))) {
      return bounded(parseFloat(match[1]));
    }
    if ((match = DUR_COLON.exec(token))) {
      return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    }
    if ((match = DUR_NUM.exec(token))) {
      return bounded(parseFloat(match[1]) * 60);
    }
    return null;
  }

  /**
   * Sums the intervals of a chain of clock times. Midnight is only crossed on an
   * explicit range separator: on a promoted dash (wrap === false), a backwards range
   * signals a subtraction and makes the calculation fail.
   */
  function chainMinutes(tokens, wrap) {
    var stamps = [];
    var total = 0;
    for (var i = 0; i < tokens.length; i++) {
      var at = parseClock(tokens[i]);
      if (at === null) { return { ok: false, token: tokens[i] }; }
      stamps.push(at);
    }
    for (var j = 1; j < stamps.length; j++) {
      var span = stamps[j] - stamps[j - 1];
      if (span < 0) {
        if (wrap === false) { return { ok: false, token: tokens[j] }; }
        span += MINUTES_PER_DAY;
      }
      total += span;
    }
    return { ok: true, minutes: total };
  }

  /** "2h - 1h", "1h30 - 30m": the first term minus the following ones. */
  function subtractedChain(tokens) {
    var values = [];
    for (var i = 0; i < tokens.length; i++) {
      var value = parseDuration(tokens[i]);
      if (value === null) { return null; }
      values.push(value);
    }
    var total = values[0];
    for (var j = 1; j < values.length; j++) { total -= values[j]; }
    return total;
  }

  /** Splits a segment into [term, operator, term, ...]. */
  function tokenize(segment) {
    var parts = segment.split(/([>-])/);
    var tokens = [];
    for (var i = 0; i < parts.length; i++) {
      var value = parts[i].trim();
      if (value !== '' || parts[i] === '>' || parts[i] === '-') { tokens.push(value === '' ? parts[i] : value); }
    }
    return tokens;
  }

  /** Evaluates a segment (already normalized, with no leading sign). */
  function evalSegment(segment) {
    var tokens = tokenize(segment);
    if (!tokens.length) { return { ok: false, token: segment }; }

    var operators = [];
    var terms = [];
    var expectTerm = true;
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (token === '>' || token === '-') {
        if (expectTerm) { return { ok: false, token: segment }; }
        operators.push(token);
        expectTerm = true;
      } else {
        if (!expectTerm) { return { ok: false, token: segment }; }
        terms.push(token);
        expectTerm = false;
      }
    }
    if (expectTerm) { return { ok: false, token: segment }; }

    // With no explicit range separator, the first '-' opens a range ("9-12"). This
    // promotion is remembered: if the resulting range runs backwards ("2h - 1h"), it
    // was actually a subtraction, not an overnight range.
    var promoted = false;
    if (operators.indexOf('>') === -1) {
      var first = operators.indexOf('-');
      if (first !== -1) { operators[first] = '>'; promoted = true; }
    }

    var total = 0;
    var chain = [terms[0]];
    var subtractions = [];
    for (var k = 0; k < operators.length; k++) {
      if (operators[k] === '>') {
        chain.push(terms[k + 1]);
      } else {
        subtractions.push(terms[k + 1]);
      }
    }

    if (chain.length === 1) {
      var alone = parseDuration(chain[0]);
      if (alone === null) { return { ok: false, token: chain[0] }; }
      total = alone;
    } else {
      var chained = chainMinutes(chain, !promoted);
      if (chained.ok) {
        total = chained.minutes;
      } else if (promoted) {
        var subtracted = subtractedChain(chain);
        if (subtracted === null) { return chained; }
        total = subtracted;
      } else {
        return chained;
      }
    }

    for (var s = 0; s < subtractions.length; s++) {
      var minus = parseDuration(subtractions[s]);
      if (minus === null) { return { ok: false, token: subtractions[s] }; }
      total -= minus;
    }
    return { ok: true, minutes: total };
  }

  /**
   * Parses a full expression.
   * @returns {{ok: boolean, minutes: number, parts: Array<{label: string, minutes: number}>, error?: string, token?: string}}
   */
  function parse(input) {
    var text = normalize(input);
    if (text === '') { return fail('blank'); }

    text = text.replace(BARE_DECIMAL, '$1.$2');
    text = text.replace(DECIMAL_COMMA, '$1.$2$3');
    text = text.replace(RANGE_WORDS, ' > ');
    text = text.replace(RANGE_TOKENS, ' > ');

    var segments = text.split(SEGMENT_SPLIT);
    var total = 0;
    var parts = [];
    var seen = 0;

    for (var i = 0; i < segments.length; i++) {
      var raw = segments[i].trim();
      if (raw === '') { continue; }
      seen++;

      var sign = 1;
      var body = raw;
      if (body.charAt(0) === '-' || body.charAt(0) === '−') {
        sign = -1;
        body = body.slice(1).trim();
        if (body === '') { return fail('invalid_segment', raw); }
      }

      var result = evalSegment(body);
      if (!result.ok) { return fail('invalid_segment', result.token || raw); }

      var minutes = sign * result.minutes;
      total += minutes;
      parts.push({ label: raw, minutes: minutes });
    }

    if (!seen) { return fail('blank'); }
    if (total < 0) { return fail('negative'); }
    return { ok: true, minutes: total, parts: parts };
  }

  /** minutes -> "5:27" */
  function toHoursMinutes(minutes) {
    var rounded = Math.round(minutes);
    var sign = rounded < 0 ? '-' : '';
    rounded = Math.abs(rounded);
    var m = rounded % 60;
    return sign + Math.floor(rounded / 60) + ':' + (m < 10 ? '0' + m : String(m));
  }

  /**
   * minutes -> "5.45". Four decimals: Redmine sums the hours column in SQL, without
   * TimeEntry#hours' rounding to the minute; two decimals would let totals drift
   * (1:40 being stored as 1.67 h, i.e. 100.2 minutes).
   */
  function toDecimal(minutes) {
    return (minutes / 60).toFixed(4).replace(/\.?0+$/, '') || '0';
  }

  /** Renders minutes in whatever input format Redmine expects. */
  function format(minutes, style) {
    return style === 'decimal' ? toDecimal(minutes) : toHoursMinutes(minutes);
  }

  /** Formats String#to_hours already understands on Redmine's side: leave them alone. */
  function redmineReadable(value) {
    return BARE_DECIMAL.test(value) || DUR_HM.test(value) || DUR_M.test(value) ||
           DUR_COLON.test(value) || DUR_NUM.test(value);
  }

  /**
   * True when the text needs to be translated by this parser: Redmine doesn't know how
   * to read it itself, whereas we do. The test is exact -- a pattern-based heuristic
   * used to let "8h-12h" through and misfire on "1,5".
   */
  function looksLikeExpression(text) {
    var value = normalize(text);
    if (value === '' || redmineReadable(value)) { return false; }
    return parse(value).ok;
  }

  return {
    parse: parse,
    format: format,
    toHoursMinutes: toHoursMinutes,
    toDecimal: toDecimal,
    looksLikeExpression: looksLikeExpression,
    parseClock: parseClock,
    parseDuration: parseDuration
  };
}));
