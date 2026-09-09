# frozen_string_literal: true

# Plugin routes, loaded in the context of Rails.application.routes.

get   'redmine_quick_timelog',                :to => 'redmine_quick_timelog#index',                :as => 'redmine_quick_timelog'
get   'redmine_quick_timelog/context',        :to => 'redmine_quick_timelog#context',              :as => 'redmine_quick_timelog_context'
get   'redmine_quick_timelog/issues',         :to => 'redmine_quick_timelog#issues',               :as => 'redmine_quick_timelog_issues'
post  'redmine_quick_timelog/entries',        :to => 'redmine_quick_timelog#create',               :as => 'redmine_quick_timelog_entries'
get   'redmine_quick_timelog/timer',          :to => 'redmine_quick_timelog#timer',                :as => 'redmine_quick_timelog_timer'
get   'redmine_quick_timelog/keepalive',      :to => 'redmine_quick_timelog#keepalive',            :as => 'redmine_quick_timelog_keepalive'
post  'redmine_quick_timelog/weekly_target',  :to => 'redmine_quick_timelog#update_weekly_target', :as => 'redmine_quick_timelog_weekly_target'
