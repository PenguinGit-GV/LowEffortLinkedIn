// Admin dashboard — plans/apple-design.md for the visual language,
// plans/env-var-ui-feature-spec.md §2 for the UI spec.
//
// Same "no interpolated request data" discipline as ../pages.js: this is a
// static HTML+CSS+JS shell. Every dynamic value (config keys/values, audit
// rows) is fetched client-side and inserted via textContent/createElement,
// never string-built HTML — an admin-entered value (e.g. a channel ID list)
// could otherwise round-trip into a stored-XSS vector against other admins.

const { requireAdminSession } = require('./auth');

const STYLE = `
  :root {
    --primary: #0066cc;
    --primary-focus: #0071e3;
    --sky-link: #2997ff;
    --ink: #1d1d1f;
    --ink-muted-80: #333333;
    /* Used for 12px meta text on white — must stay ≥ 4.5:1 (WCAG AA for
       normal-size text); #7a7a7a was ~4.48:1, just under. */
    --ink-muted-48: #707070;
    --canvas: #ffffff;
    --parchment: #f5f5f7;
    --hairline: #e0e0e0;
    --tile-dark: #272729;
    --on-dark: #ffffff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "SF Pro Text", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 17px;
    line-height: 1.47;
    letter-spacing: -0.374px;
    color: var(--ink);
    background: var(--parchment);
  }
  header {
    background: #000;
    color: var(--on-dark);
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 24px;
    font-size: 12px;
    letter-spacing: -0.12px;
  }
  header a { color: var(--on-dark); text-decoration: none; }
  main { max-width: 900px; margin: 0 auto; padding: 48px 24px 80px; }
  h1 {
    font-family: "SF Pro Display", system-ui, sans-serif;
    font-size: 40px; font-weight: 600; letter-spacing: 0; margin: 0 0 8px;
  }
  h2 {
    font-family: "SF Pro Display", system-ui, sans-serif;
    font-size: 28px; font-weight: 600; margin: 48px 0 16px;
  }
  p.lead { color: var(--ink-muted-80); margin: 0 0 32px; }
  .card {
    background: var(--canvas);
    border-radius: 18px;
    border: 1px solid var(--hairline);
    padding: 24px;
    margin-bottom: 12px;
  }
  .card.sensitive { background: var(--tile-dark); color: var(--on-dark); border-color: var(--tile-dark); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .key { font-weight: 600; font-size: 17px; }
  .meta { font-size: 12px; color: var(--ink-muted-48); margin-top: 4px; }
  .sensitive .meta { color: #cccccc; }
  .value { font-size: 14px; font-family: ui-monospace, SFMono-Regular, monospace; word-break: break-all; margin-top: 4px; }
  .badge {
    display: inline-block; font-size: 12px; font-weight: 600;
    padding: 2px 10px; border-radius: 9999px; background: var(--parchment);
    color: var(--ink-muted-80); margin-left: 8px;
  }
  .sensitive .badge { background: rgba(255,255,255,0.15); color: var(--on-dark); }
  button {
    font-family: inherit; font-size: 14px; border: none; cursor: pointer;
    border-radius: 9999px; padding: 8px 16px;
  }
  .btn-primary { background: var(--primary); color: #fff; }
  .btn-primary:active { transform: scale(0.95); }
  .btn-secondary { background: transparent; border: 1px solid var(--primary); color: var(--primary); }
  .sensitive .btn-secondary { border-color: var(--sky-link); color: var(--sky-link); }
  input[type=text] {
    font-family: inherit; font-size: 17px; padding: 12px 20px;
    border-radius: 9999px; border: 1px solid var(--hairline); width: 100%; max-width: 360px;
  }
  .edit-row { display: none; margin-top: 16px; gap: 8px; flex-wrap: wrap; }
  .actions { display: flex; gap: 8px; align-items: center; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 12px 8px; border-bottom: 1px solid var(--hairline); }
  tr:nth-child(even) { background: var(--parchment); }
  /* Wide tables (audit log, restore plan) scroll inside their own container
     on narrow screens instead of forcing whole-page horizontal scroll. */
  #audit-log, #restore-plan { overflow-x: auto; }
  @media (max-width: 480px) {
    input[type=text] { max-width: 100%; }
  }
  /* Keeps the restore file input keyboard-reachable (display:none would take
     it out of the tab order entirely) while hiding it visually; its label is
     styled as the visible button. */
  .visually-hidden-input {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  label.btn-secondary:focus-within { outline: 2px solid var(--primary-focus); outline-offset: 2px; }
  .pager { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
  dialog { border: none; border-radius: 18px; padding: 24px; max-width: 420px; }
  dialog::backdrop { background: rgba(0,0,0,0.4); }
  .empty { color: var(--ink-muted-48); font-size: 14px; padding: 16px 0; }
  .error-banner {
    background: #fff0f0; color: #a30000; border-radius: 11px;
    padding: 12px 16px; margin-bottom: 16px; display: none;
  }
  .info-banner {
    background: var(--parchment); color: var(--ink); border-radius: 11px;
    padding: 12px 16px; margin-bottom: 16px; display: none;
  }
  .badge-ok { background: rgba(0,102,204,0.12); color: var(--primary); }
  .badge-bad { background: #fff0f0; color: #a30000; }
`;

// Plain-quoted, no template literals inside — this string is itself built
// with a template literal in this file, and an inner backtick would
// terminate it early.
const CLIENT_SCRIPT = `
(function () {
  function el(tag, opts) {
    var e = document.createElement(tag);
    opts = opts || {};
    if (opts.className) e.className = opts.className;
    if (opts.text !== undefined) e.textContent = opts.text;
    return e;
  }

  function showError(message) {
    var banner = document.getElementById('error-banner');
    banner.textContent = message;
    banner.style.display = 'block';
  }

  function showInfo(message) {
    var banner = document.getElementById('info-banner');
    banner.textContent = message;
    banner.style.display = 'block';
  }

  function clearError() {
    var errorBanner = document.getElementById('error-banner');
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
    var infoBanner = document.getElementById('info-banner');
    infoBanner.style.display = 'none';
    infoBanner.textContent = '';
  }

  function api(path, options) {
    return fetch(path, options || {}).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login';
        return Promise.reject(new Error('not authenticated'));
      }
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || ('request failed: ' + res.status));
        return body;
      });
    });
  }

  function confirmDialog(message) {
    return new Promise(function (resolve) {
      var dialog = document.getElementById('confirm-dialog');
      document.getElementById('confirm-message').textContent = message;
      dialog.showModal();
      var cancelBtn = document.getElementById('confirm-cancel');
      var applyBtn = document.getElementById('confirm-apply');
      function cleanup() {
        dialog.close();
        cancelBtn.removeEventListener('click', onCancel);
        applyBtn.removeEventListener('click', onApply);
        dialog.removeEventListener('cancel', onCancel);
      }
      function onCancel() { cleanup(); resolve(false); }
      function onApply() { cleanup(); resolve(true); }
      cancelBtn.addEventListener('click', onCancel);
      applyBtn.addEventListener('click', onApply);
      // The dialog's native 'cancel' event fires on ESC-key dismissal.
      // Without this, ESC bypasses cleanup() entirely and leaks these
      // listeners — the next confirmDialog() call stacks a second pair on
      // the same shared buttons, so one real click fires every stacked
      // handler at once (confirmed: a single Apply click fired two PUT
      // requests and wrote two audit-log rows after one prior ESC-dismissal).
      dialog.addEventListener('cancel', onCancel);
    });
  }

  function reloadBadgeText(reload) {
    if (reload === 'mutate') return 'applies live';
    if (reload === 'cron') return 'restarts schedule';
    if (reload === 'restart') return 'requires restart';
    return reload;
  }

  function renderConfigRow(item) {
    var card = el('div', { className: 'card' + (item.sensitive ? ' sensitive' : '') });

    var row = el('div', { className: 'row' });
    var left = el('div');
    var keyLine = el('div', { className: 'key', text: item.key });
    var badgeWrap = el('span');
    badgeWrap.appendChild(el('span', { className: 'badge', text: item.source }));
    badgeWrap.appendChild(el('span', { className: 'badge', text: reloadBadgeText(item.reload) }));
    keyLine.appendChild(badgeWrap);
    left.appendChild(keyLine);
    left.appendChild(el('div', { className: 'value', text: item.value }));
    if (item.updatedAt) {
      left.appendChild(el('div', {
        className: 'meta',
        text: 'changed by ' + item.updatedBy + ' on ' + new Date(item.updatedAt).toLocaleString(),
      }));
    }
    row.appendChild(left);

    var actions = el('div', { className: 'actions' });
    var editBtn = el('button', { className: 'btn-secondary', text: 'Edit' });
    actions.appendChild(editBtn);
    if (item.source === 'override') {
      var resetBtn = el('button', { className: 'btn-secondary', text: 'Reset' });
      resetBtn.addEventListener('click', function () {
        confirmDialog('Reset ' + item.key + ' to its Railway default?').then(function (ok) {
          if (!ok) return;
          clearError();
          api('/admin/api/config/' + encodeURIComponent(item.key), { method: 'DELETE' })
            .then(function (body) {
              if (body.reload === 'restart') {
                showInfo(item.key + ' reset — it takes effect after the next restart (System Health → Restart service).');
              }
              return refresh();
            })
            .catch(function (err) { showError(err.message); });
        });
      });
      actions.appendChild(resetBtn);
    }
    row.appendChild(actions);
    card.appendChild(row);

    var editRow = el('div', { className: 'edit-row' });
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = item.sensitive ? 'Enter new value' : item.value;
    if (!item.sensitive) input.value = item.value;
    // Re-acquiring your own lock refreshes its TTL (locks.js) — without
    // this, a slow typist's 2-minute lock lapses mid-edit and another
    // admin can grab the key while they're still typing.
    var lockRefreshedAt = 0;
    input.addEventListener('input', function () {
      var now = Date.now();
      if (now - lockRefreshedAt < 30000) return;
      lockRefreshedAt = now;
      api('/admin/api/config/' + encodeURIComponent(item.key) + '/lock', { method: 'POST' }).catch(function () {});
    });
    var saveBtn = el('button', { className: 'btn-primary', text: 'Save' });
    saveBtn.addEventListener('click', function () {
      if (!input.value) {
        showError('Enter a value for ' + item.key + ' before saving.');
        return;
      }
      confirmDialog('Apply this value to ' + item.key + '?').then(function (ok) {
        if (!ok) return;
        clearError();
        api('/admin/api/config/' + encodeURIComponent(item.key), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: input.value }),
        })
          .then(function (body) {
            if (body.reload === 'restart') {
              showInfo(item.key + ' saved — it takes effect after the next restart (System Health → Restart service).');
            }
            return refresh();
          })
          .catch(function (err) { showError(err.message); });
      });
    });
    editRow.appendChild(input);
    editRow.appendChild(saveBtn);
    card.appendChild(editRow);

    editBtn.addEventListener('click', function () {
      if (editRow.style.display === 'flex') {
        // Closing without saving — release any lock we're holding so
        // another admin isn't blocked by an abandoned edit.
        api('/admin/api/config/' + encodeURIComponent(item.key) + '/lock', { method: 'DELETE' }).catch(function () {});
        editRow.style.display = 'none';
        return;
      }
      clearError();
      api('/admin/api/config/' + encodeURIComponent(item.key) + '/lock', { method: 'POST' })
        .then(function () { editRow.style.display = 'flex'; })
        .catch(function (err) { showError(err.message); });
    });

    return card;
  }

  function loadConfig() {
    return api('/admin/api/config').then(function (body) {
      var list = document.getElementById('config-list');
      list.innerHTML = '';
      if (!body.vars.length) {
        list.appendChild(el('div', { className: 'empty', text: 'Nothing manageable is configured yet.' }));
        return;
      }
      body.vars.forEach(function (item) { list.appendChild(renderConfigRow(item)); });
    });
  }

  function renderAuditRow(entry) {
    var tr = document.createElement('tr');
    [entry.key, entry.action, entry.old_value_display || String.fromCharCode(8212),
      entry.new_value_display || String.fromCharCode(8212), entry.changed_by,
      new Date(entry.changed_at).toLocaleString()].forEach(function (text) {
      var td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    return tr;
  }

  var AUDIT_PER_PAGE = 20; // mirrors the server's perPage (admin/api.js)
  var auditPage = 1;

  function renderAuditPager(container, entryCount) {
    var pager = el('div', { className: 'pager' });
    var newer = el('button', { className: 'btn-secondary', text: 'Newer' });
    var label = el('span', { className: 'meta', text: 'Page ' + auditPage });
    var older = el('button', { className: 'btn-secondary', text: 'Older' });
    newer.disabled = auditPage <= 1;
    // A short page means there is nothing older; a full page might have more.
    older.disabled = entryCount < AUDIT_PER_PAGE;
    function go(delta) {
      auditPage += delta;
      loadAudit().catch(function (err) { showError(err.message); });
    }
    newer.addEventListener('click', function () { go(-1); });
    older.addEventListener('click', function () { go(1); });
    pager.appendChild(newer);
    pager.appendChild(label);
    pager.appendChild(older);
    container.appendChild(pager);
  }

  function loadAudit() {
    return api('/admin/api/audit?page=' + auditPage).then(function (body) {
      var container = document.getElementById('audit-log');
      container.innerHTML = '';
      if (!body.entries.length && auditPage === 1) {
        container.appendChild(el('div', { className: 'empty', text: 'No changes yet.' }));
        return;
      }
      var table = document.createElement('table');
      var thead = document.createElement('thead');
      var headRow = document.createElement('tr');
      ['Key', 'Action', 'Old', 'New', 'By', 'When'].forEach(function (text) {
        var th = document.createElement('th');
        th.textContent = text;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      body.entries.forEach(function (entry) { tbody.appendChild(renderAuditRow(entry)); });
      table.appendChild(tbody);
      container.appendChild(table);
      // Rendered whenever there can be another page in either direction:
      // any page past the first (so there is always a way back), or a full
      // first page (there may be older entries).
      if (auditPage > 1 || body.entries.length >= AUDIT_PER_PAGE) {
        renderAuditPager(container, body.entries.length);
      }
    });
  }

  function statusBadgeClass(status) {
    return status === 'up' || status === 'configured' || status === 'mock' ? 'badge-ok' : 'badge-bad';
  }

  function loadHealth() {
    return api('/admin/api/health').then(function (body) {
      var container = document.getElementById('health-status');
      container.innerHTML = '';
      // environment is a descriptive label, not a health status — it never
      // gets the ok/bad coloring the other three probes do.
      var envPill = el('span', { className: 'badge', text: 'environment: ' + body.environment });
      envPill.style.marginRight = '8px';
      container.appendChild(envPill);
      ['db', 'slack', 'linkedin'].forEach(function (key) {
        var pill = el('span', { className: 'badge ' + statusBadgeClass(body[key]), text: key + ': ' + body[key] });
        pill.style.marginRight = '8px';
        container.appendChild(pill);
      });
    });
  }

  function downloadJson(filename, data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function planRowDetail(row) {
    // Masked before/after (see src/admin/backup.js's planRestore) — never
    // the raw value, so a sensitive key's diff doesn't put a secret on
    // screen in plaintext.
    if (row.currentDisplay !== undefined && row.newDisplay !== undefined) {
      return row.currentDisplay + ' → ' + row.newDisplay;
    }
    return row.reason || row.from || '';
  }

  function renderRestorePlan(plan) {
    var container = document.getElementById('restore-plan');
    container.innerHTML = '';
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['Key', 'Status', 'Detail'].forEach(function (text) {
      var th = document.createElement('th');
      th.textContent = text;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    plan.forEach(function (row) {
      var tr = document.createElement('tr');
      [row.key, row.status, planRowDetail(row)].forEach(function (text) {
        var td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  function wireBackupRestore() {
    document.getElementById('backup-btn').addEventListener('click', function () {
      clearError();
      api('/admin/api/backup')
        .then(function (body) { downloadJson('config-backup-' + Date.now() + '.json', body); })
        .catch(function (err) { showError(err.message); });
    });

    var fileInput = document.getElementById('restore-file');
    var pendingEntries = null;
    var confirmBtn = document.getElementById('confirm-restore-btn');
    confirmBtn.style.display = 'none';

    fileInput.addEventListener('change', function () {
      var file = fileInput.files[0];
      if (!file) return;
      clearError();
      var reader = new FileReader();
      reader.onload = function () {
        var parsed;
        try {
          parsed = JSON.parse(reader.result);
        } catch (e) {
          showError('That file is not valid JSON.');
          return;
        }
        pendingEntries = parsed.entries || [];
        api('/admin/api/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entries: pendingEntries, dryRun: true }),
        })
          .then(function (body) {
            renderRestorePlan(body.plan);
            confirmBtn.style.display = 'inline-block';
          })
          .catch(function (err) { showError(err.message); });
      };
      reader.readAsText(file);
    });

    confirmBtn.addEventListener('click', function () {
      if (!pendingEntries) return;
      confirmDialog('Apply this restore? Values shown as "would-change" above will be overwritten.').then(
        function (ok) {
          if (!ok) return;
          clearError();
          api('/admin/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: pendingEntries, dryRun: false }),
          })
            .then(function (body) {
              // The server applies sequentially and keeps going on a
              // per-key failure — a restore that partially fails must not
              // look identical to one that fully succeeded.
              var failed = body.results.filter(function (r) { return r.status === 'error'; });
              renderRestorePlan(body.results);
              pendingEntries = null;
              confirmBtn.style.display = 'none';
              fileInput.value = '';
              if (failed.length) {
                showError(failed.length + ' of ' + body.results.length + ' entries could not be applied — see the table above.');
              } else {
                document.getElementById('restore-plan').innerHTML = '';
              }
              return refresh();
            })
            .catch(function (err) { showError(err.message); });
        }
      );
    });
  }

  function wireHealthAndRestart() {
    document.getElementById('check-health-btn').addEventListener('click', function () {
      clearError();
      loadHealth().catch(function (err) { showError(err.message); });
    });
    document.getElementById('restart-btn').addEventListener('click', function () {
      confirmDialog(
        'Restart the service now? It will be briefly unavailable while the platform relaunches it.'
      ).then(function (ok) {
        if (!ok) return;
        clearError();
        api('/admin/api/restart', { method: 'POST' })
          .then(function (body) { showInfo(body.message); })
          .catch(function (err) { showError(err.message); });
      });
    });
  }

  function refresh() {
    return Promise.all([loadConfig(), loadAudit(), loadHealth()]);
  }

  clearError();
  wireHealthAndRestart();
  wireBackupRestore();
  refresh().catch(function (err) { showError(err.message); });
})();
`;

function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Environment Variables — Admin</title>
  <style>${STYLE}</style>
</head>
<body>
  <header>
    <span>LowEffortLinkedIn Admin</span>
    <form method="post" action="/admin/logout"><button class="btn-secondary" style="color:#fff;border-color:#fff">Sign out</button></form>
  </header>
  <main>
    <h1>Environment Variables</h1>
    <p class="lead">Manage a subset of configuration without touching Railway. Bootstrap secrets, and who can access this page, stay Railway-only by design.</p>
    <div id="error-banner" class="error-banner" role="alert"></div>
    <div id="info-banner" class="info-banner" role="status"></div>

    <h2>Configuration</h2>
    <div id="config-list"></div>

    <h2>System Health</h2>
    <div class="card row">
      <div id="health-status"></div>
      <div class="actions">
        <button class="btn-secondary" id="check-health-btn">Check now</button>
        <button class="btn-secondary" id="restart-btn">Restart service</button>
      </div>
    </div>

    <h2>Backup &amp; Restore</h2>
    <p class="lead" style="margin-bottom:16px">Exports include the decrypted values of anything currently overridden — treat the downloaded file like any other secret.</p>
    <div class="card">
      <div class="row">
        <button class="btn-secondary" id="backup-btn">Download backup</button>
        <label class="btn-secondary" style="cursor:pointer">
          Restore from file
          <input type="file" id="restore-file" accept="application/json" class="visually-hidden-input">
        </label>
        <button class="btn-primary" id="confirm-restore-btn">Apply restore</button>
      </div>
      <div id="restore-plan" style="margin-top:16px"></div>
    </div>

    <h2>Audit Log</h2>
    <div id="audit-log"></div>

    <dialog id="confirm-dialog">
      <p id="confirm-message"></p>
      <div class="actions" style="justify-content:flex-end">
        <button class="btn-secondary" id="confirm-cancel">Cancel</button>
        <button class="btn-primary" id="confirm-apply">Apply</button>
      </div>
    </dialog>
  </main>
  <script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

function registerAdminPages(router, { config }) {
  router.get('/admin', requireAdminSession(config), (_req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(renderDashboard());
  });
}

module.exports = { renderDashboard, registerAdminPages };
