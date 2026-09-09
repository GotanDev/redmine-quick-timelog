# frozen_string_literal: true

module RedmineQuickTimelog
  # Hook points into Redmine's views.
  #
  # Insertions:
  #   - assets (CSS + JS + config) on pages that may show an "hours" field, the widget,
  #     the issue-page "start the timer" link, or the project-page one;
  #   - the widget itself in the home page's right column;
  #   - the F9 shortcut (every page) and the weekly-target grid (the account page).
  #
  # The "start the timer" links themselves (on an issue's page, and on a project's
  # overview page next to "Remove from favourites") are injected client-side: neither
  # page has a view hook at that exact spot. See redmine_quick_timelog.js.
  #
  # A hook that raises turns into a 500 on the host page (the core doesn't rescue
  # anything), and view_layouts_base_html_head/body_bottom run on every page, including
  # /login: every method here is therefore defensive.
  class Hooks < Redmine::Hook::ViewListener
    # Plugin pages, or pages that may host the widget / timer quick-start button.
    WIDGET_CONTROLLERS = %w[redmine_quick_timelog my welcome projects].freeze
    # Core pages that show an "hours" field (time entry form, an issue's "Spent time"
    # fieldset, and the issue's own action menu where the "start the timer" link lives).
    TIMELOG_CONTROLLERS = %w[timelog issues].freeze

    def view_layouts_base_html_head(context = {})
      return ''.html_safe unless assets_needed?(context)

      render_partial(context, :partial => 'redmine_quick_timelog/assets')
    rescue StandardError => e
      log_failure(:view_layouts_base_html_head, e)
    end

    # Runs on every page: the global F9 shortcut for the "Quick log" top menu entry.
    def view_layouts_base_body_bottom(context = {})
      return ''.html_safe unless shortcut_enabled?

      render_partial(context, :partial => 'redmine_quick_timelog/shortcut')
    rescue StandardError => e
      log_failure(:view_layouts_base_body_bottom, e)
    end

    def view_welcome_index_right(context = {})
      return ''.html_safe unless welcome_widget?

      render_partial(context, :partial => 'redmine_quick_timelog/welcome_widget')
    rescue StandardError => e
      log_failure(:view_welcome_index_right, e)
    end

    # The "typical week" grid on the user's own account page.
    def view_my_account_preferences(context = {})
      render_partial(context, :partial => 'redmine_quick_timelog/weekly_target')
    rescue StandardError => e
      log_failure(:view_my_account_preferences, e)
    end

    private

    def assets_needed?(context)
      return false unless User.current.logged?

      name = controller_name(context)
      return false if name.nil?
      return true if WIDGET_CONTROLLERS.include?(name)
      return wand_everywhere? if TIMELOG_CONTROLLERS.include?(name)

      false
    end

    def controller_name(context)
      controller = context[:controller]
      return nil unless controller.respond_to?(:controller_name)

      controller.controller_name.to_s
    end

    def plugin_settings
      Setting.plugin_redmine_quick_timelog || {}
    end

    def setting?(key, default)
      value = plugin_settings[key.to_s]
      return default if value.nil?

      %w[1 true yes on].include?(value.to_s)
    end

    def wand_everywhere?
      setting?('wand_everywhere', true)
    end

    def welcome_widget?
      User.current.logged? && setting?('show_on_welcome', true)
    end

    # Mirrors the :if condition of the top-menu item itself: the shortcut only exists
    # where the menu entry it triggers would also be visible.
    def shortcut_enabled?
      User.current.logged? && User.current.allowed_to?(:log_time, nil, :global => true)
    end

    # Same mechanism as Redmine::Hook::ViewListener.render_on: render in the calling
    # view's context when possible, otherwise through the controller.
    def render_partial(context, options)
      if context[:hook_caller].respond_to?(:render)
        context[:hook_caller].send(:render, {:locals => context}.merge(options))
      elsif context[:controller].is_a?(ActionController::Base)
        context[:controller].send(:render_to_string, {:locals => context}.merge(options))
      else
        ''.html_safe
      end
    end

    def log_failure(hook, error)
      Rails.logger.error("redmine_quick_timelog: #{hook} failed (#{error.class}: #{error.message})")
      ''.html_safe
    end
  end
end
