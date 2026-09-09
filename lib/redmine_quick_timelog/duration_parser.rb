# frozen_string_literal: true

module RedmineQuickTimelog
  # Time-range expression parser: turns free-form input into minutes.
  #
  #   RedmineQuickTimelog::DurationParser.parse('08:22 > 12:39, 13:22 > 14:32').minutes # => 327
  #   RedmineQuickTimelog::DurationParser.to_hours('9-12, 13h30 > 17h')                 # => 6.5
  #
  # This is the server-side twin of assets/javascripts/redmine_quick_timelog_parser.js: both
  # implementations share the reference table test/fixtures/duration_cases.json,
  # checked by test/unit/duration_parser_test.rb.
  #
  # Grammar:
  #   expression := segment ( (',' | ';' | '+' | newline) segment )*
  #   segment    := term ( operator term )*
  #   operator   := '>' (time range) | '-' (duration subtraction)
  #   term       := a clock time, if the segment chains at least two terms with '>'
  #               | a duration, if the term stands alone
  #
  # The dash is ambiguous: in a segment with no other range separator, the first
  # internal dash opens a range ("9-12"); any further one subtracts a duration
  # ("9 > 17 - 1h"). A segment that opens with a dash subtracts too.
  module DurationParser
    RANGE_TOKENS = /\s*(?:-->|->|=>|>>|>|→|⟶|–|—|\.{2,})\s*/.freeze
    RANGE_WORDS  = /\s+(?:jusqu['’]?(?:a|à)|(?:a|à|au)|to|until|till)\s+/i.freeze
    DECIMAL_COMMA = /(?<![:\dh])(\d+),(\d+)(\s*(?:heures?|hours?|hrs?|h)\b)/i.freeze
    # A bare "1,5": a French-style decimal, which Redmine already knows how to read.
    # Without this guard the comma would be taken for a segment separator
    # (1 h + 5 h = 6 h).
    BARE_DECIMAL = /\A(\d+)[.,](\d+)\z/.freeze
    SEGMENT_SPLIT = /[,;+\n\r]+/.freeze
    # Exotic whitespace from a copy-paste (word processor, spreadsheet); \n and \r stay
    # segment separators and are therefore not normalized.
    UNICODE_SPACES = /[   -​    　﻿]/.freeze
    # Beyond this, the input isn't a duration any more: bounds the Float conversions.
    MAX_TOKEN_LENGTH = 40
    MAX_MINUTES = 60_000_000

    CLOCK_HM  = /\A(\d{1,2})\s*[:hH]\s*(\d{1,2})?\s*(am|pm)?\z/i.freeze
    CLOCK_MIL = /\A(\d{3,4})\s*(am|pm)?\z/i.freeze
    CLOCK_H   = /\A(\d{1,2})\s*(am|pm)?\z/i.freeze

    DUR_HM    = /\A(\d+(?:\.\d+)?)\s*(?:heures?|hours?|hrs?|h)\s*(\d{1,2})?\s*(?:minutes?|mins?|mn|m)?\z/i.freeze
    DUR_M     = /\A(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|mn|m)\z/i.freeze
    DUR_COLON = /\A(\d{1,3}):(\d{1,2})\z/.freeze
    DUR_NUM   = /\A(\d+(?:\.\d+)?)\z/.freeze

    MINUTES_PER_DAY = 24 * 60

    # Parse result. #ok? says whether the expression is usable; #error carries one of
    # the symbols :blank, :invalid_segment, :negative.
    Result = Struct.new(:ok, :minutes, :parts, :error, :token) do
      alias_method :ok?, :ok

      def hours
        minutes / 60.0
      end
    end

    class << self
      # Parses a full expression.
      # @return [Result]
      def parse(input)
        return failure(:blank) if input.nil?

        text = normalize(input)
        return failure(:blank) if text.empty?

        text = text.sub(BARE_DECIMAL) { "#{Regexp.last_match(1)}.#{Regexp.last_match(2)}" }
        text = text.gsub(DECIMAL_COMMA) { "#{Regexp.last_match(1)}.#{Regexp.last_match(2)}#{Regexp.last_match(3)}" }
        text = text.gsub(RANGE_WORDS, ' > ').gsub(RANGE_TOKENS, ' > ')

        total = 0
        parts = []

        text.split(SEGMENT_SPLIT).each do |segment|
          raw = segment.strip
          next if raw.empty?

          sign = 1
          body = raw
          if body.start_with?('-', '−')
            sign = -1
            body = body[1..-1].to_s.strip
            return failure(:invalid_segment, raw) if body.empty?
          end

          minutes, bad_token = eval_segment(body)
          return failure(:invalid_segment, bad_token || raw) if minutes.nil?

          signed = sign * minutes
          total += signed
          parts << { :label => raw, :minutes => signed }
        end

        return failure(:blank) if parts.empty?
        return failure(:negative) if total.negative?

        Result.new(true, total, parts, nil, nil)
      end

      # Shortcut: number of decimal hours, or nil if the expression is invalid.
      # @return [Float, nil]
      def to_hours(input)
        result = parse(input)
        result.ok? ? result.hours : nil
      end

      # True when the text needs to be translated by this parser: Redmine doesn't know
      # how to read it itself (String#to_hours), whereas we do. The test is exact -- a
      # pattern-based heuristic used to let "8h-12h" through and misfire on "1,5".
      def expression?(input)
        value = normalize(input)
        return false if value.empty?
        return false if redmine_readable?(value)

        parse(value).ok?
      end

      # Formats String#to_hours already understands: leave them alone.
      def redmine_readable?(value)
        value.match?(BARE_DECIMAL) || value.match?(DUR_HM) || value.match?(DUR_M) ||
          value.match?(DUR_COLON) || value.match?(DUR_NUM)
      end

      # Folds exotic whitespace back to a plain space.
      def normalize(input)
        input.to_s.gsub(UNICODE_SPACES, ' ').strip
      end

      # minutes -> "5:27"
      def to_hours_minutes(minutes)
        rounded = minutes.round
        sign = rounded.negative? ? '-' : ''
        rounded = rounded.abs
        format('%s%d:%02d', sign, rounded / 60, rounded % 60)
      end

      # minutes -> "5.45". Four decimals: Redmine sums the hours column in SQL, without
      # TimeEntry#hours' rounding to the minute; two decimals would let totals drift
      # (1:40 being stored as 1.67 h, i.e. 100.2 minutes).
      def to_decimal(minutes)
        value = format('%.4f', minutes / 60.0)
        stripped = value.sub(/\.?0+\z/, '')
        stripped.empty? ? '0' : stripped
      end

      # Renders minutes in whatever input format Redmine's "hours" field expects.
      def format_minutes(minutes, style = nil)
        style.to_s == 'decimal' ? to_decimal(minutes) : to_hours_minutes(minutes)
      end

      # Clock time -> minutes since midnight, or nil.
      def parse_clock(token)
        hours = nil
        minutes = 0
        meridiem = nil

        if (match = CLOCK_HM.match(token))
          hours = match[1].to_i
          minutes = match[2].nil? ? 0 : match[2].to_i
          meridiem = match[3]
        elsif (match = CLOCK_MIL.match(token))
          digits = match[1]
          hours = digits[0..-3].to_i
          minutes = digits[-2..-1].to_i
          meridiem = match[2]
        elsif (match = CLOCK_H.match(token))
          hours = match[1].to_i
          meridiem = match[2]
        else
          return nil
        end

        if meridiem
          return nil if hours < 1 || hours > 12

          hours += 12 if meridiem.casecmp('pm').zero? && hours < 12
          hours = 0 if meridiem.casecmp('am').zero? && hours == 12
        end

        return nil if minutes > 59
        return nil if hours > 24 || (hours == 24 && minutes.positive?)

        hours * 60 + minutes
      end

      # Duration -> minutes, or nil.
      def parse_duration(token)
        return nil if token.to_s.length > MAX_TOKEN_LENGTH

        if (match = DUR_HM.match(token))
          return bounded(match[1].to_f * 60 + match[2].to_i)
        end
        return bounded(match[1].to_f) if (match = DUR_M.match(token))
        return match[1].to_i * 60 + match[2].to_i if (match = DUR_COLON.match(token))
        return bounded(match[1].to_f * 60) if (match = DUR_NUM.match(token))

        nil
      end

      private

      # Rejects an infinite or absurd value instead of letting Float#round raise a
      # FloatDomainError, which would surface as a 500.
      def bounded(minutes)
        return nil unless minutes.finite?
        return nil if minutes.abs > MAX_MINUTES

        minutes.round
      end

      def failure(code, token = nil)
        Result.new(false, 0, [], code, token)
      end

      # @return [Array(Integer, nil), Array(nil, String)] the segment's minutes, or nil
      #   plus the offending token
      def eval_segment(segment)
        tokens = tokenize(segment)
        return [nil, segment] if tokens.empty?

        operators = []
        terms = []
        expect_term = true

        tokens.each do |token|
          if ['>', '-'].include?(token)
            return [nil, segment] if expect_term

            operators << token
            expect_term = true
          else
            return [nil, segment] unless expect_term

            terms << token
            expect_term = false
          end
        end
        return [nil, segment] if expect_term

        # With no explicit range separator, the first dash acts as one ("9-12"). This
        # promotion is remembered: if the resulting range runs backwards ("2h - 1h"),
        # it was actually a subtraction, not an overnight range.
        promoted = false
        unless operators.include?('>')
          first = operators.index('-')
          if first
            operators[first] = '>'
            promoted = true
          end
        end

        chain = [terms.first]
        subtractions = []
        operators.each_with_index do |operator, index|
          if operator == '>'
            chain << terms[index + 1]
          else
            subtractions << terms[index + 1]
          end
        end

        if chain.size == 1
          total = parse_duration(chain.first)
          return [nil, chain.first] if total.nil?
        else
          total = chain_minutes(chain, !promoted)
          if total.nil? && promoted
            total = subtracted_chain(chain)
            return [nil, chain.find { |token| parse_duration(token).nil? } || chain.first] if total.nil?
          elsif total.nil?
            return [nil, chain.find { |token| parse_clock(token).nil? } || chain.first]
          end
        end

        subtractions.each do |token|
          minus = parse_duration(token)
          return [nil, token] if minus.nil?

          total -= minus
        end

        [total, nil]
      end

      def tokenize(segment)
        segment.split(/([>-])/).map(&:strip).reject(&:empty?)
      end

      # Sums consecutive intervals. Midnight is only crossed on an explicit range
      # separator ("22:00 > 02:00"): on a promoted dash, a backwards range signals a
      # subtraction and makes the calculation fail (wrap = false).
      def chain_minutes(tokens, wrap = true)
        stamps = tokens.map { |token| parse_clock(token) }
        return nil if stamps.any?(&:nil?)
        return nil if !wrap && stamps.each_cons(2).any? { |from, to| to < from }

        stamps.each_cons(2).sum do |from, to|
          span = to - from
          span.negative? ? span + MINUTES_PER_DAY : span
        end
      end

      # "2h - 1h", "1h30 - 30m": the first term minus the following ones.
      def subtracted_chain(tokens)
        values = tokens.map { |token| parse_duration(token) }
        return nil if values.any?(&:nil?)

        values.first - values.drop(1).sum
      end
    end
  end
end
