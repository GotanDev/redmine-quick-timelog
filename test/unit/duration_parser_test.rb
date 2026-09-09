# frozen_string_literal: true

# Tests for the time-range expression parser.
#
# Runnable two ways:
#   - inside Redmine:   rake redmine:plugins:test NAME=redmine_quick_timelog
#   - standalone:       ruby plugins/redmine_quick_timelog/test/unit/duration_parser_test.rb
#
# The reference table test/fixtures/duration_cases.json is shared with the JavaScript
# parser (test/js/parser_test.js): both implementations must produce exactly the same
# results.

require 'json'

begin
  require File.expand_path('../../../../../test/test_helper', __FILE__)
rescue LoadError
  # Running outside Redmine: plain Minitest is enough, the parser has no dependency.
  require 'minitest/autorun'
  require File.expand_path('../../../lib/redmine_quick_timelog/duration_parser', __FILE__)
end

# Outside Redmine, an oracle is provided: a faithful copy of Redmine 6.1.1's own
# String#to_hours (lib/redmine/core_ext/string/conversions.rb). Under Redmine, the real
# method is used, so the test checks actual behaviour.
unless String.method_defined?(:to_hours)
  class String
    def to_hours
      s = dup
      s.strip!
      if s =~ %r{^(\d+([.,]\d+)?)h?$}
        s = Regexp.last_match(1)
      else
        s.gsub!(%r{^(\d+):(\d+)$}) { Regexp.last_match(1).to_i + Regexp.last_match(2).to_i / 60.0 }
        s.gsub!(%r{^((\d+)\s*(h|hours?))?\s*((\d+)\s*(m|min)?)?$}i) do |m|
          if Regexp.last_match(1) || Regexp.last_match(4)
            Regexp.last_match(2).to_i + Regexp.last_match(5).to_i / 60.0
          else
            m[0]
          end
        end
      end
      s.tr!(',', '.')
      Kernel.Float(s, :exception => false)
    end
  end
end

class RedmineQuickTimelogDurationParserTest < (defined?(ActiveSupport::TestCase) ? ActiveSupport::TestCase : Minitest::Test)
  PARSER = RedmineQuickTimelog::DurationParser

  CASES = JSON.parse(
    File.read(File.expand_path('../../fixtures/duration_cases.json', __FILE__))
  )['cases'].freeze

  def test_reference_cases
    failures = []

    CASES.each do |example|
      result = PARSER.parse(example['input'])
      actual = result.ok? ? result.minutes : nil
      next if actual == example['minutes']

      failures << format('%<input>s => attendu %<expected>s, obtenu %<actual>s (%<why>s)',
                         :input => example['input'].inspect,
                         :expected => example['minutes'].inspect,
                         :actual => actual.inspect,
                         :why => example['why'])
    end

    assert_empty failures, "Failing reference cases:\n#{failures.join("\n")}"
  end

  def test_nominal_case_from_the_specification
    result = PARSER.parse('08:22 > 12:39, 13:22 > 14:32')

    assert result.ok?
    assert_equal 327, result.minutes
    assert_equal 2, result.parts.size
    assert_equal [257, 70], result.parts.map { |part| part[:minutes] }
    assert_in_delta 5.45, result.hours, 0.001
  end

  def test_hours_conversion
    assert_in_delta 5.45, PARSER.to_hours('08:22 > 12:39, 13:22 > 14:32'), 0.001
    assert_in_delta 6.5, PARSER.to_hours('9-12, 13h30 > 17h'), 0.001
    assert_nil PARSER.to_hours('n importe quoi')
  end

  def test_formatting_follows_timespan_format
    assert_equal '5:27', PARSER.format_minutes(327)
    assert_equal '5:27', PARSER.format_minutes(327, 'minutes')
    assert_equal '5.45', PARSER.format_minutes(327, 'decimal')
    assert_equal '1', PARSER.format_minutes(60, 'decimal')
    assert_equal '0', PARSER.format_minutes(0, 'decimal')
    assert_equal '0:05', PARSER.format_minutes(5)
  end

  # expression? decides whether the plugin should rewrite the "hours" field. It must
  # never touch what Redmine already knows how to read (String#to_hours), nor let
  # through an expression it can translate itself.
  def test_expression_detection
    %w[08:22>12:39 9-12 8h-12h 1h30+45m 2h-1h].each do |value|
      assert PARSER.expression?(value), "#{value} should be seen as an expression"
    end
    assert PARSER.expression?('8 to 12')

    ['5:27', '1h30', '2', '0.5', '1,5', '0,25', '45m', '2 h', '', nil].each do |value|
      refute PARSER.expression?(value), "#{value.inspect} should not be seen as an expression"
    end

    # Nor on something nobody can read: the field must be left untouched.
    ['abc', '8h > pouet', '25:00 > 26:00'].each do |value|
      refute PARSER.expression?(value), "#{value.inspect} should not be converted"
    end
  end

  # The dash is ambiguous: a range separator in "9-12", a subtraction in "2h - 1h".
  def test_dash_is_a_range_or_a_subtraction
    assert_equal 180, PARSER.parse('9-12').minutes
    assert_equal 60, PARSER.parse('2h - 1h').minutes
    assert_equal 60, PARSER.parse('1h30 - 30m').minutes
    assert_equal 180, PARSER.parse('12-9').minutes
    # Crossing midnight is still reachable with an explicit separator.
    assert_equal 240, PARSER.parse('22 > 2').minutes
  end

  # A hostile input must never raise (it would surface as a 500).
  def test_hostile_input_never_raises
    # assert_nothing_raised doesn't exist in plain Minitest: an exception would simply
    # fail the test with its own trace, which is the desired behaviour.
    ['9' * 400, "1,#{'9' * 400}", '::::', '>>>>', '-' * 50, "\u0000", 'é' * 100].each do |value|
      result = PARSER.parse(value)
      refute_nil result, "parse(#{value[0, 20].inspect}...) must return a result"
      refute result.ok?, "#{value[0, 20].inspect}... must not be accepted"
      refute PARSER.expression?(value)
    end
  end

  def test_error_reporting
    result = PARSER.parse('08:00 > 12:00, pouet')

    refute result.ok?
    assert_equal :invalid_segment, result.error
    assert_equal 'pouet', result.token

    assert_equal :blank, PARSER.parse('   ').error
    assert_equal :negative, PARSER.parse('-30m').error
  end

  def test_midnight_crossing
    assert_equal 240, PARSER.parse('22:00 > 02:00').minutes
    assert_equal 0, PARSER.parse('12:00 > 12:00').minutes
  end

  def test_clock_and_duration_units
    assert_equal 502, PARSER.parse_clock('08:22')
    assert_equal 502, PARSER.parse_clock('0822')
    assert_equal 502, PARSER.parse_clock('8h22')
    assert_nil PARSER.parse_clock('8:60')
    assert_nil PARSER.parse_clock('25:00')

    assert_equal 90, PARSER.parse_duration('1h30')
    assert_equal 90, PARSER.parse_duration('1.5h')
    assert_equal 45, PARSER.parse_duration('45m')
    assert_equal 120, PARSER.parse_duration('2')
    assert_nil PARSER.parse_duration('deux heures')
  end

  # End-to-end criterion: whatever the plugin writes into the "hours" field must read
  # back identically through Redmine. TimeEntry#hours rounds to the nearest minute
  # ((h * 60).round / 60r), so it's the minute that must be preserved, not the float.
  def test_roundtrip_through_redmine_to_hours
    failures = []

    (1..1440).each do |minutes|
      %w[minutes decimal].each do |style|
        written = PARSER.format_minutes(minutes, style)
        hours = written.to_hours
        if hours.nil?
          failures << "#{written.inspect} (#{style}) illisible par String#to_hours"
          next
        end
        back = (hours * 60).round
        failures << "#{minutes} min -> #{written.inspect} (#{style}) -> #{back} min" if back != minutes
      end
    end

    assert_empty failures.first(10), "Non-reversible conversions (#{failures.size}):\n#{failures.first(10).join("\n")}"
  end
end
