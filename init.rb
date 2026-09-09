# frozen_string_literal: true

require 'redmine'

Redmine::Plugin.register :redmine_quick_timelog do
  name 'Quick Timelog'
  author 'Gotan'
  description "Quick time logging from the home page, with time-range parsing (\xc2\xab 08:22 > 12:39, 13:22 > 14:32 \xc2\xbb) into spent time."
  version '1.0.0'
  author_url 'https://gotan.io'

  requires_redmine :version_or_higher => '6.0.0'

  settings(
    :default => {
      'show_on_welcome' => '1',
      'inline_parse' => '1',
      'wand_everywhere' => '1',
      'default_activity' => '',
      'recent_days' => '14',
      'comment_required' => '0',
      'working_days' => %w[1 2 3 4 5],
      'highlight_missing_days' => '0',
      'timer_notify_hours' => '4',
      'timer_notify_times' => ''
    },
    :partial => 'settings/redmine_quick_timelog_settings'
  )

  menu :top_menu, :redmine_quick_timelog,
       {:controller => 'redmine_quick_timelog', :action => 'index'},
       :caption => :label_redmine_quick_timelog,
       :if => proc { User.current.logged? && User.current.allowed_to?(:log_time, nil, :global => true) }

  menu :project_menu, :redmine_quick_timelog_timer,
       {:controller => 'redmine_quick_timelog', :action => 'timer'},
       :caption => :label_redmine_quick_timelog_timer,
       :param => :project_id,
       :after => :activity,
       :html => {
         :onclick => 'if (window.redmineQuickTimelogOpenTimer) { redmineQuickTimelogOpenTimer(this.href); return false; } else { window.open(this.href, "qtl_timer", "width=480,height=680,resizable=yes,scrollbars=yes"); return false; }',
         :class => 'icon icon-time-add redmine-quick-timelog-timer-btn'
       },
       :if => proc { |project| User.current.logged? && User.current.allowed_to?(:log_time, project) }
end

# lib/ is a Zeitwerk root managed by Redmine::PluginLoader: referencing the constant is
# enough to load the listener (a require would break autoloading in development).
RedmineQuickTimelog::Hooks

# Redmine sets config.action_controller.include_all_helpers = false: a plugin helper is
# only visible to the controller that declares it. Our partials are rendered from
# MyController's views ("My page" block) and WelcomeController's (home page hook), so we
# add it to ActionView itself instead. Its methods are all prefixed redmine_quick_timelog_, and
# the one core module it carries along (CustomFieldsHelper, needed to render custom
# fields) is the very same module Redmine declares elsewhere — no collision possible.
# init.rb is replayed on every to_prepare, so the reloaded module is re-included in
# development.
ActiveSupport.on_load(:action_view) { include RedmineQuickTimelogHelper }
