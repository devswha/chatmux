(function chatmuxAppLauncher() {
  var VERSION = window.__APP_VERSION__ || '';
  var mockState = {
    activeTarget: { kind: 'launcher', name: 'ChatMux', url: null },
    remoteServers: [],
    selectedRemoteServerId: null,
    localServerRunning: false,
    localWebUrl: 'http://localhost:3001',
    localStartupLogs: [],
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function error(message) {
    return new Error(message);
  }

  function exactOrigin(value) {
    var raw = String(value || '').trim();
    var parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw error('Enter a valid HTTP or HTTPS origin.');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password
      || parsed.origin !== raw
    ) {
      throw error('Remote URLs must be an exact HTTP or HTTPS origin without credentials or a path.');
    }
    return parsed.origin;
  }

  function remoteInput(server) {
    var name = String(server && server.name || '').trim();
    if (!name) throw error('Enter a name for the remote server.');
    return { name: name, url: exactOrigin(server && server.url) };
  }

  var mockBridge = {
    getState: function () { return Promise.resolve(clone(mockState)); },
    openLocal: function () {
      mockState.localServerRunning = true;
      mockState.activeTarget = { kind: 'local', name: 'ChatMux Local', url: mockState.localWebUrl };
      return Promise.resolve({ ok: true, data: clone(mockState) });
    },
    listRemoteServers: function () {
      return Promise.resolve({
        ok: true,
        data: { servers: clone(mockState.remoteServers), selectedId: mockState.selectedRemoteServerId },
      });
    },
    createRemoteServer: function (server) {
      var saved = remoteInput(server);
      var duplicate = mockState.remoteServers.some(function (item) { return item.url === saved.url; });
      if (duplicate) return Promise.resolve({ ok: false, error: 'That remote origin is already saved.' });
      var id = 'remote-' + Date.now().toString(36);
      mockState.remoteServers.push({ id: id, name: saved.name, url: saved.url });
      mockState.selectedRemoteServerId = id;
      return Promise.resolve({ ok: true, data: clone(mockState) });
    },
    updateRemoteServer: function (id, server) {
      var item = mockState.remoteServers.filter(function (candidate) { return candidate.id === id; })[0];
      if (!item) return Promise.resolve({ ok: false, error: 'Saved remote server not found.' });
      var saved = remoteInput(server);
      var duplicate = mockState.remoteServers.some(function (candidate) { return candidate.id !== id && candidate.url === saved.url; });
      if (duplicate) return Promise.resolve({ ok: false, error: 'That remote origin is already saved.' });
      item.name = saved.name;
      item.url = saved.url;
      return Promise.resolve({ ok: true, data: clone(mockState) });
    },
    deleteRemoteServer: function (id) {
      mockState.remoteServers = mockState.remoteServers.filter(function (item) { return item.id !== id; });
      if (mockState.selectedRemoteServerId === id) mockState.selectedRemoteServerId = null;
      return Promise.resolve({ ok: true, data: clone(mockState) });
    },
    testRemoteServer: function (id) {
      var item = mockState.remoteServers.filter(function (candidate) { return candidate.id === id; })[0];
      if (!item) return Promise.resolve({ ok: false, error: 'Saved remote server not found.' });
      return Promise.resolve({ ok: true, data: { targetId: id, health: { ok: true, url: item.url } } });
    },
    openRemoteServer: function (id) {
      var item = mockState.remoteServers.filter(function (candidate) { return candidate.id === id; })[0];
      if (!item) return Promise.resolve({ ok: false, error: 'Saved remote server not found.' });
      mockState.selectedRemoteServerId = id;
      mockState.activeTarget = { kind: 'remote', id: item.id, name: item.name, url: item.url };
      return Promise.resolve({ ok: true, data: clone(mockState) });
    },
    selectRemoteServer: function (id) {
      var item = mockState.remoteServers.filter(function (candidate) { return candidate.id === id; })[0];
      if (!item) return Promise.resolve({ ok: false, error: 'Saved remote server not found.' });
      mockState.selectedRemoteServerId = id;
      return Promise.resolve({ ok: true, data: clone(mockState) });
    },
    onStateChanged: function () { return function () {}; },
  };

  var bridge = window.chatmuxAppDesktop || mockBridge;
  var app = document.getElementById('app');
  var state = clone(mockState);
  var status = { message: '', tone: '' };
  var testResults = {};

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function messageFrom(errorValue) {
    return errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error');
  }

  function unwrap(result) {
    if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
      if (!result.ok) throw error(result.error || 'The request failed.');
      return result.data;
    }
    return result;
  }

  function isState(value) {
    return value && typeof value === 'object' && (
      Array.isArray(value.remoteServers)
      || Object.prototype.hasOwnProperty.call(value, 'activeTarget')
      || Object.prototype.hasOwnProperty.call(value, 'localServerRunning')
    );
  }

  function setState(next) {
    if (isState(next)) state = next;
    render();
  }

  function refresh() {
    return Promise.resolve(bridge.getState())
      .then(unwrap)
      .then(function (next) {
        setState(next);
        return next;
      });
  }

  function run(label, operation, onResult) {
    status = { message: label, tone: 'progress' };
    render();
    return Promise.resolve()
      .then(operation)
      .then(unwrap)
      .then(function (result) {
        if (isState(result)) setState(result);
        if (onResult) onResult(result);
        return refresh();
      })
      .then(function () {
        if (status.tone !== 'error') status = { message: '', tone: '' };
        render();
      })
      .catch(function (reason) {
        status = { message: messageFrom(reason), tone: 'error' };
        render();
      });
  }

  function targetLabel() {
    var target = state.activeTarget;
    if (!target || target.kind === 'launcher') return 'Launcher';
    return target.name || 'Selected target';
  }

  function localUrl() {
    return state.localWebUrl || 'http://localhost:3001';
  }

  function testMessage(id) {
    var result = testResults[id];
    if (!result) return '';
    return '<div class="test-result ' + esc(result.tone) + '">' + esc(result.message) + '</div>';
  }

  function remoteCard(server) {
    var selected = state.selectedRemoteServerId === server.id;
    var active = state.activeTarget && state.activeTarget.kind === 'remote' && state.activeTarget.id === server.id;
    return '<article class="remote-card' + (selected ? ' selected' : '') + '" data-server-id="' + esc(server.id) + '">' +
      '<div class="remote-card-head">' +
      '<span class="target-dot' + (active ? ' active' : '') + '"></span>' +
      '<div><h3>' + esc(server.name) + '</h3><p>' + esc(server.url) + '</p></div>' +
      (selected ? '<span class="badge">Selected</span>' : '') +
      '</div>' +
      '<label>Name<input data-remote-name value="' + esc(server.name) + '" autocomplete="off" /></label>' +
      '<label>Origin<input data-remote-url value="' + esc(server.url) + '" inputmode="url" spellcheck="false" autocomplete="off" /></label>' +
      testMessage(server.id) +
      '<div class="remote-actions">' +
      '<button class="button" data-action="select">Select</button>' +
      '<button class="button" data-action="save">Save</button>' +
      '<button class="button" data-action="test">Test</button>' +
      '<button class="button primary" data-action="open">Open</button>' +
      '<button class="button danger" data-action="delete">Delete</button>' +
      '</div>' +
      '</article>';
  }

  function render() {
    var remotes = Array.isArray(state.remoteServers) ? state.remoteServers : [];
    var localRunning = Boolean(state.localServerRunning);
    var remoteList = remotes.length
      ? remotes.map(remoteCard).join('')
      : '<div class="empty">No remote servers are saved. Add a trusted ChatMux origin to open it in a separate target.</div>';
    var version = VERSION ? '<span>v' + esc(VERSION) + '</span>' : '';

    app.innerHTML =
      '<header class="titlebar">' +
      '<div class="brand-mark">G</div>' +
      '<div class="brand"><strong>ChatMux</strong><span>Self-hosted targets</span></div>' +
      '<div class="active-target">Active: ' + esc(targetLabel()) + '</div>' +
      '</header>' +
      '<main>' +
      '<section class="page-heading"><div><p class="eyebrow">TARGETS</p><h1>Open ChatMux</h1><p>Run this checkout locally or select a saved remote origin.</p></div></section>' +
      '<section class="target-grid">' +
      '<article class="local-card">' +
      '<div class="card-heading"><div><p class="eyebrow">LOCAL</p><h2>ChatMux Local</h2><p class="origin">' + esc(localUrl()) + '</p></div><span class="status-chip ' + (localRunning ? 'ready' : '') + '">' + (localRunning ? 'Running' : 'On demand') + '</span></div>' +
      '<p class="description">Starts the built server from this checkout on loopback only.</p>' +
      '<div class="local-actions"><button class="button primary" data-action="open-local">Open local</button></div>' +
      '</article>' +
      '<section class="remote-section"><div class="section-heading"><div><p class="eyebrow">REMOTE</p><h2>Saved remote servers</h2><p>Each saved URL is an exact origin. Test and Open are the only network actions.</p></div></div>' +
      '<div class="new-remote"><label>Name<input id="new-remote-name" placeholder="Workstation" autocomplete="off" /></label><label>Origin<input id="new-remote-url" placeholder="https://chatmux.example.test" inputmode="url" spellcheck="false" autocomplete="off" /></label><button class="button primary" data-action="create">Add remote</button></div>' +
      '<div class="remote-list">' + remoteList + '</div>' +
      '</section>' +
      '</section>' +
      '</main>' +
      '<footer class="statusbar"><span class="status ' + esc(status.tone) + '">' + esc(status.message) + '</span><span class="target-summary">' + esc(localRunning ? 'Local ready' : 'Local on demand') + ' · ' + remotes.length + ' saved remote' + (remotes.length === 1 ? '' : 's') + '</span>' + version + '</footer>';
  }

  function cardServer(card) {
    return {
      id: card.getAttribute('data-server-id'),
      name: card.querySelector('[data-remote-name]').value,
      url: card.querySelector('[data-remote-url]').value,
    };
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-action]');
    if (!button) return;

    var action = button.getAttribute('data-action');
    if (action === 'open-local') {
      run('Opening ChatMux Local…', function () { return bridge.openLocal(); });
      return;
    }

    if (action === 'create') {
      var nameInput = document.getElementById('new-remote-name');
      var urlInput = document.getElementById('new-remote-url');
      run('Saving remote server…', function () {
        return bridge.createRemoteServer({ name: nameInput.value, url: urlInput.value });
      });
      return;
    }

    var card = button.closest('[data-server-id]');
    if (!card) return;
    var server = cardServer(card);

    if (action === 'select') {
      run('Selecting ' + server.name + '…', function () { return bridge.selectRemoteServer(server.id); });
    } else if (action === 'save') {
      run('Saving ' + server.name + '…', function () {
        return bridge.updateRemoteServer(server.id, { name: server.name, url: server.url });
      });
    } else if (action === 'test') {
      run('Testing ' + server.name + '…', function () {
        return bridge.testRemoteServer(server.id);
      }, function (result) {
        var health = result && result.health;
        testResults[server.id] = health && health.ok === false
          ? { tone: 'error', message: health.error || 'Test failed.' }
          : { tone: 'success', message: 'Test passed.' };
      });
    } else if (action === 'open') {
      run('Opening ' + server.name + '…', function () { return bridge.openRemoteServer(server.id); });
    } else if (action === 'delete') {
      run('Deleting ' + server.name + '…', function () { return bridge.deleteRemoteServer(server.id); }, function () {
        delete testResults[server.id];
      });
    }
  });

  if (bridge.onStateChanged) {
    bridge.onStateChanged(function (next) {
      setState(next);
    });
  }

  refresh().catch(function (reason) {
    status = { message: messageFrom(reason), tone: 'error' };
    render();
  });
})();
