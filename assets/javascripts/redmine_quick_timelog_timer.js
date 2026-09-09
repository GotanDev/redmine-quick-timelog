/*
 * redmine_quick_timelog_timer -- popup timer engine.
 *
 * Key features:
 *  1. Precise timing based on Date.now() (unaffected by throttled/sleeping tabs).
 *  2. Keeps the Redmine session alive at all times ("never sign out") via a heartbeat.
 *  3. Instant persistence to localStorage (elapsed time, state, textarea comments).
 *  4. Logs the time straight to the project on stop, then closes automatically.
 *
 * No external dependency.
 */
(function () {
  'use strict';

  var Parser = window.RedmineQuickTimelogParser;

  var CONFIG = (function () {
    var defaults = { timespanFormat: 'decimal', i18n: {} };
    var node = document.getElementById('redmine-quick-timelog-config');
    if (!node) { return defaults; }
    try {
      var parsed = JSON.parse(node.textContent || node.innerText || '{}');
      for (var key in parsed) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) { defaults[key] = parsed[key]; }
      }
    } catch (e) { /* configuration illisible */ }
    return defaults;
  }());

  function t(key, fallback) {
    return (CONFIG.i18n && CONFIG.i18n[key]) || fallback;
  }

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : null;
  }

  function formatDigits(totalSeconds) {
    var s = Math.max(0, Math.floor(totalSeconds));
    var hours = Math.floor(s / 3600);
    var minutes = Math.floor((s % 3600) / 60);
    var seconds = s % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
  }

  function formatHoursValue(totalSeconds) {
    var totalMinutes = Math.max(1, Math.round(totalSeconds / 60));
    if (Parser && typeof Parser.format === 'function') {
      return Parser.format(totalMinutes, CONFIG.timespanFormat || 'decimal');
    }
    if (CONFIG.timespanFormat === 'minutes') {
      var h = Math.floor(totalMinutes / 60);
      var m = totalMinutes % 60;
      return h + ':' + (m < 10 ? '0' : '') + m;
    }
    return (totalMinutes / 60).toFixed(2);
  }

  function initTimer(root) {
    if (!root) { return; }

    var projectId = root.getAttribute('data-qtl-project-id');
    var projectName = root.getAttribute('data-qtl-project-name') || '';
    var createUrl = root.getAttribute('data-qtl-create-url');
    var keepaliveUrl = root.getAttribute('data-qtl-keepalive-url');

    var storageKey = 'redmine_quick_timelog_timer_' + projectId;

    var digitsEl = root.querySelector('[data-qtl-timer-digits]');
    var pulseEl = root.querySelector('[data-qtl-timer-pulse]');
    var stateLabelEl = root.querySelector('[data-qtl-timer-state-label]');
    var toggleBtn = root.querySelector('[data-qtl-timer-toggle]');
    var toggleIcon = root.querySelector('[data-qtl-timer-toggle-icon]');
    var toggleLabel = root.querySelector('[data-qtl-timer-toggle-label]');
    var resetBtn = root.querySelector('[data-qtl-timer-reset]');
    var stopBtn = root.querySelector('[data-qtl-timer-stop]');
    var statusEl = root.querySelector('[data-qtl-timer-status]');
    var statusTextEl = root.querySelector('[data-qtl-timer-status-text]');
    var messagesEl = root.querySelector('[data-qtl-messages]');

    var form = root.querySelector('[data-qtl-timer-form]');
    var commentsField = root.querySelector('[data-qtl-timer-comments]');
    var activityField = root.querySelector('[data-qtl-timer-activity]');
    var issueField = root.querySelector('[data-qtl-timer-issue]');
    var dateField = root.querySelector('[data-qtl-timer-date]');
    var hoursField = root.querySelector('[data-qtl-timer-hours]');

    // Timer state
    var startTime = Date.now();
    // Timestamp of the very first start (unaffected by pause/resume): used to build the
    // "14:32 > 16:10" schedule range remembered on stop, regardless of any pauses.
    var firstStartedAt = startTime;
    var accumulatedMs = 0;
    var isRunning = true;
    var timerInterval = null;
    var hasBeenSaved = false;
    // Whether the "running for a while" notification has already fired for the
    // *current* continuous run (reset on pause/resume/reset, not on every tick).
    var notifiedLongRun = false;
    // Which "HH:MM" checkpoints have already triggered a notification today, so a
    // checkpoint that was crossed once doesn't fire again on every tick afterwards.
    var notifiedCheckpoints = {};

    // Restores any previously saved state
    function loadSavedState() {
      try {
        var raw = window.localStorage.getItem(storageKey);
        if (!raw) { return false; }
        var state = JSON.parse(raw);
        if (!state) { return false; }

        accumulatedMs = parseInt(state.accumulatedMs, 10) || 0;
        isRunning = !!state.isRunning;
        startTime = parseInt(state.startTime, 10) || Date.now();
        firstStartedAt = parseInt(state.firstStartedAt, 10) || startTime;

        if (commentsField && state.comments !== undefined) {
          commentsField.value = state.comments;
        }
        if (activityField && state.activityId) {
          activityField.value = state.activityId;
        }
        if (issueField && state.issueId) {
          issueField.value = state.issueId;
        }
        if (dateField && state.spentOn) {
          dateField.value = state.spentOn;
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    function saveState() {
      if (hasBeenSaved) { return; }
      try {
        var state = {
          startTime: startTime,
          firstStartedAt: firstStartedAt,
          accumulatedMs: accumulatedMs,
          isRunning: isRunning,
          comments: commentsField ? commentsField.value : '',
          activityId: activityField ? activityField.value : '',
          issueId: issueField ? issueField.value : '',
          spentOn: dateField ? dateField.value : '',
          lastSavedAt: Date.now()
        };
        window.localStorage.setItem(storageKey, JSON.stringify(state));
      } catch (e) { /* localStorage plein ou indisponible */ }
    }

    function clearState() {
      try {
        window.localStorage.removeItem(storageKey);
      } catch (e) { /* ignore */ }
    }

    function getElapsedMs() {
      if (isRunning) {
        return accumulatedMs + (Date.now() - startTime);
      }
      return accumulatedMs;
    }

    function updateDisplay() {
      var elapsedSeconds = getElapsedMs() / 1000;
      if (digitsEl) {
        digitsEl.textContent = formatDigits(elapsedSeconds);
      }
      // Updates the window title with the running time
      document.title = (isRunning ? '⏱ ' : '⏸ ') + formatDigits(elapsedSeconds) + ' — ' + projectName;
    }

    /* -------------------------------------------------------------- */
    /* Browser notifications: long continuous run, scheduled check-ins */
    /* -------------------------------------------------------------- */

    function requestNotificationPermission() {
      if (!('Notification' in window)) { return; }
      if (Notification.permission === 'default') { Notification.requestPermission(); }
    }

    function sendBrowserNotification(title, body) {
      if (!('Notification' in window) || Notification.permission !== 'granted') { return; }
      try {
        var notification = new Notification(title, { body: body, tag: 'redmine_quick_timelog_' + Date.now() });
        notification.onclick = function () {
          window.focus();
          notification.close();
        };
      } catch (e) { /* some contexts (no active service worker, insecure origin) reject silently */ }
    }

    // Runs on every tick. Two independent checks, both only while the timer is running:
    //   - has it now been running continuously for longer than the configured limit?
    //   - has the wall clock just passed one of the configured "check-in" times?
    function checkTimerNotifications() {
      if (!isRunning) { return; }

      var maxHours = parseFloat(CONFIG.timerNotifyHours);
      if (maxHours > 0 && !notifiedLongRun && getElapsedMs() >= maxHours * 3600000) {
        notifiedLongRun = true;
        sendBrowserNotification(
          t('timer_notify_long_title', 'Timer running for a while'),
          t('timer_notify_long_body', 'This timer has been running continuously for over ' + maxHours + ' hours.')
        );
      }

      var checkpoints = CONFIG.timerNotifyTimes || [];
      if (!checkpoints.length) { return; }

      var now = new Date();
      var todayKey = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate();
      checkpoints.forEach(function (hhmm) {
        var match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
        if (!match) { return; }

        var target = new Date(now.getTime());
        target.setHours(parseInt(match[1], 10), parseInt(match[2], 10), 0, 0);
        var key = todayKey + ' ' + hhmm;
        if (now.getTime() >= target.getTime() && !notifiedCheckpoints[key]) {
          notifiedCheckpoints[key] = true;
          var template = t('timer_notify_time_body_template', 'It is past %{time} and the timer is still running.');
          sendBrowserNotification(
            t('timer_notify_time_title', 'Scheduled check-in'),
            template.replace('%{time}', hhmm)
          );
        }
      });
    }

    function updateControlsUI() {
      if (isRunning) {
        if (toggleIcon) { toggleIcon.textContent = '⏸'; }
        if (toggleLabel) { toggleLabel.textContent = t('timer_pause', 'Pause'); }
        if (toggleBtn) {
          toggleBtn.className = 'qtl-timer__btn qtl-timer__btn--secondary';
          toggleBtn.title = t('timer_pause', 'Pause');
        }
        if (stateLabelEl) {
          stateLabelEl.textContent = t('timer_running', 'Chronomètre en cours…');
          stateLabelEl.className = 'qtl-timer__state-label qtl-timer__state-label--running';
        }
        if (pulseEl) {
          pulseEl.className = 'qtl-timer__pulse-indicator qtl-timer__pulse-indicator--active';
        }
      } else {
        if (toggleIcon) { toggleIcon.textContent = '▶'; }
        if (toggleLabel) { toggleLabel.textContent = t('timer_resume', 'Reprendre'); }
        if (toggleBtn) {
          toggleBtn.className = 'qtl-timer__btn qtl-timer__btn--primary';
          toggleBtn.title = t('timer_resume', 'Reprendre');
        }
        if (stateLabelEl) {
          stateLabelEl.textContent = t('timer_paused', 'En pause');
          stateLabelEl.className = 'qtl-timer__state-label qtl-timer__state-label--paused';
        }
        if (pulseEl) {
          pulseEl.className = 'qtl-timer__pulse-indicator qtl-timer__pulse-indicator--paused';
        }
      }
    }

    function startTicking() {
      if (timerInterval) { clearInterval(timerInterval); }
      timerInterval = setInterval(function () {
        updateDisplay();
        checkTimerNotifications();
      }, 500);
      updateDisplay();
    }

    function togglePause() {
      if (isRunning) {
        // Pausing
        accumulatedMs = getElapsedMs();
        isRunning = false;
      } else {
        // Resuming: a fresh continuous run starts, so the long-run notification (if
        // any) is free to fire again once the new run itself gets long enough.
        startTime = Date.now();
        isRunning = true;
        notifiedLongRun = false;
      }
      saveState();
      updateControlsUI();
      updateDisplay();
    }

    function resetTimer() {
      var confirmMsg = t('timer_reset_confirm', 'Remettre le chronomètre à zéro ?');
      if (window.confirm(confirmMsg)) {
        accumulatedMs = 0;
        startTime = Date.now();
        firstStartedAt = startTime;
        isRunning = true;
        notifiedLongRun = false;
        saveState();
        updateControlsUI();
        updateDisplay();
      }
    }

    // "14:32" -- local clock time, always zero-padded to two digits.
    function formatClockTime(date) {
      var hours = date.getHours();
      var minutes = date.getMinutes();
      return (hours < 10 ? '0' : '') + hours + ':' + (minutes < 10 ? '0' : '') + minutes;
    }

    // "14:32 > 16:10" -- the real schedule, from the first start to the stop. Any pauses
    // do not shorten the range: this follows the same convention as a hand-written
    // schedule, not a minute-by-minute account of time actually worked.
    function scheduleRangeLabel() {
      return formatClockTime(new Date(firstStartedAt)) + ' > ' + formatClockTime(new Date());
    }

    // Affichage des messages flash
    function showMessage(kind, text) {
      if (!messagesEl) { return; }
      messagesEl.innerHTML = '';
      if (!text) { return; }
      var div = document.createElement('div');
      div.className = kind === 'error' ? 'flash error' : 'flash notice';
      div.textContent = text;
      messagesEl.appendChild(div);
    }

    /* -------------------------------------------------------------- */
    /* Keeping the session alive at all times ("never sign out")        */
    /* -------------------------------------------------------------- */
    var lastPingTime = 0;
    var keepaliveTimer = null;

    function sendKeepalive() {
      if (!keepaliveUrl) { return; }
      var headers = {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      };
      var token = csrfToken();
      if (token) { headers['X-CSRF-Token'] = token; }

      fetch(keepaliveUrl, {
        method: 'GET',
        headers: headers,
        credentials: 'same-origin'
      })
        .then(function (response) {
          if (!response.ok) { throw new Error('Keepalive error: ' + response.status); }
          return response.json();
        })
        .then(function () {
          lastPingTime = Date.now();
          if (statusEl) {
            statusEl.className = 'qtl-timer__status qtl-timer__status--connected';
            var nowStr = (new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            statusEl.title = t('timer_keepalive_hint', 'Session active — actualisée à ') + nowStr;
          }
          if (statusTextEl) {
            statusTextEl.textContent = t('timer_connected', 'Connecté');
          }
        })
        .catch(function () {
          if (statusEl) {
            statusEl.className = 'qtl-timer__status qtl-timer__status--warning';
          }
          if (statusTextEl) {
            statusTextEl.textContent = t('timer_reconnecting', 'Reconnexion…');
          }
        });
    }

    function startKeepalive() {
      sendKeepalive();
      // Battement de cœur toutes les 2 minutes (120 secondes)
      if (keepaliveTimer) { clearInterval(keepaliveTimer); }
      keepaliveTimer = setInterval(sendKeepalive, 120 * 1000);
    }

    // Resume pinging as soon as the user comes back to the popup
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - lastPingTime > 60 * 1000) {
        sendKeepalive();
      }
    });

    /* -------------------------------------------------------------- */
    /* Stopper et enregistrer (ferme la popup)                        */
    /* -------------------------------------------------------------- */
    function stopAndSave() {
      var totalSeconds = getElapsedMs() / 1000;
      if (totalSeconds < 1) {
        showMessage('error', t('timer_error_too_short', 'Le temps écoulé est trop court.'));
        return;
      }

      // Validation native des champs obligatoires (ex. commentaire requis)
      if (form && form.reportValidity && !form.reportValidity()) {
        return;
      }

      var formattedHours = formatHoursValue(totalSeconds);
      if (hoursField) {
        hoursField.value = formattedHours;
      }

      var body = new FormData(form);
      // Keeps the real schedule for reference, in the same custom field the quick-entry
      // widget uses (absent if an administrator removed it).
      if (CONFIG.scheduleCustomFieldId) {
        body.append('time_entry[custom_field_values][' + CONFIG.scheduleCustomFieldId + ']', scheduleRangeLabel());
      }

      if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.classList.add('qtl-timer__btn--busy');
        stopBtn.innerHTML = '<span class="qtl-timer__btn-icon">⏳</span> <span>' +
          t('timer_saving', 'Enregistrement…') + '</span>';
      }
      showMessage(null, '');

      var headers = {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      };
      var token = csrfToken();
      if (token) { headers['X-CSRF-Token'] = token; }

      fetch(createUrl, {
        method: 'POST',
        headers: headers,
        credentials: 'same-origin',
        body: body
      })
        .then(function (response) {
          return response.json().catch(function () { return null; }).then(function (payload) {
            if (!response.ok || payload === null) {
              var error = new Error('create_failed');
              error.payload = payload || {};
              throw error;
            }
            return payload;
          });
        })
        .then(function (response) {
          hasBeenSaved = true;
          clearState();

          if (timerInterval) { clearInterval(timerInterval); }
          if (keepaliveTimer) { clearInterval(keepaliveTimer); }

          showMessage('notice', response.message || t('timer_saved', 'Temps enregistré avec succès !'));

          // Notify the parent window, if one is open
          try {
            if (window.opener && !window.opener.closed) {
              window.opener.postMessage({ type: 'qtl_time_logged', projectId: projectId }, '*');
            }
          } catch (e) { /* ignore */ }

          // Fermeture automatique de la popup
          setTimeout(function () {
            window.close();
            // If window.close() was blocked by the browser (e.g. a regular tab):
            if (!window.closed) {
              if (stopBtn) {
                stopBtn.disabled = false;
                stopBtn.innerHTML = '<span>' + t('timer_close', 'Fermer la fenêtre') + '</span>';
                stopBtn.onclick = function () { window.close(); };
              }
            }
          }, 600);
        })
        .catch(function (error) {
          if (stopBtn) {
            stopBtn.disabled = false;
            stopBtn.classList.remove('qtl-timer__btn--busy');
            stopBtn.innerHTML = '<span class="qtl-timer__btn-icon">⏹</span> <span>' +
              t('timer_stop', 'Stopper et enregistrer') + '</span>';
          }
          var payload = error.payload || {};
          var errors = payload.errors || [];
          showMessage('error', errors.length ? errors.join(' — ') : t('error_generic', 'Enregistrement impossible.'));
        });
    }

    /* -------------------------------------------------------------- */
    /* Events                                                          */
    /* -------------------------------------------------------------- */
    if (toggleBtn) {
      toggleBtn.addEventListener('click', togglePause);
    }
    if (resetBtn) {
      resetBtn.addEventListener('click', resetTimer);
    }
    if (stopBtn) {
      stopBtn.addEventListener('click', stopAndSave);
    }

    // Saves live on every keystroke in the textarea
    if (commentsField) {
      commentsField.addEventListener('input', saveState);
    }
    if (activityField) {
      activityField.addEventListener('change', saveState);
    }
    if (issueField) {
      issueField.addEventListener('change', saveState);
    }
    if (dateField) {
      dateField.addEventListener('change', saveState);
    }

    // Warns before closing while the timer hasn't been saved yet
    window.addEventListener('beforeunload', function (event) {
      if (!hasBeenSaved && getElapsedMs() > 15000) {
        event.preventDefault();
        event.returnValue = t('timer_warn_running', 'Un chronomètre est en cours. Voulez-vous vraiment quitter ?');
        return event.returnValue;
      }
    });

    // Startup
    var hadSaved = loadSavedState();
    if (!hadSaved) {
      // A brand new timer: starts right away
      startTime = Date.now();
      accumulatedMs = 0;
      isRunning = true;
      saveState();
    }

    updateControlsUI();
    startTicking();
    startKeepalive();
    requestNotificationPermission();
  }

  function boot() {
    var timerRoots = document.querySelectorAll('[data-qtl-timer]');
    for (var i = 0; i < timerRoots.length; i++) {
      initTimer(timerRoots[i]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
