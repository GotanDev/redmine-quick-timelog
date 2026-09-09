# frozen_string_literal: true

# Quick time logging: a compact form posted over AJAX from the home page, "My page" or a
# dedicated page, plus the per-project timer popup.
#
# Creation reuses TimeEntry and its safe_attributes=, in the same order as
# TimelogController#create: validations, custom fields, visibility and Redmine
# permissions therefore apply identically.
class RedmineQuickTimelogController < ApplicationController
  include RedmineQuickTimelogHelper

  before_action :require_login

  helper :timelog
  helper :custom_fields
  helper :redmine_quick_timelog

  # Dedicated page, reachable from the top menu.
  def index
    project = redmine_quick_timelog_remembered_project(redmine_quick_timelog_projects) || redmine_quick_timelog_projects.first
    @time_entry = new_time_entry(:project => project)
    render :layout => !request.xhr?
  end

  # Timer popup started on a project, optionally preselecting an issue (e.g. the
  # "Start the timer" link on an issue's page).
  def timer
    issue = find_visible_issue(params[:issue_id])
    project_identifier = params[:project_id].presence || params[:id].presence
    @project = issue&.project || find_allowed_project(project_identifier) || redmine_quick_timelog_projects.first
    unless @project && User.current.allowed_to?(:log_time, @project)
      render_404
      return
    end

    @time_entry = new_time_entry(:project => @project)
    @activities = redmine_quick_timelog_activity_options(@project, @time_entry)
    @default_activity_id = redmine_quick_timelog_default_activity_id(@project)
    @preselected_issue_id = issue&.id
    @issues = Issue.visible
                   .where(:project_id => @project.self_and_descendants.select(:id))
                   .open
                   .order(:id => :desc)
                   .limit(50)
                   .to_a
    # The preselected issue might be closed, or further back than the 50 most recent
    # open ones: make sure it's still an option in the <select>.
    if issue && @issues.none? { |i| i.id == issue.id }
      @issues = [issue] + @issues
    end

    render :layout => 'redmine_quick_timelog_popup'
  end

  # Keeps the session alive ("never sign out") while the timer popup is open.
  def keepalive
    if User.current.logged?
      session[:atime] = Time.now.to_i
      session[:ctime] = Time.now.to_i
      render :json => {
        :status => 'ok',
        :user_id => User.current.id,
        :time => Time.now.to_i
      }
    else
      render :json => { :status => 'unauthorized' }, :status => :unauthorized
    end
  end

  # Project-dependent context: activities, required fields, users the current user can
  # log for, and server-rendered custom fields (their visibility depends on the role,
  # hence on the project).
  def context
    project = find_allowed_project(params[:project_id])
    return render_json_errors([l(:redmine_quick_timelog_error_project_not_allowed)], :forbidden) unless project

    time_entry = new_time_entry(:project => project)

    render :json => {
      :project_id => project.id,
      :activities => redmine_quick_timelog_activity_options(project, time_entry),
      :default_activity_id => redmine_quick_timelog_default_activity_id(project),
      :issue_required => redmine_quick_timelog_required_field?('issue_id'),
      :comment_required => redmine_quick_timelog_comment_required?,
      :users => redmine_quick_timelog_user_options(project),
      :default_user_id => User.current.id,
      :custom_fields_html => render_custom_fields(time_entry)
    }
  end

  # Issue autocompletion, limited to what the user is allowed to see.
  def issues
    query = params[:q].to_s.strip
    return render(:json => {:issues => []}) if query.empty?

    scope = Issue.visible.includes(:project).references(:project)
    project = find_allowed_project(params[:project_id])
    scope = scope.where(:project_id => project.self_and_descendants.select(:id)) if project

    scope =
      if (id = query[/\A#?(\d+)\z/, 1])
        scope.where(:id => id.to_i)
      else
        pattern = "%#{Issue.sanitize_sql_like(query)}%"
        scope.where("LOWER(#{Issue.table_name}.subject) LIKE LOWER(:q) ESCAPE :e", :q => pattern, :e => '\\')
      end

    render :json => {
      :issues => scope.reorder(:id => :desc).limit(15).map do |issue|
        {
          :id => issue.id,
          :subject => issue.subject,
          :project_id => issue.project_id,
          :project_name => issue.project.name,
          :closed => issue.closed?
        }
      end
    }
  end

  # Creates a time entry (used by both the quick-entry widget and the timer popup).
  def create
    @time_entry = new_time_entry
    @time_entry.safe_attributes = time_entry_attributes

    unless @time_entry.project && User.current.allowed_to?(:log_time, @time_entry.project)
      return respond_failure([l(:redmine_quick_timelog_error_project_not_allowed)], :forbidden)
    end

    # The mandatory-comment setting is specific to the plugin: unlike
    # Setting.timelog_required_fields, no model validation carries it.
    if redmine_quick_timelog_comment_required? && @time_entry.comments.blank?
      @time_entry.valid?
      @time_entry.errors.add(:comments, :blank)
      return respond_failure(@time_entry.errors.full_messages, :unprocessable_entity)
    end

    if @time_entry.save
      redmine_quick_timelog_remember_last_project(@time_entry.project_id)
      respond_success
    else
      respond_failure(@time_entry.errors.full_messages, :unprocessable_entity)
    end
  end

  # Saves the current user's typical week (expected hours per weekday), edited from
  # /my/account. A dedicated action rather than piggybacking on MyController#account:
  # UserPreference.safe_attributes doesn't (and shouldn't) whitelist arbitrary plugin
  # keys, and nesting a second <form> inside the account page's own form would be
  # invalid HTML.
  def update_weekly_target
    hours = {}
    (params[:weekly_target] || {}).each do |day, value|
      day = day.to_i
      next unless (1..7).cover?(day)

      parsed = value.to_s.tr(',', '.').to_f
      hours[day] = parsed.clamp(0, 24) if value.present?
    end

    pref = User.current.pref
    pref[:redmine_quick_timelog_weekly_target] = hours
    if pref.save
      render :json => {:status => 'ok'}
    else
      render :json => {:status => 'error'}, :status => :unprocessable_entity
    end
  end

  private

  def new_time_entry(attributes = {})
    TimeEntry.new({
      :author => User.current,
      :user => User.current,
      :spent_on => User.current.today
    }.merge(attributes))
  end

  # Attribute filtering is still delegated to TimeEntry#safe_attributes=. This method
  # only adds two conveniences specific to quick entry:
  #   - translating a time-range expression into a duration ("9h > 12h30");
  #   - accepting an issue number typed in the text field when JavaScript hasn't filled
  #     in the hidden issue_id field.
  def time_entry_attributes
    attributes = params[:time_entry]
    return {} if attributes.blank?

    attributes = attributes.to_unsafe_hash if attributes.respond_to?(:to_unsafe_hash)
    attributes = attributes.stringify_keys

    hours = attributes['hours']
    if hours.is_a?(String) && RedmineQuickTimelog::DurationParser.expression?(hours)
      parsed = RedmineQuickTimelog::DurationParser.parse(hours)
      if parsed.ok?
        # The text as typed ("08:22 > 12:39, 13:22 > 14:32") carries more information
        # than the converted total: keep it in the dedicated custom field, if it exists.
        remember_schedule_text(attributes, hours)
        attributes['hours'] = RedmineQuickTimelog::DurationParser.format_minutes(parsed.minutes, 'minutes')
      end
    end

    # The "user" selector is hidden but still posted when the user can only log time for
    # themselves: an empty value would clear user_id.
    attributes.delete('user_id') if attributes['user_id'].blank?

    if attributes['issue_id'].blank?
      hint = attributes.delete('issue_hint').presence || issue_hint_param
      attributes['issue_id'] = Regexp.last_match(1) if hint.to_s.strip =~ /\A#?(\d+)\b/
    else
      attributes.delete('issue_hint')
    end

    attributes
  end

  # Merges the original text into whatever custom field values are already present (e.g.
  # "Support type"), without overwriting them: custom_field_values= merges by id.
  def remember_schedule_text(attributes, raw_text)
    field = redmine_quick_timelog_schedule_custom_field
    return unless field

    custom_values = attributes['custom_field_values']
    custom_values = custom_values.to_unsafe_hash if custom_values.respond_to?(:to_unsafe_hash)
    custom_values = (custom_values || {}).stringify_keys
    custom_values[field.id.to_s] = raw_text.to_s.strip
    attributes['custom_field_values'] = custom_values
  end

  # The "issue" text field of the no-JavaScript form. This parameter comes from the
  # client: it's only read when it has the expected shape.
  def issue_hint_param
    scope = params[:redmine_quick_timelog]
    return nil unless scope.is_a?(ActionController::Parameters) || scope.is_a?(Hash)

    scope[:issue]
  end

  def respond_success
    message = l(:redmine_quick_timelog_created,
                :hours => redmine_quick_timelog_format_hours(@time_entry.hours),
                :subject => redmine_quick_timelog_target_label(@time_entry))

    respond_to do |format|
      format.html do
        # render_flash_messages marks the message html_safe: escape the project or
        # issue name it contains.
        flash[:notice] = ERB::Util.h(message)
        redirect_back_or_default redmine_quick_timelog_path
      end
      format.json do
        flash.now[:notice] = ERB::Util.h(message)
        render :json => {
          :message => message,
          :flash_html => view_context.render_flash_messages,
          :entry => {
            :id => @time_entry.id,
            :hours => @time_entry.hours.to_f,
            :spent_on => @time_entry.spent_on.to_s
          },
          :recent_html => recent_entries_html(@time_entry.spent_on)
        }
      end
    end
  end

  def respond_failure(errors, status)
    respond_to do |format|
      format.html do
        flash[:error] = ERB::Util.h(errors.join(', '))
        redirect_back_or_default redmine_quick_timelog_path
      end
      format.json do
        flash.now[:error] = ERB::Util.h(errors.join(', '))
        render :json => {:errors => errors, :flash_html => view_context.render_flash_messages},
               :status => status
      end
    end
  end

  def render_json_errors(errors, status)
    render :json => {:errors => errors}, :status => status
  end

  def find_allowed_project(id)
    return nil if id.blank?

    project = Project.find_by(:id => id) || Project.find_by(:identifier => id)
    return nil unless project && User.current.allowed_to?(:log_time, project)

    project
  end

  def find_visible_issue(id)
    return nil if id.blank?

    issue = Issue.visible.find_by(:id => id)
    return nil unless issue && User.current.allowed_to?(:log_time, issue.project)

    issue
  end

  def render_custom_fields(time_entry)
    view_context.redmine_quick_timelog_custom_fields_html(time_entry)
  end

  def recent_entries_html(date)
    render_to_string(
      :partial => 'redmine_quick_timelog/entries',
      :formats => [:html],
      :locals => {:entries => redmine_quick_timelog_recent_entries(date), :date => date}
    )
  end
end
