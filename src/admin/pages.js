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
    --ink-muted-48: #7a7a7a;
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
  .edit-row { display: none; margin-top: 16px; gap: 8px; }
  .actions { display: flex; gap: 8px; align-items: center; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 12px 8px; border-bottom: 1px solid var(--hairline); }
  tr:nth-child(even) { background: var(--parchment); }
  dialog { border: none; border-radius: 18px; padding: 24px; max-width: 420px; }
  dialog::backdrop { background: rgba(0,0,0,0.4); }
  .empty { color: var(--ink-muted-48); font-size: 14px; padding: 16px 0; }
  .error-banner {
    background: #fff0f0; color: #a30000; border-radius: 11px;
    padding: 12px 16px; margin-bottom: 16px; display: none;
  }
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

  function clearError() {
    var banner = document.getElementById('error-banner');
    banner.style.display = 'none';
    banner.textContent = '';
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
      }
      function onCancel() { cleanup(); resolve(false); }
      function onApply() { cleanup(); resolve(true); }
      cancelBtn.addEventListener('click', onCancel);
      applyBtn.addEventListener('click', onApply);
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
            .then(refresh)
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
    var saveBtn = el('button', { className: 'btn-primary', text: 'Save' });
    saveBtn.addEventListener('click', function () {
      if (!input.value) return;
      confirmDialog('Apply this value to ' + item.key + '?').then(function (ok) {
        if (!ok) return;
        clearError();
        api('/admin/api/config/' + encodeURIComponent(item.key), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: input.value }),
        })
          .then(refresh)
          .catch(function (err) { showError(err.message); });
      });
    });
    editRow.appendChild(input);
    editRow.appendChild(saveBtn);
    card.appendChild(editRow);

    editBtn.addEventListener('click', function () {
      editRow.style.display = editRow.style.display === 'flex' ? 'none' : 'flex';
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

  function loadAudit() {
    return api('/admin/api/audit').then(function (body) {
      var container = document.getElementById('audit-log');
      container.innerHTML = '';
      if (!body.entries.length) {
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
    });
  }

  function refresh() {
    return Promise.all([loadConfig(), loadAudit()]);
  }

  clearError();
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
    <div id="error-banner" class="error-banner"></div>

    <h2>Configuration</h2>
    <div id="config-list"></div>

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
