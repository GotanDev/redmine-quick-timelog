/*
 * redmine_quick_timelog -- front-end.
 *
 *  1. "Magic wand": a button grafted next to any "hours" field in Redmine, translating
 *     "08:22 > 12:39, 13:22 > 14:32" into spent time.
 *  2. Quick-entry widget (home page, My page, dedicated page): a compact form posted
 *     over AJAX, without leaving the page.
 *  3. The "start the timer" link on an issue's page, and the F9 shortcut are handled
 *     elsewhere (see the timer script and the shortcut hook partial).
 *
 * No dependency: neither jQuery nor Rails UJS.
 */
(function () {
  'use strict';

  var Parser = window.RedmineQuickTimelogParser;

  var CONFIG = (function () {
    var defaults = { timespanFormat: 'decimal', inlineParse: true, i18n: {} };
    var node = document.getElementById('redmine-quick-timelog-config');
    if (!node) { return defaults; }
    try {
      var parsed = JSON.parse(node.textContent || node.innerText || '{}');
      for (var key in parsed) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) { defaults[key] = parsed[key]; }
      }
    } catch (e) { /* configuration illisible : on garde les valeurs par defaut */ }
    return defaults;
  }());

  function t(key, fallback) {
    return (CONFIG.i18n && CONFIG.i18n[key]) || fallback;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    for (var name in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, name)) { continue; }
      if (name === 'text') { node.textContent = attrs[name]; }
      else if (name === 'html') { node.innerHTML = attrs[name]; }
      else if (attrs[name] !== null && attrs[name] !== false) { node.setAttribute(name, attrs[name]); }
    }
    (children || []).forEach(function (child) { node.appendChild(child); });
    return node;
  }

  function formatMinutes(minutes) {
    return Parser.format(minutes, CONFIG.timespanFormat);
  }

  /** "4:17 + 1:10 = 5:27 (5.45 h)" */
  function describe(result) {
    var detail = '';
    if (result.parts.length > 1) {
      detail = result.parts.map(function (part, index) {
        var value = Parser.toHoursMinutes(Math.abs(part.minutes));
        if (index === 0) { return (part.minutes < 0 ? '-' : '') + value; }
        return (part.minutes < 0 ? ' − ' : ' + ') + value;
      }).join('') + ' = ';
    }
    var total = Parser.toHoursMinutes(result.minutes);
    var decimal = Parser.toDecimal(result.minutes);
    return detail + total + ' (' + decimal + ' ' + t('hours_unit', 'h') + ')';
  }

  function errorMessage(result) {
    if (result.error === 'negative') { return t('error_negative', 'Le total est négatif.'); }
    if (result.error === 'blank') { return ''; }
    var message = t('error_invalid', 'Expression incomprise');
    return result.token ? message + ' : « ' + result.token + ' »' : message;
  }

  /* ------------------------------------------------------------------ */
  /* Baguette magique                                                    */
  /* ------------------------------------------------------------------ */

  var WAND_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M11.3 1.2 12 3l1.8.7-1.8.7-.7 1.8-.7-1.8L8.8 3.7 10.6 3zM3.8 8.1 4.3 9.4l1.3.5-1.3.5-.5 1.3-.5-1.3L2 9.9l1.3-.5zM14.2 9.6l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4zM9.6 5.2a1 1 0 0 1 1.4 0l.8.8a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4 0l-.8-.8a1 1 0 0 1 0-1.4zm-4.9 6.3.7.7 4.3-4.3-.7-.7z"/>' +
    '</svg>';

  var openPopover = null;
  var wandSequence = 0;

  function closePopover() {
    if (!openPopover) { return; }
    openPopover.wrapper.classList.remove('qtl-wand--open');
    openPopover.popover.hidden = true;
    openPopover.button.setAttribute('aria-expanded', 'false');
    openPopover = null;
  }

  function rememberExpression(value) {
    try { window.sessionStorage.setItem('redmineQuickTimelog.expression', value); } catch (e) { /* stockage indisponible */ }
  }

  function recallExpression() {
    try { return window.sessionStorage.getItem('redmineQuickTimelog.expression') || ''; } catch (e) { return ''; }
  }

  function attachWand(target) {
    if (!target || target.getAttribute('data-qtl-wand-ready') === '1') { return; }
    target.setAttribute('data-qtl-wand-ready', '1');

    var uid = 'qtl-wand-' + (++wandSequence);
    var title = t('wand_title', 'Calculer depuis des plages horaires');

    var wrapper = el('span', { 'class': 'qtl-wand' });
    var button = el('button', {
      type: 'button',
      'class': 'qtl-wand__trigger',
      title: title,
      'aria-label': title,
      'aria-expanded': 'false',
      'aria-controls': uid + '-popover',
      html: WAND_ICON
    });

    var input = el('input', {
      type: 'text',
      id: uid + '-input',
      'class': 'qtl-wand__input',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: t('wand_placeholder', '08:22 > 12:39, 13:22 > 14:32')
    });
    var preview = el('div', { 'class': 'qtl-wand__preview', 'aria-live': 'polite' });
    var apply = el('button', { type: 'button', 'class': 'qtl-wand__apply', text: t('wand_apply', 'Appliquer') });
    var hint = el('p', { 'class': 'qtl-wand__hint', text: t('wand_hint', 'Plages « 9h > 12h30 », durées « 45m », pauses « -30m ».') });

    var popover = el('div', {
      id: uid + '-popover',
      'class': 'qtl-wand__popover',
      hidden: 'hidden',
      role: 'dialog',
      'aria-label': title
    }, [
      el('label', { 'class': 'qtl-wand__label', 'for': uid + '-input', text: t('wand_label', 'Plages horaires') }),
      input, preview, hint,
      el('span', { 'class': 'qtl-wand__actions' }, [apply])
    ]);

    wrapper.appendChild(button);
    wrapper.appendChild(popover);

    if (target.nextSibling) { target.parentNode.insertBefore(wrapper, target.nextSibling); }
    else { target.parentNode.appendChild(wrapper); }

    var lastResult = null;

    function refresh() {
      var value = input.value;
      if (!value.trim()) {
        preview.textContent = '';
        preview.className = 'qtl-wand__preview';
        lastResult = null;
        apply.disabled = true;
        return;
      }
      var result = Parser.parse(value);
      lastResult = result.ok ? result : null;
      preview.className = 'qtl-wand__preview' + (result.ok ? ' qtl-wand__preview--ok' : ' qtl-wand__preview--error');
      preview.textContent = result.ok ? describe(result) : errorMessage(result);
      apply.disabled = !result.ok;
    }

    function applyResult() {
      if (!lastResult) { return; }
      target.value = formatMinutes(lastResult.minutes);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      rememberExpression(input.value);
      closePopover();
      target.focus();
    }

    function open() {
      closePopover();
      popover.hidden = false;
      wrapper.classList.add('qtl-wand--open');
      button.setAttribute('aria-expanded', 'true');
      openPopover = { wrapper: wrapper, popover: popover, button: button };
      if (!input.value) { input.value = recallExpression(); }
      refresh();
      input.focus();
      input.select();
    }

    button.addEventListener('click', function (event) {
      event.preventDefault();
      if (popover.hidden) { open(); } else { closePopover(); }
    });

    input.addEventListener('input', refresh);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); applyResult(); }
      else if (event.key === 'Escape') { event.preventDefault(); closePopover(); target.focus(); }
    });
    apply.addEventListener('click', function (event) { event.preventDefault(); applyResult(); });
    wrapper.addEventListener('click', function (event) { event.stopPropagation(); });

    // Saisie directe d'une expression dans le champ heures : conversion a la sortie du champ.
    if (CONFIG.inlineParse) {
      target.addEventListener('blur', function () {
        var value = target.value;
        if (!Parser.looksLikeExpression(value)) { return; }
        var result = Parser.parse(value);
        if (!result.ok) { return; }
        target.value = formatMinutes(result.minutes);
        target.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  }

  document.addEventListener('click', closePopover);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { closePopover(); }
  });

  var HOURS_SELECTOR = [
    '#time_entry_hours',
    'input[name="time_entry[hours]"]',
    'input[data-qtl-hours]',
    '#timelog_bulk_edit_hours'
  ].join(',');

  function scanWands(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var fields = scope.querySelectorAll(HOURS_SELECTOR);
    for (var i = 0; i < fields.length; i++) { attachWand(fields[i]); }
  }

  /* ------------------------------------------------------------------ */
  /* Issue page: "Start the timer" link                                  */
  /* ------------------------------------------------------------------ */

  // There is no view hook right at the issue's own action menu (Edit / Log time /
  // Watch / Copy), so the link is inserted client-side, exactly like the wand itself.
  function injectIssueTimerLink() {
    if (!CONFIG.timerUrl) { return; }
    if (!document.body.classList.contains('controller-issues') ||
        !document.body.classList.contains('action-show')) { return; }

    var logTimeLink = document.querySelector('.contextual .icon-time-add');
    var contextual = logTimeLink ? logTimeLink.closest('.contextual') : null;
    if (!contextual || contextual.getAttribute('data-qtl-timer-link-added') === '1') { return; }
    contextual.setAttribute('data-qtl-timer-link-added', '1');

    var match = /\/issues\/(\d+)\/time_entries\/new/.exec(logTimeLink.getAttribute('href') || '');
    if (!match) { return; }

    var link = el('a', {
      href: '#',
      'class': 'qtl-issue-timer-link',
      text: '\u23F1 ' + t('timer_start_link', 'Start the timer')
    });
    link.addEventListener('click', function (event) {
      event.preventDefault();
      openTimer(CONFIG.timerUrl + '?issue_id=' + encodeURIComponent(match[1]));
    });
    contextual.insertBefore(link, contextual.firstChild);
  }

  /* ------------------------------------------------------------------ */
  /* Project overview page: "Start the timer" link                       */
  /* ------------------------------------------------------------------ */

  // Builds a link matching Redmine's own icon links (bookmark, settings, ...): same
  // inline-SVG-sprite markup, read off any icon already on the page rather than
  // guessing the sprite's fingerprinted asset URL.
  function buildIconLink(iconName, text) {
    var link = document.createElement('a');
    link.href = '#';
    link.className = 'icon icon-' + iconName;

    var sampleUse = document.querySelector('svg.icon-svg use[href]');
    if (sampleUse) {
      var svgNS = 'http://www.w3.org/2000/svg';
      var base = (sampleUse.getAttribute('href') || '').split('#')[0];
      var svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', sampleUse.parentNode.getAttribute('class') || 'icon-svg');
      svg.setAttribute('aria-hidden', 'true');
      var use = document.createElementNS(svgNS, 'use');
      use.setAttribute('href', base + '#icon--' + iconName);
      svg.appendChild(use);
      link.appendChild(svg);
    } else {
      link.appendChild(document.createTextNode('⏱ '));
    }
    link.appendChild(el('span', { 'class': 'icon-label', text: text }));
    return link;
  }

  // There is no view hook right at the project overview's own contextual bar (bookmark
  // link + "..." actions), so the link is inserted client-side, exactly like the issue
  // page's. The URL is computed server-side (see redmine_quick_timelog_config): the client
  // never has to work out on its own whether logging time here is allowed.
  function injectProjectTimerLink() {
    if (!CONFIG.projectTimerUrl) { return; }
    if (!document.body.classList.contains('controller-projects') ||
        !document.body.classList.contains('action-show')) { return; }

    var bookmark = document.querySelector('.contextual .bookmark');
    var contextual = bookmark ? bookmark.closest('.contextual') : document.querySelector('.contextual');
    if (!contextual || contextual.getAttribute('data-qtl-timer-link-added') === '1') { return; }
    contextual.setAttribute('data-qtl-timer-link-added', '1');

    var link = buildIconLink('time-add', t('timer_start_link', 'Start the timer'));
    link.classList.add('qtl-project-timer-link');
    link.addEventListener('click', function (event) {
      event.preventDefault();
      openTimer(CONFIG.projectTimerUrl);
    });
    contextual.insertBefore(link, contextual.firstChild);
  }

  /* ------------------------------------------------------------------ */
  /* Quick-entry widget                                                   */
  /* ------------------------------------------------------------------ */

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : null;
  }

  function requestJSON(url, options) {
    options = options || {};
    var headers = { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    var token = csrfToken();
    if (token) { headers['X-CSRF-Token'] = token; }

    return fetch(url, {
      method: options.method || 'GET',
      headers: headers,
      credentials: 'same-origin',
      body: options.body
    }).then(function (response) {
      // A 2xx response whose body isn't JSON (an SSO portal, a proxy's own page)
      // must not be treated as a success: the form would be cleared for nothing.
      return response.json().catch(function () { return null; }).then(function (payload) {
        if (!response.ok || payload === null) {
          var error = new Error(response.ok ? 'invalid_json' : 'http_error');
          error.payload = payload || {};
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function initWidget(root) {
    if (!root || root.getAttribute('data-qtl-ready') === '1') { return; }
    root.setAttribute('data-qtl-ready', '1');

    var form = root.querySelector('[data-qtl-form]');
    if (!form) { return; }

    var urls = {
      create: root.getAttribute('data-qtl-create-url'),
      context: root.getAttribute('data-qtl-context-url'),
      issues: root.getAttribute('data-qtl-issues-url'),
      timer: root.getAttribute('data-qtl-timer-url')
    };

    var projectField = form.querySelector('[data-qtl-project]');
    var activityField = form.querySelector('[data-qtl-activity]');
    var issueField = form.querySelector('[data-qtl-issue]');
    var issueLabel = root.querySelector('[data-qtl-issue-label]');
    var hoursField = form.querySelector('[data-qtl-hours]');
    var messages = root.querySelector('[data-qtl-messages]');
    var recent = root.querySelector('[data-qtl-recent]');
    var submitButton = form.querySelector('[data-qtl-submit]');

    // The server returns the flash markup Redmine itself rendered (icon, i18n,
    // escaping included); a div is only rebuilt here when that markup is absent.
    function flash(kind, text, html) {
      if (!messages) { return; }
      messages.innerHTML = '';
      if (html) { messages.innerHTML = html; return; }
      if (!text) { return; }
      messages.appendChild(el('div', {
        'class': kind === 'error' ? 'flash error' : 'flash notice',
        id: kind === 'error' ? 'flash_error' : 'flash_notice',
        text: text
      }));
    }


    // Keeps the first choice still offered by the new list: whatever the user had
    // selected, otherwise the project's default value.
    function selectFirstAvailable(field, candidates) {
      for (var i = 0; i < candidates.length; i++) {
        var wanted = candidates[i];
        if (wanted === null || wanted === undefined || wanted === '') { continue; }
        field.value = String(wanted);
        if (field.value === String(wanted)) { return; }
      }
      if (!field.value && field.options.length) { field.selectedIndex = 0; }
    }

    function setActivities(activities, selectedId) {
      if (!activityField) { return; }
      var previous = activityField.value;
      activityField.innerHTML = '';
      activities.forEach(function (activity) {
        activityField.appendChild(el('option', { value: activity.id, text: activity.name }));
      });
      selectFirstAvailable(activityField, [previous, selectedId]);
    }

    // The field only shows up when logging time for someone else is allowed; it's
    // always populated with at least the current user, preselected.
    function setUsers(users, defaultId) {
      var userField = form.querySelector('[data-qtl-user]');
      var userRow = root.querySelector('[data-qtl-user-row]');
      if (!userField || !userRow) { return; }
      var previous = userField.value;
      userField.innerHTML = '';
      (users || []).forEach(function (user) {
        userField.appendChild(el('option', { value: user.id, text: user.name }));
      });
      selectFirstAvailable(userField, [previous, defaultId]);
      userRow.hidden = !users || users.length < 2;
    }

    function loadContext() {
      if (!urls.context || !projectField) { return; }
      var projectId = projectField.value;
      if (!projectId) { return; }
      requestJSON(urls.context + '?project_id=' + encodeURIComponent(projectId))
        .then(function (payload) {
          setActivities(payload.activities || [], payload.default_activity_id);
          setUsers(payload.users, payload.default_user_id);
          if (issueLabel && payload.issue_required !== undefined) {
            issueLabel.classList.toggle('qtl-required', !!payload.issue_required);
          }
          var customFields = form.querySelector('[data-qtl-custom-fields]');
          if (customFields && payload.custom_fields_html !== undefined) {
            customFields.innerHTML = payload.custom_fields_html;
          }
        })
        .catch(function () { /* on garde le formulaire tel qu'il est */ });
    }

    if (projectField) { projectField.addEventListener('change', function () { loadContext(); resetIssue(); }); }

    /* -- autocompletion des demandes -- */
    var issueResults = root.querySelector('[data-qtl-issue-results]');
    var issueIdField = form.querySelector('[data-qtl-issue-id]');
    var searchTimer = null;
    var activeIndex = -1;

    function resetIssue() {
      if (issueIdField) { issueIdField.value = ''; }
      hideIssueResults();
    }

    function hideIssueResults() {
      if (!issueResults) { return; }
      issueResults.innerHTML = '';
      issueResults.hidden = true;
      activeIndex = -1;
      if (issueField) {
        issueField.setAttribute('aria-expanded', 'false');
        issueField.removeAttribute('aria-activedescendant');
      }
    }

    function pickIssue(issue) {
      if (issueIdField) { issueIdField.value = issue.id; }
      if (issueField) { issueField.value = '#' + issue.id + ' ' + issue.subject; }
      if (projectField && issue.project_id && String(projectField.value) !== String(issue.project_id)) {
        projectField.value = String(issue.project_id);
        loadContext();
      }
      hideIssueResults();
    }

    function renderIssues(issues) {
      if (!issueResults) { return; }
      issueResults.innerHTML = '';
      if (issueField) { issueField.setAttribute('aria-expanded', 'true'); }
      if (!issues.length) {
        issueResults.appendChild(el('li', { 'class': 'qtl-issues__empty', role: 'presentation', text: t('no_issue', 'Aucune demande') }));
        issueResults.hidden = false;
        return;
      }
      issues.forEach(function (issue, index) {
        var item = el('li', {
          'class': 'qtl-issues__item',
          'data-index': index,
          id: 'qtl-issue-option-' + index,
          role: 'option',
          'aria-selected': 'false'
        });
        item.appendChild(el('span', { 'class': 'qtl-issues__id', text: '#' + issue.id }));
        item.appendChild(el('span', { 'class': 'qtl-issues__subject', text: issue.subject }));
        if (issue.project_name) { item.appendChild(el('span', { 'class': 'qtl-issues__project', text: issue.project_name })); }
        item.addEventListener('mousedown', function (event) { event.preventDefault(); pickIssue(issue); });
        issueResults.appendChild(item);
      });
      issueResults.hidden = false;
    }

    function searchIssues() {
      if (!urls.issues || !issueField) { return; }
      var query = issueField.value.trim();
      if (query.length < 1) { hideIssueResults(); return; }
      var url = urls.issues + '?q=' + encodeURIComponent(query);
      if (projectField && projectField.value) { url += '&project_id=' + encodeURIComponent(projectField.value); }
      requestJSON(url).then(function (payload) { renderIssues(payload.issues || []); }).catch(hideIssueResults);
    }

    if (issueField) {
      issueField.addEventListener('input', function () {
        if (issueIdField) { issueIdField.value = ''; }
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(searchIssues, 250);
      });
      issueField.addEventListener('blur', function () { window.setTimeout(hideIssueResults, 150); });
      issueField.addEventListener('keydown', function (event) {
        if (!issueResults || issueResults.hidden) { return; }
        var items = issueResults.querySelectorAll('.qtl-issues__item');
        if (!items.length) { return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          activeIndex += (event.key === 'ArrowDown' ? 1 : -1);
          if (activeIndex < 0) { activeIndex = items.length - 1; }
          if (activeIndex >= items.length) { activeIndex = 0; }
          for (var i = 0; i < items.length; i++) {
            var active = i === activeIndex;
            items[i].classList.toggle('qtl-issues__item--active', active);
            items[i].setAttribute('aria-selected', active ? 'true' : 'false');
          }
          issueField.setAttribute('aria-activedescendant', items[activeIndex].id);
          items[activeIndex].scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && activeIndex >= 0) {
          event.preventDefault();
          items[activeIndex].dispatchEvent(new MouseEvent('mousedown'));
        } else if (event.key === 'Escape') {
          hideIssueResults();
        }
      });
    }

    /* -- soumission -- */
    function submit() {
      if (!urls.create) { return; }

      // Ctrl+Enter bypasses the browser's native validation: trigger it explicitly so
      // required fields get flagged in the right place.
      if (form.reportValidity && !form.reportValidity()) { return; }

      // Safety net: if the hours field still holds an expression, convert it before
      // sending (the user might submit without ever leaving the field).
      if (hoursField && Parser.looksLikeExpression(hoursField.value)) {
        var parsed = Parser.parse(hoursField.value);
        if (parsed.ok) { hoursField.value = formatMinutes(parsed.minutes); }
      }

      // FormData reproduit exactement ce que le navigateur enverrait sans JavaScript :
      // checkboxes, multi-selects and Redmine's own custom fields included.
      var body = new FormData(form);

      if (submitButton) { submitButton.disabled = true; }
      form.classList.add('qtl-form--busy');
      flash(null, '');

      requestJSON(urls.create, { method: 'POST', body: body })
        .then(function (response) {
          flash('notice', response.message, response.flash_html);
          if (recent && response.recent_html !== undefined) { recent.innerHTML = response.recent_html; }
          if (hoursField) { hoursField.value = ''; }
          var comments = form.querySelector('[data-qtl-field="comments"]');
          if (comments) { comments.value = ''; }
          if (issueField) { issueField.value = ''; }
          if (issueIdField) { issueIdField.value = ''; }
          if (hoursField) { hoursField.focus(); }
        })
        .catch(function (error) {
          var payload = error.payload || {};
          var payloadErrors = payload.errors || [];
          flash('error',
                payloadErrors.length ? payloadErrors.join(' — ') : t('error_generic', 'Enregistrement impossible.'),
                payload.flash_html);
        })
        .then(function () {
          if (submitButton) { submitButton.disabled = false; }
          form.classList.remove('qtl-form--busy');
        });
    }

    form.addEventListener('submit', function (event) { event.preventDefault(); submit(); });

    var launchTimerBtn = root.querySelector('[data-qtl-launch-timer]');
    if (launchTimerBtn && urls.timer) {
      launchTimerBtn.addEventListener('click', function (event) {
        event.preventDefault();
        var pId = projectField ? projectField.value : '';
        var timerUrl = urls.timer + (pId ? '?project_id=' + encodeURIComponent(pId) : '');
        openTimer(timerUrl);
      });
    }

    // Clicking a day in the history tree preselects it in the form right next to it;
    // stopPropagation keeps the click from also toggling that day's <details> open/shut.
    var historyDateButtons = root.querySelectorAll('[data-qtl-pick-date]');
    for (var h = 0; h < historyDateButtons.length; h++) {
      historyDateButtons[h].addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        var dateField = form.querySelector('[data-qtl-field="spent_on"]');
        if (dateField) {
          dateField.value = this.getAttribute('data-qtl-pick-date');
          dateField.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (hoursField) { hoursField.focus(); }
      });
    }

    // A project link inside a day's summary must still navigate normally on click,
    // it just shouldn't ALSO toggle that day's <details> open/shut in the process.
    var historyProjectLinks = root.querySelectorAll('[data-qtl-history-link]');
    for (var p = 0; p < historyProjectLinks.length; p++) {
      historyProjectLinks[p].addEventListener('click', function (event) { event.stopPropagation(); });
    }

    // Ctrl+Enter from any field in the form.
    form.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit(); }
    });

    scanWands(root);
  }

  /* ------------------------------------------------------------------ */
  /* Typical-week grid ("My account" page)                                */
  /* ------------------------------------------------------------------ */

  function wireWeeklyTarget() {
    var root = document.querySelector('[data-qtl-weekly-target]');
    if (!root || root.getAttribute('data-qtl-ready') === '1') { return; }
    root.setAttribute('data-qtl-ready', '1');

    var url = root.getAttribute('data-qtl-save-url');
    var saveBtn = root.querySelector('[data-qtl-weekly-save]');
    var messageEl = root.querySelector('[data-qtl-weekly-message]');
    if (!url || !saveBtn) { return; }

    saveBtn.addEventListener('click', function () {
      var inputs = root.querySelectorAll('[data-qtl-weekly-day]');
      var params = new URLSearchParams();
      for (var i = 0; i < inputs.length; i++) {
        params.append('weekly_target[' + inputs[i].getAttribute('data-qtl-weekly-day') + ']', inputs[i].value);
      }

      saveBtn.disabled = true;
      if (messageEl) { messageEl.textContent = ''; messageEl.className = 'qtl-weekly-target__message'; }

      requestJSON(url, { method: 'POST', body: params })
        .then(function () {
          if (messageEl) {
            messageEl.textContent = t('weekly_target_saved', 'Saved.');
            messageEl.className = 'qtl-weekly-target__message qtl-weekly-target__message--ok';
          }
        })
        .catch(function () {
          if (messageEl) {
            messageEl.textContent = t('weekly_target_error', 'Could not save.');
            messageEl.className = 'qtl-weekly-target__message qtl-weekly-target__message--error';
          }
        })
        .then(function () { saveBtn.disabled = false; });
    });
  }

  function boot() {
    scanWands(document);
    injectIssueTimerLink();
    injectProjectTimerLink();
    wireWeeklyTarget();
    var widgets = document.querySelectorAll('[data-qtl-widget]');
    for (var i = 0; i < widgets.length; i++) { initWidget(widgets[i]); }
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', boot); }
  else { boot(); }

  // Redmine remplace certaines zones en AJAX (ex. formulaire de temps recharge) :
  // on re-greffe la baguette sur les champs qui apparaissent apres coup.
  if (window.MutationObserver) {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) { continue; }
          if (node.matches && node.matches(HOURS_SELECTOR)) { attachWand(node); }
          else { scanWands(node); }
          // "My page" inserts the whole block (div.mypage-box): the widget is a
          // descendant of the added node, not the node itself.
          if (node.matches && node.matches('[data-qtl-widget]')) { initWidget(node); }
          else if (node.querySelectorAll) {
            var nested = node.querySelectorAll('[data-qtl-widget]');
            for (var w = 0; w < nested.length; w++) { initWidget(nested[w]); }
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function openTimer(url) {
    var width = 480;
    var height = 680;
    var left = Math.max(0, Math.round((window.screen.width - width) / 2));
    var top = Math.max(0, Math.round((window.screen.height - height) / 2));
    var name = 'qtl_timer_' + (url || '').replace(/\D/g, '');
    var features = 'width=' + width + ',height=' + height + ',top=' + top + ',left=' + left +
                   ',resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no';
    var win = window.open(url, name, features);
    if (win) { win.focus(); }
    return win;
  }

  window.redmineQuickTimelogOpenTimer = openTimer;
  window.RedmineQuickTimelog = { attachWand: attachWand, scan: boot, config: CONFIG, openTimer: openTimer };
}());
