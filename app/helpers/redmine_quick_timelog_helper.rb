# frozen_string_literal: true

# Helpers shared by the plugin's controller and views.
#
# The design leans on the same APIs the core time-entry form itself uses
# (Project.allowed_to, TimeEntryActivity.available_activities, TimeEntry#assignable_users,
# activity_collection_for_select_options) so that quick logging behaves exactly like the
# standard form.
module RedmineQuickTimelogHelper
  # Redmine sets include_all_helpers = false: MyController's and WelcomeController's views
  # don't have CustomFieldsHelper. We carry it along instead of adding it to core
  # controllers; all of its methods are prefixed custom_field_, so no collision is possible.
  include CustomFieldsHelper

  DEFAULT_WORKING_DAYS = %w[1 2 3 4 5].freeze

  # --- Plugin settings -----------------------------------------------------

  def redmine_quick_timelog_settings
    Setting.plugin_redmine_quick_timelog || {}
  end

  def redmine_quick_timelog_setting(key, default = nil)
    value = redmine_quick_timelog_settings[key.to_s]
    value.nil? || value.to_s.empty? ? default : value
  end

  def redmine_quick_timelog_setting?(key, default = false)
    value = redmine_quick_timelog_settings[key.to_s]
    return default if value.nil?

    %w[1 true yes on].include?(value.to_s)
  end

  # --- Projects --------------------------------------------------------------

  # Projects the current user can log time on.
  # Project.allowed_to(:log_time) already excludes archived/closed projects and requires
  # the "time tracking" module to be enabled.
  def redmine_quick_timelog_projects
    Project.allowed_to(:log_time).sorted.to_a
  end

  # Projects the user has logged time on recently: they surface at the top of the
  # selector, since that's almost always the one being looked for.
  def redmine_quick_timelog_recent_project_ids(limit = 5)
    TimeEntry.where(:user_id => User.current.id)
             .where('spent_on >= ?', User.current.today - 60)
             .group(:project_id)
             .order(Arel.sql('MAX(spent_on) DESC'))
             .limit(limit)
             .pluck(:project_id)
  rescue StandardError
    []
  end

  # A "recent projects" group followed by the full project tree.
  def redmine_quick_timelog_project_options(projects, selected_id)
    selected = projects.detect { |project| project.id == selected_id }
    recent_ids = redmine_quick_timelog_recent_project_ids
    recent = recent_ids.filter_map { |id| projects.detect { |project| project.id == id } }

    options = +''
    if recent.size > 1 || (recent.size == 1 && projects.size > 1)
      options << content_tag(:optgroup,
                             options_from_collection_for_select(recent, :id, :name, selected_id),
                             :label => l(:redmine_quick_timelog_recent_projects))
    end
    options << content_tag(:optgroup,
                           project_tree_options_for_select(projects, :selected => selected),
                           :label => l(:redmine_quick_timelog_all_projects))
    options.html_safe
  end

  # --- Remembering the last project used ------------------------------------

  # The literal project used in the last successful entry, as opposed to the "recent
  # projects" heuristic above (which ranks by recency of use over the last 60 days).
  # Stored on the generic `others` hash of UserPreference: no schema change needed.
  def redmine_quick_timelog_last_project_id
    User.current.pref[:redmine_quick_timelog_last_project_id].presence
  end

  def redmine_quick_timelog_remember_last_project(project_id)
    return if project_id.blank?

    pref = User.current.pref
    return if pref[:redmine_quick_timelog_last_project_id].to_s == project_id.to_s

    pref[:redmine_quick_timelog_last_project_id] = project_id.to_s
    pref.save
  rescue StandardError
    nil
  end

  def redmine_quick_timelog_remembered_project(projects)
    id = redmine_quick_timelog_last_project_id
    return nil unless id

    projects.detect { |project| project.id == id.to_i }
  end

  # --- Activities --------------------------------------------------------

  def redmine_quick_timelog_activities(project)
    TimeEntryActivity.available_activities(project).to_a
  end

  # Same options as the standard form, including the blank option Redmine adds when no
  # default activity exists (cf. TimelogHelper#activity_collection_for_select_options,
  # reproduced here so we don't depend on a helper missing from MyController's and
  # WelcomeController's views).
  def redmine_quick_timelog_activity_options(project, time_entry = nil)
    activities = redmine_quick_timelog_activities(project)
    options = []

    if (time_entry && time_entry.activity && !time_entry.activity.active?) ||
       activities.none? { |activity| activity.is_default }
      options << {:id => '', :name => "--- #{l(:actionview_instancetag_blank_option)} ---"}
    end

    options + activities.map { |activity| {:id => activity.id.to_s, :name => activity.name} }
  end

  # Default proposed activity: the one configured in the plugin if it exists for this
  # project, otherwise whatever Redmine itself would pick (role, project, global default).
  def redmine_quick_timelog_default_activity_id(project)
    preferred = redmine_quick_timelog_setting(:default_activity).to_s
    if preferred.present?
      match = redmine_quick_timelog_activities(project).detect { |activity| activity.name.casecmp(preferred).zero? }
      return match.id if match
    end
    TimeEntryActivity.default_activity_id(User.current, project)
  end

  # --- Required fields -----------------------------------------------------

  def redmine_quick_timelog_required_field?(name)
    Array(Setting.timelog_required_fields).include?(name.to_s)
  rescue StandardError
    false
  end

  def redmine_quick_timelog_comment_required?
    redmine_quick_timelog_setting?(:comment_required) || redmine_quick_timelog_required_field?('comments')
  end

  # --- Users ---------------------------------------------------------------

  # Users the current user can log time for on this project. Always at least the current
  # user: a <select> with no option would post user_id="" and the entry would be rejected.
  # A single entry means "the field is pointless", so the row is hidden.
  def redmine_quick_timelog_user_options(project)
    me = [{:id => User.current.id, :name => User.current.name}]
    return me unless User.current.allowed_to?(:log_time_for_other_users, project)

    time_entry = TimeEntry.new(:project => project, :author => User.current, :user => User.current)
    users = time_entry.assignable_users.map { |user| {:id => user.id, :name => user.name} }
    users.any? ? users : me
  rescue StandardError
    me
  end

  # --- Custom fields ---------------------------------------------------------

  # Renders time-entry custom fields with Redmine's own helpers, so they inherit type,
  # possible values and per-role visibility.
  def redmine_quick_timelog_custom_fields_html(time_entry)
    values = time_entry.editable_custom_field_values(User.current)
    return ''.html_safe if values.blank?

    values.map do |value|
      content_tag(:p, custom_field_tag_with_label(:time_entry, value))
    end.join.html_safe
  rescue StandardError => e
    Rails.logger.warn("redmine_quick_timelog: could not render custom fields (#{e.class}: #{e.message})")
    ''.html_safe
  end

  # --- Original schedule text -----------------------------------------------

  # Custom field (global, see db/migrate/001) that keeps the text as typed
  # ("08:22 > 12:39, 13:22 > 14:32") next to the computed total. Absent if an admin
  # removed it: it's a bonus, never something the entry itself depends on.
  def redmine_quick_timelog_schedule_custom_field
    return @redmine_quick_timelog_schedule_custom_field if defined?(@redmine_quick_timelog_schedule_custom_field)

    @redmine_quick_timelog_schedule_custom_field = TimeEntryCustomField.find_by(:name => 'Schedule')
  rescue StandardError
    @redmine_quick_timelog_schedule_custom_field = nil
  end

  # --- Working-days calendar -------------------------------------------------

  # Which ISO weekdays (1=Monday..7=Sunday) count as working days. Configurable in the
  # plugin settings; this is a plain weekday mask (Western-style Mon-Fri by default), not
  # a public-holiday calendar.
  def redmine_quick_timelog_working_days
    days = Array(redmine_quick_timelog_setting(:working_days))
    days = DEFAULT_WORKING_DAYS if days.blank?
    days.map(&:to_i)
  end

  def redmine_quick_timelog_working_day?(date)
    redmine_quick_timelog_working_days.include?(date.cwday)
  end

  def redmine_quick_timelog_highlight_missing_days?
    redmine_quick_timelog_setting?(:highlight_missing_days, false)
  end

  # --- Weekly target profile (per user) ---------------------------------------

  # A typical week: expected hours per ISO weekday, entered by the user on their own
  # account page. Stored the same way as the last-used project, via UserPreference's
  # generic `others` hash — no schema change.
  def redmine_quick_timelog_weekly_target(user = User.current)
    raw = user.pref[:redmine_quick_timelog_weekly_target]
    return nil unless raw.is_a?(Hash) && raw.present?

    raw.each_with_object({}) { |(day, hours), memo| memo[day.to_i] = hours.to_f }
  rescue StandardError
    nil
  end

  def redmine_quick_timelog_expected_hours(date, user = User.current)
    target = redmine_quick_timelog_weekly_target(user)
    return nil unless target

    target[date.cwday]
  end

  # :red    -> a target is set for that weekday and nothing at all was logged
  # :orange -> under the target, or (no target configured) a missing entry on an
  #            opted-in, highlighted working day
  # :none   -> everything else (on target, day off, feature not enabled)
  def redmine_quick_timelog_day_status(date, total_hours)
    expected = redmine_quick_timelog_expected_hours(date)
    if expected
      return :none unless expected.positive?
      return :red if total_hours.zero?
      return total_hours < expected ? :orange : :none
    end

    return :none unless redmine_quick_timelog_highlight_missing_days? && redmine_quick_timelog_working_day?(date)

    total_hours.zero? ? :orange : :none
  end

  # --- Recent entries & totals ------------------------------------------------

  # Today's entries only: the flat list under "Today" no longer depends on the history
  # setting below, which now drives the collapsible tree of days before today instead.
  def redmine_quick_timelog_recent_entries(date = nil)
    date ||= User.current.today

    TimeEntry.where(:user_id => User.current.id, :spent_on => date)
             .includes(:project, :activity, :issue => [:tracker, :status])
             .order(:id => :desc)
             .limit(25)
             .to_a
  rescue StandardError
    []
  end

  def redmine_quick_timelog_total(from, to)
    TimeEntry.where(:user_id => User.current.id, :spent_on => from..to).sum(:hours).to_f
  rescue StandardError
    0.0
  end

  def redmine_quick_timelog_day_total(date)
    redmine_quick_timelog_total(date, date)
  end

  # Week aligned on Redmine's configured first day of the week.
  def redmine_quick_timelog_week_total(date)
    start_day = Setting.start_of_week.to_s.presence || '1'
    start_day = start_day.to_i
    start_day = 1 unless (1..7).cover?(start_day)
    first_day = date - ((date.wday - (start_day % 7)) % 7)
    redmine_quick_timelog_total(first_day, first_day + 6)
  rescue StandardError
    0.0
  end

  # --- Collapsible history tree (days before today) ---------------------------

  # Day > project > activity, for the N days before today (N = the "recent_days" plugin
  # setting). A day with no entries is only included when it deserves a red/orange
  # highlight (see redmine_quick_timelog_day_status) -- otherwise weekends and days off would
  # clutter the tree for nothing.
  def redmine_quick_timelog_history_tree(days)
    days = days.to_i
    return [] if days <= 0

    today = User.current.today
    from = today - days
    to = today - 1
    return [] if from > to

    entries = TimeEntry.where(:user_id => User.current.id, :spent_on => from..to)
                        .includes(:project, :activity)
                        .to_a
    by_day = entries.group_by(&:spent_on)

    (from..to).to_a.reverse.filter_map do |date|
      day_entries = by_day[date] || []
      status = redmine_quick_timelog_day_status(date, day_entries.sum(&:hours).to_f)
      next nil if day_entries.empty? && status == :none

      {
        :date => date,
        :total => day_entries.sum(&:hours),
        :status => status,
        :projects => redmine_quick_timelog_history_projects(day_entries)
      }
    end
  rescue StandardError
    []
  end

  def redmine_quick_timelog_day_label(date)
    "#{day_name(date.cwday)} #{format_date(date)}"
  rescue StandardError
    format_date(date)
  end

  # --- Weekly target settings form (rendered on /my/account) -----------------

  def redmine_quick_timelog_weekly_target_days
    (1..7).map { |day| {:day => day, :label => day_name(day)} }
  end

  # --- Misc ------------------------------------------------------------------

  def redmine_quick_timelog_target_label(time_entry)
    return "##{time_entry.issue_id}" if time_entry.issue_id

    time_entry.project ? time_entry.project.name : ''
  end

  # format_hours comes from Redmine::I18n, included in both controllers and views; the
  # fallback only matters for exotic contexts (unit tests).
  def redmine_quick_timelog_format_hours(hours)
    return format_hours(hours) if respond_to?(:format_hours)

    RedmineQuickTimelog::DurationParser.format_minutes((hours.to_f * 60).round, Setting.timespan_format)
  end

  # Placeholder for the hours field: Redmine shows "h:mm", but a decimal value reads
  # better in decimal mode.
  def redmine_quick_timelog_hours_placeholder
    Setting.timespan_format == 'minutes' ? 'h:mm' : '1.5'
  end

  # Comma-separated "HH:MM" checkpoints (e.g. "12:30, 18:00") at which the timer popup
  # should notify the user if it's still running. Blank entries are dropped; anything
  # that doesn't look like a time is dropped too, silently -- a stray character in the
  # settings field should never break the popup.
  def redmine_quick_timelog_timer_notify_times
    redmine_quick_timelog_setting(:timer_notify_times).to_s.split(',').filter_map do |value|
      value = value.strip
      value if value.match?(/\A\d{1,2}:\d{2}\z/)
    end
  end

  def redmine_quick_timelog_timer_notify_hours
    redmine_quick_timelog_setting(:timer_notify_hours, 4).to_f
  end

  # URL for starting the timer on `project`, or nil when the current user isn't allowed
  # to log time on it (or there is no project in this page's context). Built once,
  # server-side, so the client never has to guess whether it's allowed to show the link.
  def redmine_quick_timelog_project_timer_url(project)
    return nil unless project && User.current.allowed_to?(:log_time, project)

    redmine_quick_timelog_timer_path(:project_id => project.identifier || project.id)
  rescue StandardError
    nil
  end

  # Configuration handed to JavaScript (read from <script type="application/json">).
  # `project`: the page's current project, if any (used only to decide whether to show
  # the "Start the timer" link next to a project's "Remove from favourites" link).
  def redmine_quick_timelog_config(project = nil)
    {
      :timespanFormat => Setting.timespan_format.to_s,
      :inlineParse => redmine_quick_timelog_setting?(:inline_parse, true),
      :scheduleCustomFieldId => redmine_quick_timelog_schedule_custom_field&.id,
      :timerUrl => redmine_quick_timelog_timer_path,
      :projectTimerUrl => redmine_quick_timelog_project_timer_url(project),
      :timerNotifyHours => redmine_quick_timelog_timer_notify_hours,
      :timerNotifyTimes => redmine_quick_timelog_timer_notify_times,
      :i18n => {
        :hours_unit => l(:redmine_quick_timelog_hours_unit),
        :error_invalid => l(:redmine_quick_timelog_error_invalid_expression),
        :error_negative => l(:redmine_quick_timelog_error_negative),
        :error_generic => l(:redmine_quick_timelog_error_generic),
        :no_issue => l(:redmine_quick_timelog_no_issue),
        :wand_title => l(:redmine_quick_timelog_wand_title),
        :wand_label => l(:redmine_quick_timelog_wand_label),
        :wand_placeholder => l(:redmine_quick_timelog_wand_placeholder),
        :wand_apply => l(:redmine_quick_timelog_wand_apply),
        :wand_hint => l(:redmine_quick_timelog_wand_hint),
        :timer_running => l(:redmine_quick_timelog_timer_running),
        :timer_pause => l(:redmine_quick_timelog_timer_pause),
        :timer_paused => l(:redmine_quick_timelog_timer_paused),
        :timer_resume => l(:redmine_quick_timelog_timer_resume),
        :timer_reset => l(:redmine_quick_timelog_timer_reset),
        :timer_reset_confirm => l(:redmine_quick_timelog_timer_reset_confirm),
        :timer_stop => l(:redmine_quick_timelog_timer_stop),
        :timer_saving => l(:redmine_quick_timelog_timer_saving),
        :timer_saved => l(:redmine_quick_timelog_timer_saved),
        :timer_close => l(:redmine_quick_timelog_timer_close),
        :timer_connected => l(:redmine_quick_timelog_timer_connected),
        :timer_reconnecting => l(:redmine_quick_timelog_timer_reconnecting),
        :timer_keepalive_hint => l(:redmine_quick_timelog_timer_keepalive_hint),
        :timer_warn_running => l(:redmine_quick_timelog_timer_warn_running),
        :timer_error_too_short => l(:redmine_quick_timelog_timer_error_too_short),
        :timer_start_link => l(:redmine_quick_timelog_timer_start_btn),
        :weekly_target_saved => l(:redmine_quick_timelog_weekly_target_saved),
        :weekly_target_error => l(:redmine_quick_timelog_weekly_target_error),
        :timer_notify_long_title => l(:redmine_quick_timelog_timer_notify_long_title),
        :timer_notify_long_body => l(:redmine_quick_timelog_timer_notify_long_body, :hours => redmine_quick_timelog_timer_notify_hours),
        :timer_notify_time_title => l(:redmine_quick_timelog_timer_notify_time_title),
        :timer_notify_time_body_template => l(:redmine_quick_timelog_timer_notify_time_body, :time => '%{time}')
      }
    }
  end

  private

  def redmine_quick_timelog_history_projects(day_entries)
    day_entries.group_by(&:project).map do |project, project_entries|
      {
        :project => project,
        :total => project_entries.sum(&:hours),
        :activities => redmine_quick_timelog_history_activities(project_entries)
      }
    end.sort_by { |row| -row[:total] }
  end

  def redmine_quick_timelog_history_activities(project_entries)
    project_entries.group_by(&:activity).map do |activity, activity_entries|
      {:activity => activity, :total => activity_entries.sum(&:hours)}
    end.sort_by { |row| -row[:total] }
  end
end
