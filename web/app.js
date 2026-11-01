'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const kinds = ['int32','uint32','float32','float64','int8','uint8','int16','uint16','int64','uint64'];
  const comparisons = [['equal','Equals'],['not_equal','Does not equal'],['greater','Greater than'],['less','Less than'],['changed','Changed'],['unchanged','Unchanged'],['increased','Increased'],['decreased','Decreased'],['increased_by','Increased by X'],['decreased_by','Decreased by X'],['unknown','Unknown initial value']];
  const initial = new Set(['equal','not_equal','greater','less','unknown']);
  const noValue = new Set(['unknown','changed','unchanged','increased','decreased']);
  const pending = new Map(), selected = new Set(), resultKinds = new Map();
  let sequence = 0, state = null, paired = false, endpoint = '', connected = false, busy = false;
  let sessionId = '', tab = 'saved', savedSignature = '', resultSignature = '', processes = [];
  let active = true, timer = 0, polling = null, retry = 500, lastSeen = 0, scanPending = false;
  let wantConnection = false, retryDeadline = 0, retryTimer = 0, connectionMessage = '';
  const retryWindow = 10000;
  let modalAction = null, modalContext = null, generation = 0;

  window.ForgeReply = (id, message) => {
    const request = pending.get(id); if (!request) return;
    pending.delete(id); clearTimeout(request.timer);
    if (message.ok) request.resolve(message.data);
    else { const error = new Error(message.error); error.status = message.status; request.reject(error); }
  };
  function api(action, args = {}) {
    return new Promise((resolve, reject) => {
      const id = 'r' + (++sequence);
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Request timed out. Refresh the connection before retrying a change.')); }, action === 'command' ? 210000 : 120000);
      pending.set(id, {resolve, reject, timer: timeout});
      if (window.ForgeNative) window.ForgeNative.request(id, action, JSON.stringify(args));
      else window.ForgeReply(id, {ok:false,error:'Open this workspace in Value Forge Companion on Android.'});
    });
  }
  function notice(text) {
    const inModal = !$('modalBackdrop').hidden;
    $('alert').hidden = !text || inModal; $('alert').querySelector('span').textContent = text;
    $('modalMessage').hidden = !text || !inModal; $('modalMessage').textContent = text;
  }
  function status(online, message = '') {
    online = Boolean(online && wantConnection && active && paired);
    connected = online;
    const badge = $('connectionBadge');
    badge.className = 'badge ' + (online ? 'online' : paired ? 'offline' : '');
    badge.querySelector('span').textContent = online ? 'Connected' : paired ? wantConnection ? 'Reconnecting' : 'Disconnected' : 'Not paired';
    document.body.classList.toggle('offlineValues', !online);
    if (online) { lastSeen = Date.now(); retry = 500; retryDeadline = 0; clearTimeout(retryTimer); }
    $('lastSeen').textContent = lastSeen ? `Last response ${new Date(lastSeen).toLocaleTimeString()}${online ? '' : ' · values may be stale'}` : message;
    $('connectionPageToggle').textContent = wantConnection ? 'Disconnect' : 'Reconnect';
    $('connectionLabel').textContent = online ? 'Connected' : wantConnection ? 'Connecting…' : 'Disconnected';
    $('connectionHint').textContent = online ? 'Values refresh while connected.' : wantConnection ? 'Retrying for up to 10 seconds.' : connectionMessage || 'Tap Reconnect when your Steam Machine is ready.';
    locks();
  }
  function locks() {
    const scanning = Boolean(state?.scan.busy) || scanPending;
    document.querySelectorAll('[data-live]').forEach(button => { button.disabled = !connected || !state?.alive || busy || scanning; });
    document.querySelectorAll('[data-read]').forEach(button => { button.disabled = !connected || busy; });
    document.querySelectorAll('[data-command]').forEach(button => { button.disabled = button.id === 'modalApply' && modalContext?.offline ? busy : !connected || busy || scanning; });
    $('scanType').disabled = !connected || busy || scanning || Boolean(state?.scan.has_scan);
    $('scanOperator').disabled = !connected || busy || scanning;
    $('scanValue').disabled = !connected || busy || scanning;
    $('pairButton').disabled = busy;
    if (modalContext?.saveSelection || modalContext?.quick) $('modalApply').disabled = !connected || busy || scanning || !state?.alive || Boolean(modalContext.quick && (modalContext.sessionId !== sessionId || modalContext.scanId !== state?.scan.id));
  }
  function showTab(name) {
    tab = name;
    document.querySelectorAll('.tab').forEach(section => section.hidden = section.id !== 'tab-' + name);
    document.querySelectorAll('nav button').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
    if (name === 'process' && connected && !processes.length) void loadProcesses();
  }
  function options(items, value) { return items.map(([id,label]) => `<option value="${escape(id)}"${id === value ? ' selected' : ''}>${escape(label)}</option>`).join(''); }
  function typeOptions(value, auto = false) { return options([...(auto ? [['auto','Auto']] : []), ...kinds.map(kind => [kind,kind])], value); }
  function updateSettings(settings) {
    paired = Boolean(settings.paired); endpoint = settings.endpoint || '';
    $('pairedInfo').hidden = !paired; $('pairForm').hidden = paired;
    $('pairedAddress').textContent = endpoint;
    $('permissionBox').hidden = settings.network_permission !== false;
    if (!$('endpoint').value) $('endpoint').value = endpoint;
    if (!paired) { stopConnection(); showTab('connection'); }
  }
  function update(next) {
    const previousSession = sessionId;
    const previousScan = state?.scan.id;
    state = next; sessionId = state.session?.id || '';
    if (previousScan !== state.scan.id) { selected.clear(); resultKinds.clear(); resultSignature = ''; }
    if (previousSession !== sessionId) {
      selected.clear(); resultKinds.clear(); savedSignature = resultSignature = '';
      $('scanType').innerHTML = typeOptions(state.scan.kind || 'auto', true);
      $('scanValue').value = state.scan.input || '0';
      $('scanOperator').innerHTML = options(comparisons.filter(([id]) => state.scan.has_scan ? id !== 'unknown' : initial.has(id)), state.scan.operator || 'equal');
    }
    if (state.scan.has_scan) $('scanType').value = state.scan.kind;
    $('gameName').textContent = state.session?.name || 'Choose your running game.';
    $('sessionStatus').textContent = state.session ? `PID ${state.session.pid} · ${state.alive ? 'Session active' : 'Game has exited'}` : 'Choose a process to start searching.';
    $('groupCount').textContent = state.session?.groups.length || 0;
    renderSaved(); renderResults(); renderScan();
    if (state.storage_warning) notice(state.storage_warning);
    if (modalContext?.quick && (modalContext.sessionId !== sessionId || modalContext.scanId !== state.scan.id)) notice('Search results or the game session changed. Close this dialog and reopen Quick edit.');
    locks();
  }
  function renderSaved() {
    const session = state?.session, groups = session?.groups || [], entries = session?.entries || [];
    const signature = JSON.stringify([groups, entries.map(e => [e.id,e.name,e.group_id,e.kind,e.address,e.frozen,e.status])]);
    if (signature !== savedSignature) {
      savedSignature = signature;
      $('savedGroups').innerHTML = groups.length ? groups.map(group => {
        const members = entries.filter(entry => entry.group_id === group.id);
        return `<article class="card"><div class="cardHead"><div><h3>${escape(group.name)}</h3><div class="muted">${members.length} address${members.length === 1 ? '' : 'es'}</div></div><button class="iconButton" data-action="group" data-id="${escape(group.id)}" aria-label="Manage ${escape(group.name)}" data-command>⋯</button></div><button class="button secondary wide smallButton" data-action="groupWrite" data-id="${escape(group.id)}" data-live${members.length ? '' : ' disabled'}>Change all values</button>${members.map((entry,index) => `<div class="address" data-entry="${escape(entry.id)}"><div class="name">${escape(entry.name === group.name ? 'Address ' + (index + 1) : entry.name)} ${entry.frozen ? '<span class="freezeTag">· FROZEN</span>' : ''}</div><div class="reading" data-entry-value="${escape(entry.id)}"></div><div class="muted small" data-previous="${escape(entry.id)}"></div><div class="code">${escape(entry.address)} · ${escape(entry.kind)}</div><div class="actions"><button class="button secondary smallButton" data-action="entry" data-id="${escape(entry.id)}" data-command>Edit address</button><button class="button secondary smallButton" data-action="freeze" data-id="${escape(entry.id)}" data-live>${entry.frozen ? 'Unfreeze' : 'Freeze'}</button></div></div>`).join('')}<button class="button quiet wide smallButton" data-action="manual" data-id="${escape(group.id)}" data-live>Add an address to this group</button></article>`;
      }).join('') : '<div class="empty"><strong>A place for your values.</strong>Search for an address, then save it in a named group. Keep linked values together.</div>';
    }
    for (const entry of entries) {
      const row = Array.from(document.querySelectorAll('[data-entry]')).find(el => el.dataset.entry === entry.id);
      if (!row) continue;
      row.classList.toggle('changed', Boolean(entry.changed));
      row.querySelector('[data-entry-value]').textContent = entry.status === 'ok' ? entry.value : entry.status === 'exited' ? 'Game not running' : 'Unavailable';
      row.querySelector('[data-previous]').textContent = entry.error || (entry.changed ? 'Changed from ' + entry.previous : '');
    }
    const emptyGroups = groups.filter(g => !entries.some(e => e.group_id === g.id)).map(g => g.id);
    $('savedGroups').querySelectorAll('[data-action="groupWrite"]').forEach(button => { if (emptyGroups.includes(button.dataset.id)) { button.removeAttribute('data-live'); button.disabled = true; } });
  }
  function renderScan() {
    const scan = state?.scan || {}, operator = $('scanOperator').value;
    const valid = comparisons.filter(([id]) => scan.has_scan ? id !== 'unknown' : initial.has(id));
    const ids = Array.from($('scanOperator').options).map(o => o.value).join(',');
    if (ids !== valid.map(([id]) => id).join(',')) $('scanOperator').innerHTML = options(valid, valid.some(([id]) => id === operator) ? operator : 'equal');
    const compare = $('scanOperator').value, delta = compare === 'increased_by' || compare === 'decreased_by';
    $('valueLabel').hidden = noValue.has(compare); $('deltaHelp').hidden = !delta;
    $('valueCaption').textContent = delta ? 'Change amount' : 'Search value';
    $('scanAction').textContent = scan.has_scan ? 'Narrow results' : 'Start search';
    $('resetScan').hidden = !scan.has_scan;
    const scanning = scanPending || Boolean(scan.busy);
    $('scanProgress').hidden = !scanning;
    const percent = Math.round(Math.max(0,Math.min(1,scan.progress || 0)) * 100);
    $('progress').value = percent; $('progressNumber').textContent = percent + '%';
    $('scanControls').insertBefore($('scanProgress'), scan.has_scan ? $('resetScan') : $('scanAction'));
    $('matchSummary').textContent = scan.has_scan ? `${Number(scan.count || 0).toLocaleString()} matches · showing up to the first 200` : 'Start with a known value, or take an unknown initial snapshot.';
  }
  function renderResults(force = false) {
    const results = state?.scan.results || [];
    const signature = JSON.stringify([results,state?.scan.has_scan]);
    if (force || signature !== resultSignature) {
      resultSignature = signature;
      const addresses = new Set(results.map(r => r.address));
      for (const address of selected) if (!addresses.has(address)) selected.delete(address);
      $('results').innerHTML = results.map(row => {
        const kind = resultKinds.get(row.address) || row.kind;
        const value = row.values ? row.values[kind] : row.value;
        return `<article class="card"><div class="selectRow"><div class="reading">${escape(value ?? 'Unavailable')}</div><input type="checkbox" aria-label="Select ${escape(row.address)}" data-select="${escape(row.address)}"${selected.has(row.address) ? ' checked' : ''}></div><div class="code">${escape(row.address)} · ${escape(kind)}</div>${(row.candidate_kinds?.length || 0) > 1 ? `<label>Result type<select data-result-kind="${escape(row.address)}">${options(row.candidate_kinds.map(kind => [kind,kind]),kind)}</select></label>` : ''}${row.error ? `<div class="muted small">${escape(row.error)}</div>` : ''}<button class="button wide smallButton" data-action="quickResult" data-address="${escape(row.address)}" data-live>Quick edit</button><button class="button secondary wide smallButton" data-action="saveResult" data-address="${escape(row.address)}" data-live>Save to group</button></article>`;
      }).join('');
    }
    $('selectionBar').hidden = !selected.size;
    $('saveSelected').textContent = `Save selected (${selected.size})`;
    $('quickSelected').textContent = `Quick edit selected (${selected.size})`;
  }
  async function loadProcesses() {
    const epoch = generation;
    try { const data = await api('processes'); if (epoch === generation && wantConnection && active) { processes = data.processes; renderProcesses(); } }
    catch (error) { if (epoch === generation && wantConnection) notice(error.message); }
  }
  function renderProcesses() {
    const filter = $('processFilter').value.toLowerCase();
    const rows = processes.filter(p => `${p.name} ${p.pid} ${p.command}`.toLowerCase().includes(filter));
    $('processCount').textContent = `${rows.length} matching processes`;
    $('processes').innerHTML = rows.map(p => `<button class="process" data-action="attach" data-id="${escape(p.id)}" data-command><strong>${escape(p.name)}${sessionId === p.id ? ' · connected' : ''}</strong><span class="code">PID ${p.pid} · ${escape(p.command)}</span></button>`).join('') || '<div class="empty">No matching processes. Start your game, then refresh.</div>';
    locks();
  }
  async function command(method, args, message = '') {
    if (!connected || busy || state?.scan.busy) return null;
    busy = true; notice(''); locks();
    const expected = sessionId, epoch = generation;
    try {
      const result = await api('command', {method,args,expected_session_id:expected});
      if (epoch !== generation || !wantConnection || !active) return null;
      update(result); status(true); if (message) notice(message); return result;
    } catch (error) {
      if (epoch !== generation || !wantConnection || !active) return null;
      notice(error.message + (error.status === 0 ? ' Check the current values before retrying a change.' : ''));
      if (error.status === 401) { paired = false; updateSettings(await api('settings')); }
      return null;
    } finally { busy = false; scanPending = false; renderScan(); locks(); }
  }
  function openModal(title, body, action = null, context = null) {
    $('modalMessage').hidden = true;
    $('modalTitle').textContent = title; $('modalBody').innerHTML = body;
    $('modalBackdrop').hidden = false; modalAction = action; modalContext = context;
    $('modalBody').querySelector('input')?.focus(); locks();
  }
  function closeModal() { if (busy) return; $('modalBackdrop').hidden = true; modalAction = modalContext = null; }
  function applyButton(label = 'Save') { return `<button id="modalApply" class="button wide" data-action="modalApply" data-command>${escape(label)}</button>`; }
  function confirm(title, text, action, offline = false) { openModal(title, `<p class="muted">${escape(text)}</p>${applyButton('Confirm')}`, action, {offline}); }
  function findGroup(id) { return state.session.groups.find(g => g.id === id); }
  function findEntry(id) { return state.session.entries.find(e => e.id === id); }
  function quickEdit(rows) {
    if (!rows.length) return;
    if (!state.scan.id) { notice('Update the Value Forge plugin to 0.7.0 or newer to use Quick edit.'); return; }
    const addresses = rows.map(row => ({address:row.address,kind:resultKinds.get(row.address) || row.kind}));
    const first = rows[0], kind = addresses[0].kind, current = (first.values ? first.values[kind] : first.value) ?? '0';
    const capturedSession = sessionId, capturedScan = state.scan.id;
    openModal('Quick edit', `<p class="muted">Apply one value to ${addresses.length} search address${addresses.length === 1 ? '' : 'es'}. Nothing is added to your saved groups.</p>${addresses.map(row => `<div class="code">${escape(row.address)} · ${escape(row.kind)}</div>`).join('')}<label>Quick value<div class="numberInput"><input id="quickValue" inputmode="decimal" value="${escape(current)}"><button class="iconButton" data-action="sign" data-target="quickValue" aria-label="Change quick value sign">±</button></div></label>${applyButton(addresses.length === 1 ? 'Apply quick edit' : 'Apply to selected results')}<div id="quickReport" class="groupReport" role="status"></div>`, async () => {
      const result = await command('write_results',{addresses,value:$('quickValue').value,session_id:capturedSession,scan_id:capturedScan});
      if (result?.quick_write) {
        const report = result.quick_write;
        $('quickReport').innerHTML = `Updated ${report.written.length} of ${report.total} search addresses. Nothing was saved.${report.failed.map(f => `<div class="failed">${escape(f.address)}: ${escape(f.error)}</div>`).join('')}`;
      }
    }, {quick:true,sessionId:capturedSession,scanId:capturedScan});
  }
  function save(addresses = [], groupId = '') {
    const groups = state.session.groups;
    const groupFields = `<label>Save to group<select id="saveGroup">${options([['','New group'],...groups.map(g => [g.id,g.name])],groupId)}</select></label><label id="newGroupLabel"${groupId ? ' hidden' : ''}>Group name<input id="groupName" type="text" placeholder="Gold, health, ammo…"></label>`;
    const addressFields = addresses.length ? `<p class="muted">${addresses.length} selected address${addresses.length === 1 ? '' : 'es'}</p>` : `<label>Address (hex)<input id="manualAddress" type="text" autocapitalize="off" spellcheck="false" placeholder="0x1234abcd"></label><label>Value type<select id="manualKind">${typeOptions('int32')}</select></label>`;
    openModal('Save addresses', groupFields + addressFields + applyButton('Save addresses'), async () => {
      const destination = $('saveGroup').value, name = $('groupName').value.trim();
      if (!destination && !name) { notice('Give the new group a name.'); return; }
      const rows = addresses.length ? addresses : [{address:$('manualAddress').value.trim(),kind:$('manualKind').value}];
      const result = await command('save_entries',{name,addresses:rows,group_id:destination},'Addresses saved.');
      if (result) { selected.clear(); closeModal(); showTab('saved'); renderResults(); }
    }, {saveSelection:true});
  }
  function editGroup(id) {
    const group = findGroup(id);
    openModal('Manage group', `<label>Group name<input id="editGroupName" value="${escape(group.name)}"></label>${applyButton('Save group name')}<button class="button danger wide" data-action="deleteGroup" data-id="${escape(id)}" data-command>Delete group and addresses</button>`, async () => {
      if (await command('rename_group',{group_id:id,name:$('editGroupName').value},'Group renamed.')) closeModal();
    });
  }
  function editEntry(id) {
    const entry = findEntry(id), groups = state.session.groups;
    openModal('Edit address', `<div class="code">${escape(entry.address)} · ${escape(entry.kind)}</div><label>Address label<input id="entryName" value="${escape(entry.name)}"></label><button class="button secondary wide" data-action="renameEntry" data-id="${escape(id)}" data-command>Save label</button><label>New value<div class="numberInput"><input id="entryValue" inputmode="decimal" value="${escape(entry.value ?? '')}"><button class="iconButton" data-action="sign" data-target="entryValue" aria-label="Change new value sign">±</button></div></label><button class="button wide" data-action="writeEntry" data-id="${escape(id)}" data-live>Apply value</button><label>Move to group<select id="moveGroup">${options(groups.map(g => [g.id,g.name]),entry.group_id)}</select></label><button class="button secondary wide" data-action="moveEntry" data-id="${escape(id)}" data-command>Move address</button><button class="button danger wide" data-action="deleteEntry" data-id="${escape(id)}" data-command>Remove address from group</button>`);
  }
  async function pair() {
    if (busy) return;
    busy = true; locks(); notice('');
    try { updateSettings(await api('pair',{endpoint:$('endpoint').value,code:$('pairCode').value})); $('pairCode').value = ''; showTab('process'); await connect(); }
    catch (error) { notice(error.message); }
    finally { busy = false; locks(); }
  }
  function cancelReads() { void api('cancel_reads').catch(() => {}); }
  function stopConnection(message = '') {
    wantConnection = false; generation++; retryDeadline = 0;
    clearTimeout(timer); clearTimeout(retryTimer); connectionMessage = message;
    status(false, message); cancelReads();
  }
  function startRetryWindow(started = Date.now()) {
    if (!retryDeadline) retryDeadline = started + retryWindow;
    clearTimeout(retryTimer);
    const remaining = retryDeadline - Date.now();
    if (remaining <= 0) { stopConnection('Could not connect within 10 seconds. Tap Reconnect to try again.'); return false; }
    retryTimer = setTimeout(() => stopConnection('Could not connect within 10 seconds. Tap Reconnect to try again.'), remaining);
    return true;
  }
  async function connect() {
    if (!paired) return;
    generation++; wantConnection = true; connected = false; retry = 500; retryDeadline = 0; connectionMessage = '';
    clearTimeout(timer); cancelReads(); startRetryWindow(); status(false);
    return poll();
  }
  async function poll(forceRefresh = false) {
    clearTimeout(timer);
    if (!active || !paired || !wantConnection || polling === generation) return;
    if (retryDeadline && Date.now() >= retryDeadline) { startRetryWindow(); return; }
    if (!retryDeadline && !startRetryWindow()) return;
    const epoch = generation, started = Date.now(); polling = epoch;
    try {
      const data = await api('state',{refresh: forceRefresh || !state?.scan.busy, timeout_ms: retryDeadline ? Math.max(1,Math.min(8000,retryDeadline-Date.now())) : 8000});
      if (epoch === generation && paired && wantConnection && active) { update(data); status(true); }
    } catch (error) {
      if (epoch === generation && wantConnection && active) {
        status(false, error.message); retry = Math.min(8000,Math.max(1000,retry * 2));
        if (error.status === 401) { stopConnection('Pair this phone again in Decky.'); updateSettings(await api('settings')); }
        else startRetryWindow(started);
      }
    } finally {
      if (polling === epoch) polling = null;
      if (epoch === generation && active && paired && wantConnection) timer = setTimeout(poll, connected ? state?.scan.busy || scanPending ? 250 : 1200 : Math.min(retry,Math.max(1,retryDeadline-Date.now())));
    }
  }
  window.ForgeLifecycle = visible => {
    active = visible;
    if (visible) api('settings').then(settings => {
      updateSettings(settings);
      if (wantConnection && startRetryWindow()) { status(false); void poll(); }
    }).catch(error => notice(error.message));
    else { generation++; clearTimeout(timer); cancelReads(); status(false); }
  };
  window.ForgePermissionsChanged = async () => { updateSettings(await api('settings')); if (wantConnection) void poll(); };
  document.addEventListener('change', event => {
    if (event.target.id === 'scanOperator') renderScan();
    if (event.target.id === 'saveGroup') $('newGroupLabel').hidden = Boolean(event.target.value);
    if (event.target.dataset.select) { const address = event.target.dataset.select; event.target.checked ? selected.add(address) : selected.delete(address); renderResults(); locks(); }
    if (event.target.dataset.resultKind) { resultKinds.set(event.target.dataset.resultKind,event.target.value); renderResults(true); locks(); }
  });
  $('processFilter').addEventListener('input',renderProcesses);
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.dataset.tab) { showTab(button.dataset.tab); return; }
    const id = button.dataset.id, action = button.dataset.action;
    const handlers = {
      sign: () => { const field = $(button.dataset.target); field.value = field.value.startsWith('-') ? field.value.slice(1) : '-' + field.value.replace(/^\+/,''); },
      dismiss: () => notice(''), closeModal, modalApply: () => modalAction?.(), pair,
      toggleConnection: () => wantConnection ? stopConnection('Disconnected. Pairing is kept; tap Reconnect to resume.') : connect(),
      permission: async () => { await api('permission'); },
      processes: loadProcesses,
      refresh: () => poll(true),
      attach: async () => { const process = processes.find(p => p.id === id); if (await command('attach',{pid:process.pid,expected_id:process.id})) showTab(state.session.groups.length ? 'saved' : 'scan'); },
      scan: async () => { scanPending = true; if (state) state.scan.progress = 0; renderScan(); await command('scan',{operator:$('scanOperator').value,value:$('scanValue').value,kind:$('scanType').value}); },
      reset: async () => { if (await command('reset_scan',{})) { selected.clear(); resultKinds.clear(); $('scanOperator').value = 'equal'; renderScan(); } },
      clearSelection: () => { selected.clear(); renderResults(true); locks(); },
      quickSelected: () => quickEdit(state.scan.results.filter(row => selected.has(row.address))),
      quickResult: () => quickEdit(state.scan.results.filter(row => row.address === button.dataset.address)),
      saveSelected: () => save(state.scan.results.filter(row => selected.has(row.address)).map(row => ({address:row.address,kind:resultKinds.get(row.address) || row.kind}))),
      saveResult: () => { const row = state.scan.results.find(r => r.address === button.dataset.address); save([{address:row.address,kind:resultKinds.get(row.address) || row.kind}]); },
      manual: () => save([],id || ''), group: () => editGroup(id), entry: () => editEntry(id),
      freeze: () => { const entry = findEntry(id); return command('freeze_entry',{entry_id:id,enabled:!entry.frozen}); },
      renameEntry: () => command('rename_entry',{entry_id:id,name:$('entryName').value},'Address label saved.'),
      writeEntry: () => command('write_entry',{entry_id:id,value:$('entryValue').value},'Value applied.'),
      moveEntry: async () => { if (await command('move_entry',{entry_id:id,group_id:$('moveGroup').value},'Address moved.')) closeModal(); },
      deleteEntry: () => confirm('Remove saved address?', 'The game value is not changed. The group remains available.',async () => { if (await command('remove_entry',{entry_id:id},'Address removed.')) closeModal(); }),
      deleteGroup: () => confirm('Delete saved group?', 'Remove this group and every saved address in it. Game memory is not changed.',async () => { if (await command('remove_group',{group_id:id},'Group removed.')) closeModal(); }),
      groupWrite: () => { const group = findGroup(id), member = state.session.entries.find(e => e.group_id === id); openModal('Change all values', `<p class="muted">Set every address in ${escape(group.name)} to one value. Each address keeps its saved numeric type.</p><label>Group value<div class="numberInput"><input id="groupValue" inputmode="decimal" value="${escape(member?.value || '0')}"><button class="iconButton" data-action="sign" data-target="groupValue" aria-label="Change group value sign">±</button></div></label>${applyButton('Apply to entire group')}<div id="groupReport" class="groupReport" role="status"></div>`,async () => {
        const result = await command('write_group',{group_id:id,value:$('groupValue').value});
        if (result?.group_write) { const report = result.group_write; $('groupReport').innerHTML = `Updated ${report.written.length} of ${report.total} addresses.${report.failed.map(f => `<div class="failed">${escape(f.name)} · ${escape(f.address)}: ${escape(f.error)}</div>`).join('')}`; }
      }); },
      forget: () => confirm('Forget this pairing?', 'You will need a new code from Decky to pair again. Saved groups remain on the Steam Machine.',async () => { stopConnection(); updateSettings(await api('forget')); state = null; sessionId = ''; closeModal(); },true),
      address: () => openModal('Change machine address', `<p class="muted">Pairing stays remembered. The machine must present the same fingerprint.</p><label>Steam Machine address<input id="newAddress" value="${escape(endpoint)}"></label>${applyButton('Reconnect')}`, async () => { try { updateSettings(await api('address',{endpoint:$('newAddress').value})); closeModal(); void connect(); } catch (error) { notice(error.message); } }, {offline:true}),
    };
    if (handlers[action]) Promise.resolve(handlers[action]()).catch(error => notice(error.message));
  });
  $('scanType').innerHTML = typeOptions('auto',true);
  $('scanOperator').innerHTML = options(comparisons.filter(([id]) => initial.has(id)),'equal');
  api('settings').then(settings => { updateSettings(settings); if (paired) void connect(); }).catch(error => notice(error.message));
  // Accessible test seam also supports a browser preview without secret credentials.
  window.ValueForgeUI = {update, status, showTab, api, poll, close:() => { active = false; clearTimeout(timer); clearTimeout(retryTimer); for (const item of pending.values()) clearTimeout(item.timer); pending.clear(); }};
})();
