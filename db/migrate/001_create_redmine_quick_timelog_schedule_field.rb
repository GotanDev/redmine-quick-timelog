# frozen_string_literal: true

# Time-entry custom field that keeps the schedule as typed ("08:22 > 12:39,
# 13:22 > 14:32") when the entry comes from the quick-entry widget or the timer.
# TimeEntryCustomField is a global field (no notion of project or tracker): creating
# one here is not a core patch, just the normal use of Redmine's own public
# customization API, exactly as an administrator would from Administration > Custom
# fields.
class CreateRedmineQuickTimelogScheduleField < ActiveRecord::Migration[7.2]
  FIELD_NAME = 'Schedule'

  def up
    return if TimeEntryCustomField.where(:name => FIELD_NAME).exists?

    TimeEntryCustomField.create!(
      :name => FIELD_NAME,
      :field_format => 'string',
      :max_length => 191,
      :is_required => false,
      :is_filter => false,
      :searchable => false,
      :editable => true,
      :visible => true,
      :position => TimeEntryCustomField.maximum(:position).to_i + 1,
      :description => 'Time range or expression as typed ("08:22 > 12:39"), kept for reference next to the computed total.'
    )
  end

  def down
    TimeEntryCustomField.where(:name => FIELD_NAME).destroy_all
  end
end
