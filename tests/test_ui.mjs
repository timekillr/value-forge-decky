// Test the shipped production bundle with real React and a simulated Steam UI.
// Actual Decky focus/navigation and visual layout still need on-device testing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const JSX = await import('react/jsx-runtime');
const { render, fireEvent, waitFor, act, within } = await import('@testing-library/react');
const h = React.createElement;
const Visibility = React.createContext(true);
const calls = [];
const nativeListeners = new Set();
const controllerListListeners = new Set();
let nativeUnregistered = 0;
window.SteamClient = { Input: {
  RegisterForControllerStateChanges(callback) {
    nativeListeners.add(callback);
    return { unregister() { nativeListeners.delete(callback); nativeUnregistered++; } };
  },
  RegisterForControllerListChanges(callback) {
    controllerListListeners.add(callback);
    return { unregister() { controllerListListeners.delete(callback); } };
  },
  UnregisterForControllerStateChanges() { throw new Error('Do not remove other controller listeners'); },
} };
const originalRects = window.HTMLElement.prototype.getClientRects;
window.HTMLElement.prototype.getClientRects = function () {
  return this.classList?.contains('mds') ? [{ top: 0, left: 0, bottom: 600, right: 360, width: 360, height: 600 }] : originalRects.call(this);
};
let finishScan;
let scanWait;
const uiErrors = [];
window.addEventListener('error', event => uiErrors.push(event.error));
let listedProcesses = [
  { id: 'process-first', pid: 11, name: 'Launcher', command: '/games/launcher' },
  { id: 'process-second', pid: 22, name: 'ActualGame.exe', command: '/games/ActualGame.exe -game' },
  { id: 'process-third', pid: 33, name: 'Helper', command: '/games/helper' },
];
let deferProcessList = null;
let deferStateRead = null;
let actualValue = '10';
const entry = { id: 'gold', group_id: 'group-gold', name: 'Gold', address: '0x1234', kind: 'int32', value: '10',
  previous: null, changed: false, status: 'ok', error: null, frozen: false, updated_at: 1792353600 };
const state = { session: { id: 'a', pid: 42, name: 'OfflineGame.exe', entries: [entry], groups: [{ id: 'group-gold', name: 'Gold' }] }, alive: true,
  storage_warning: null, scan: { kind: 'int32', has_scan: true, busy: false, count: 17, operator: 'equal',
  input: '10', results: [{ address: '0x5678', kind: 'int32', value: '10', error: null }, { address: '0x9876', kind: 'int32', value: '10', error: null }] } };
const button = ({ children, onClick, disabled, className }) => h('button', { onClick, disabled, className,
  onKeyDown: e => { if (e.key === 'GamepadA' && !disabled) { e.stopPropagation(); onClick?.(e); } } }, children);
const dfl = {
  staticClasses: { Title: 'title' },
  PanelSection: ({ children, title }) => h('section', {}, h('h3', {}, title), children),
  PanelSectionRow: ({ children }) => h('div', {}, children),
  Focusable: ({ children, className, 'data-pad': pad, onSecondaryButton, onOptionsButton, onCancelButton }) =>
    h('div', { className, 'data-pad': pad, onKeyDown: e => {
      if (e.key === 'GamepadX') onSecondaryButton?.(e);
      if (e.key === 'GamepadY') onOptionsButton?.(e);
      if (e.key === 'GamepadB') onCancelButton?.(e);
    } }, children),
  ButtonItem: button, DialogButton: button, SteamSpinner: () => h('span', {}, 'Loading'),
  TextField: ({ label, value, disabled, onChange, placeholder }) => h('label', {}, label,
    h('input', { 'aria-label': label, value, disabled, onChange, placeholder })),
  DropdownItem: ({ label, rgOptions, selectedOption, onChange, disabled }) => h('label', {}, label,
    h('select', { 'aria-label': label, value: selectedOption ?? '', disabled,
      onChange: e => onChange(rgOptions.find(o => String(o.data) === e.target.value)) },
      rgOptions.map(o => h('option', { key: o.data, value: o.data }, o.label)))),
  ToggleField: ({ label, checked, disabled, onChange }) => h('label', {}, label,
    h('input', { 'aria-label': label, type: 'checkbox', checked, disabled, onChange: e => onChange(e.target.checked) })),
};
window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit = { connect: () => ({
  _version: 2,
  useQuickAccessVisible: () => React.useContext(Visibility),
  callable: route => async (...args) => {
    calls.push([route, ...args]);
    if (route === 'get_processes') {
      if (deferProcessList) await deferProcessList;
      return structuredClone(listedProcesses);
    }
    if (route === 'scan') {
      state.scan.busy = true; state.scan.progress = 0;
      await scanWait;
      state.scan.busy = false; state.scan.progress = 1;
      state.scan.has_scan = true;
      [state.scan.operator, state.scan.input, state.scan.kind] = args;
    }
    if (route === 'get_state' && deferStateRead) await deferStateRead;
    if (route === 'attach') {
      const selected = listedProcesses.find(p => p.id === args[1]);
      state.session.id = args[1]; state.session.pid = args[0]; state.session.name = selected.name;
    }
    if (route === 'get_state' && args[0]) {
      entry.previous = entry.value; entry.changed = entry.value !== actualValue; entry.value = actualValue;
    }
    if (route === 'rename_entry') state.session.entries.find(e => e.id === args[0]).name = args[1];
    if (route === 'save_entries') {
      let group = state.session.groups.find(g => g.id === args[2]);
      if (!group) {
        group = { id: 'group-' + (state.session.groups.length + 1), name: args[0] };
        state.session.groups.push(group);
      }
      for (const row of args[1]) {
        state.session.entries.push({ ...entry, id: 'address-' + row.address, group_id: group.id,
          name: 'Address ' + (state.session.entries.length + 1), address: row.address, kind: row.kind });
      }
    }
    if (route === 'write_group') {
      const members = state.session.entries.filter(e => e.group_id === args[0]);
      for (const member of members) { member.value = args[1]; if (member.id === 'gold') actualValue = args[1]; }
      state.group_write = { group_id: args[0], name: state.session.groups.find(g => g.id === args[0]).name,
        value: args[1], total: members.length, written: members.map(e => e.id), failed: [], updated_at: Date.now() / 1000 };
    }
    if (route === 'write_entry') {
      state.session.entries.find(e => e.id === args[0]).value = args[1];
      if (args[0] === 'gold') actualValue = args[1];
    }
    if (route === 'remove_entry') state.session.entries = state.session.entries.filter(e => e.id !== args[0]);
    if (route === 'move_entry') state.session.entries.find(e => e.id === args[0]).group_id = args[1];
    if (route === 'rename_group') state.session.groups.find(g => g.id === args[0]).name = args[1];
    if (route === 'remove_group') {
      state.session.entries = state.session.entries.filter(e => e.group_id !== args[0]);
      state.session.groups = state.session.groups.filter(g => g.id !== args[0]);
    }
    if (route === 'reset_scan') Object.assign(state.scan, { has_scan: false, count: 0, results: [], operator: 'equal', input: '' });
    return structuredClone(state);
  },
}) };
const source = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8').replace('export { index as default };', 'index;');
const createPlugin = vm.runInNewContext(source, { window, document, SP_REACT: React, SP_JSX: JSX, DFL: dfl,
  console, setInterval, clearInterval, setTimeout, clearTimeout });
let visibilitySetter;
function Shell() {
  const [visible, setVisible] = React.useState(true);
  visibilitySetter = setVisible;
  const plugin = createPlugin();
  // Match Decky's real PluginView lifecycle instead of always rendering it.
  return h(Visibility.Provider, { value: visible }, (visible || plugin.alwaysRender) ? plugin.content : null);
}
function padNode(label) {
  const node = [...document.querySelectorAll('[data-pad]')].find(node => node.dataset.pad === label);
  assert.ok(node, 'Missing controller pad: ' + label); return node;
}
function activate(button) { fireEvent.keyDown(button, { key: 'GamepadA' }); }
function fillPad(label, text) {
  const scope = within(padNode(label));
  if (!scope.queryByRole('button', { name: 'Clear', exact: true })) {
    activate(scope.getAllByRole('button')[0]);
  }
  activate(scope.getByRole('button', { name: 'Clear', exact: true }));
  const hex = label === 'Address (hex)';
  let content = hex ? text.replace(/^0x/i, '') : text;
  if ((label === 'Search value' || label === 'New value') && content.startsWith('-')) {
    activate(scope.getByRole('button', { name: '±', exact: true })); content = content.slice(1);
  }
  for (const character of content) {
    if (character === ' ') { activate(scope.getByRole('button', { name: 'Space', exact: true })); continue; }
    const key = hex ? character.toUpperCase() : character;
    if (!scope.queryByRole('button', { name: key, exact: true })) {
      const toggle = /[A-Z]/.test(character) ? 'Uppercase' : 'Lowercase';
      activate(scope.getByRole('button', { name: toggle, exact: true }));
    }
    activate(scope.getByRole('button', { name: key, exact: true }));
  }
  activate(scope.getByRole('button', { name: 'Done', exact: true }));
}
let screen = render(h(Shell));
await waitFor(() => assert.equal(screen.getByRole('button', { name: 'Refresh values' }).disabled, false));
assert.equal(calls.filter(c => c[0] === 'get_state' && c[1]).length, 1);
assert.match(document.body.textContent, /Gold/);
console.log('PASS: initial mount requests fresh values.');

await act(async () => { visibilitySetter(false); });
actualValue = '42';
await act(async () => { visibilitySetter(true); });
await waitFor(() => assert.match(document.body.textContent, /Changed from 10/));
assert.match(document.body.textContent, /42/);
assert.equal(calls.filter(c => c[0] === 'attach').length, 0);
console.log('PASS: reopening retained content refreshes values without attaching or clearing the scan.');

screen.unmount(); actualValue = '75'; screen = render(h(Shell));
await waitFor(() => assert.match(document.body.textContent, /Changed from 42/));
assert.match(document.body.textContent, /Gold/);
assert.equal(calls.filter(c => c[0] === 'reset_scan').length, 0);
console.log('PASS: unmount/remount preserves named entries and requests new memory values.');

fireEvent.click(screen.getByRole('button', { name: 'Search' }));
assert.match(document.body.textContent, /17 matches/);
assert.equal(screen.getByLabelText('Value type').value, 'int32');
fireEvent.click(screen.getByLabelText('Select 0x5678'));
fireEvent.click(screen.getByLabelText('Select 0x9876'));
fireEvent.click(screen.getByRole('button', { name: 'Save selected (2)' }));
fireEvent.change(screen.getByLabelText('Save to group'), { target: { value: 'group-gold' } });
assert.equal(screen.queryByLabelText('Group name'), null);
fireEvent.click(screen.getByRole('button', { name: 'Save addresses' }));
await waitFor(() => assert.match(document.body.textContent, /Addresses saved together/));
assert.equal(state.session.groups.length, 1);
assert.equal(state.session.entries.length, 3);
const batch = calls.find(c => c[0] === 'save_entries');
assert.equal(batch[2].length, 2); assert.equal(batch[3], 'group-gold');
fireEvent.click(screen.getByRole('button', { name: 'Search' }));
fireEvent.click(screen.getByRole('button', { name: 'Start a new search' }));
await waitFor(() => assert.match(document.body.textContent, /Search reset. Saved entries kept./));
fireEvent.click(screen.getByRole('button', { name: 'Saved (1)' }));
assert.equal(document.querySelectorAll('.mds-address').length, 3);
console.log('PASS: multi-selected results save to an existing group and survive search reset.');

activate(screen.getByRole('button', { name: 'Change all values', exact: true }));
fillPad('Group value', '88');
activate(screen.getByRole('button', { name: 'Apply to entire group', exact: true }));
await waitFor(() => assert.match(document.body.textContent, /Updated 3 of 3 addresses/));
assert.equal(calls.filter(c => c[0] === 'write_group').length, 1);
assert.equal(calls.filter(c => c[0] === 'write_entry').length, 0);
assert.equal([...document.querySelectorAll('.mds-address .mds-value')].filter(n => n.textContent === '88').length, 3);
activate(screen.getByRole('button', { name: 'Done', exact: true }));
console.log('PASS: a group-display button applies one controller-entered value to all its addresses.');

fireEvent.click(screen.getAllByRole('button', { name: 'Edit address' })[0]);
fillPad('Address label', 'Pocket money');
fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
await waitFor(() => assert.match(document.body.textContent, /Address label saved./));
assert.match(document.body.textContent, /Pocket money/);
assert.equal(screen.getByRole('heading', { name: 'Gold' }).textContent, 'Gold');
fireEvent.click(screen.getByRole('button', { name: 'Done' }));
console.log('PASS: individual address labels can change independently of the group name.');

fireEvent.click(screen.getAllByRole('button', { name: 'Edit address' })[1]);
fillPad('New value', '123');
fireEvent.click(screen.getByRole('button', { name: 'Write value' }));
await waitFor(() => assert.match(document.body.textContent, /Value written and read back./));
assert.deepEqual(calls.find(c => c[0] === 'write_entry'), ['write_entry', 'address-0x5678', '123']);
assert.equal(entry.value, '88');
fireEvent.click(screen.getByRole('button', { name: 'Remove address' }));
fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
await waitFor(() => assert.equal(document.querySelectorAll('.mds-address').length, 2));
assert.equal(state.session.groups.length, 1);
console.log('PASS: per-address write and remove controls affect only the chosen group member.');

fireEvent.click(screen.getByRole('button', { name: 'Add address manually' }));
fillPad('Group name', 'Health');
fillPad('Address (hex)', '0xabcd');
fireEvent.click(screen.getByRole('button', { name: 'Save addresses' }));
await waitFor(() => assert.ok(screen.getByRole('heading', { name: 'Health' })));
fireEvent.click(screen.getAllByRole('button', { name: 'Edit address' })[0]);
const destination = state.session.groups.find(g => g.name === 'Health').id;
fireEvent.change(screen.getByLabelText('Move to group'), { target: { value: destination } });
fireEvent.click(screen.getByRole('button', { name: 'Move address' }));
await waitFor(() => assert.match(document.body.textContent, /Address moved/));
assert.match(screen.getByRole('heading', { name: 'Health' }).parentElement.textContent, /Pocket money/);
assert.doesNotMatch(screen.getByRole('heading', { name: 'Gold' }).parentElement.textContent, /Pocket money/);
console.log('PASS: a saved address can move between groups while retaining its label.');

fireEvent.click(screen.getAllByRole('button', { name: 'Edit address' })[0]);
fireEvent.click(screen.getByRole('button', { name: 'Remove address' }));
fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
await waitFor(() => assert.match(screen.getByRole('heading', { name: 'Gold' }).parentElement.textContent, /No saved addresses/));
fireEvent.click(screen.getAllByRole('button', { name: 'Rename / Delete group' })[0]);
fillPad('Group name', 'Coins');
fireEvent.click(screen.getByRole('button', { name: 'Save group name' }));
await waitFor(() => assert.ok(screen.getByRole('heading', { name: 'Coins' })));
fireEvent.click(screen.getByRole('button', { name: 'Done' }));
fireEvent.click(screen.getAllByRole('button', { name: 'Add address' })[0]);
assert.equal(screen.getByLabelText('Save to group').value, 'group-gold');
console.log('PASS: removing the final address keeps an empty group that can be renamed and reused.');
screen.unmount();
state.scan.kind = 'auto';
listedProcesses = [...listedProcesses, ...Array.from({ length: 12 }, (_, i) => ({
  id: 'extra-' + i, pid: 100 + i, name: 'Extra' + i, command: '/games/extra-' + i,
}))];
screen = render(h(Shell));
await waitFor(() => assert.equal(screen.getByRole('button', { name: 'Refresh values' }).disabled, false));
activate(screen.getByRole('button', { name: 'Process', exact: true }));
await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Extra11 · PID 111' })));
assert.equal(screen.queryByRole('button', { name: 'Next processes' }), null);
assert.equal(screen.queryByRole('button', { name: 'Use this process' }), null);
assert.equal(screen.queryByLabelText('Process'), null);
assert.equal(document.querySelectorAll('.mds-process-choice').length, 15);
activate(screen.getByRole('button', { name: 'Extra11 · PID 111' }));
await waitFor(() => assert.match(document.body.textContent, /Connected to this game session/));
assert.deepEqual(calls.filter(c => c[0] === 'attach').at(-1), ['attach', 111, 'extra-11']);
assert.match(document.body.textContent, /PID 111 · Session active/);
console.log('PASS: all processes appear on one scrolling page and one gamepad activation connects to a late-listed process.');

activate(screen.getByRole('button', { name: 'Process', exact: true }));
await waitFor(() => assert.equal(screen.getByRole('button', { name: 'Reload process list' }).disabled, false));
fillPad('Filter processes', 'ActualGame');
assert.ok(screen.getByRole('button', { name: 'ActualGame.exe · PID 22' }));
assert.equal(screen.queryByRole('button', { name: 'Launcher · PID 11' }), null);
activate(screen.getByRole('button', { name: 'ActualGame.exe · PID 22' }));
await waitFor(() => assert.match(document.body.textContent, /PID 22 · Session active/));
assert.deepEqual(calls.filter(c => c[0] === 'attach').at(-1), ['attach', 22, 'process-second']);
console.log('PASS: the optional process filter and direct connection work using only controller-pad buttons.');

activate(screen.getByRole('button', { name: 'Search', exact: true }));
assert.equal(screen.getByLabelText('Value type').value, 'auto');
assert.ok(screen.getByRole('option', { name: 'Auto', exact: true }));
assert.equal(document.querySelector('input[type="text"]'), null);
fillPad('Search value', '-73.125');
assert.equal(screen.getByLabelText('Search value').value, '-73.125');
activate(within(padNode('Search value')).getAllByRole('button')[0]);
const numberPad = within(padNode('Search value'));
fireEvent.keyDown(padNode('Search value'), { key: 'GamepadX' });
assert.equal(screen.getByLabelText('Search value').value, '-73.12');
fireEvent.keyDown(padNode('Search value'), { key: 'GamepadY' });
assert.equal(screen.getByLabelText('Search value').value, '0');
activate(numberPad.getByRole('button', { name: '7', exact: true }));
activate(numberPad.getByRole('button', { name: '.', exact: true }));
activate(numberPad.getByRole('button', { name: '.', exact: true }));
activate(numberPad.getByRole('button', { name: '5', exact: true }));
assert.equal(screen.getByLabelText('Search value').value, '7.5');
fireEvent.keyDown(padNode('Search value'), { key: 'GamepadB' });
assert.equal(numberPad.queryByRole('button', { name: '7', exact: true }), null);
assert.ok(screen.getByRole('heading', { name: 'Find a value' }));
console.log('PASS: Auto is the default; the number pad supports signed decimals, duplicate-dot prevention, and gamepad X/Y/B shortcuts.');

await act(async () => { visibilitySetter(false); });
await act(async () => { visibilitySetter(true); });
assert.equal(screen.getByLabelText('Search value').value, '7.5');
assert.equal(screen.getByLabelText('Value type').value, 'auto');
assert.equal(createPlugin().alwaysRender, true);
console.log('PASS: hiding/reopening the panel preserves the controller-entered number and search type.');

scanWait = new Promise(resolve => { finishScan = resolve; });
activate(screen.getByRole('button', { name: 'Start search', exact: true }));
await waitFor(() => assert.ok(screen.getByRole('progressbar', { name: 'Memory scan progress' })));
assert.ok(screen.getByRole('progressbar').compareDocumentPosition(screen.getByRole('button', { name: 'Start search', exact: true })) & window.Node.DOCUMENT_POSITION_FOLLOWING);
await act(async () => finishScan());
await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Narrow results', exact: true })));
console.log('PASS: the initial-search progress bar appears immediately above Start search.');

state.scan.has_scan = true;
state.scan.count = 1;
state.scan.results = [{ address: '0x9999', kind: 'int32', value: '100', error: null,
  candidate_kinds: ['int32', 'uint32', 'int64'], values: { int32: '100', uint32: '100', int64: '100' } }];
await act(async () => { visibilitySetter(false); });
await act(async () => { visibilitySetter(true); });
fireEvent.change(screen.getByLabelText('Saved type for 0x9999'), { target: { value: 'int64' } });
activate(screen.getByRole('button', { name: 'Save to group', exact: true }));
fillPad('Group name', 'Auto result');
activate(screen.getByRole('button', { name: 'Save addresses', exact: true }));
await waitFor(() => assert.ok(screen.getByRole('heading', { name: 'Auto result' })));
assert.equal(calls.filter(c => c[0] === 'save_entries').at(-1)[2][0].kind, 'int64');
assert.equal(document.querySelector('input:not([type="checkbox"])'), null);
console.log('PASS: an ambiguous Auto result can be saved with a chosen concrete type without any text inputs.');
activate(screen.getByRole('button', { name: 'Search', exact: true }));
fireEvent.change(screen.getByLabelText('Compare'), { target: { value: 'increased_by' } });
assert.ok(screen.getByRole('option', { name: 'Increased by X' }));
fillPad('Change amount', '25');
assert.equal(screen.queryByLabelText('Search value'), null);
assert.ok(screen.getByText(/Each narrow search becomes the next comparison point/));
scanWait = new Promise(resolve => { finishScan = resolve; });
activate(screen.getByRole('button', { name: 'Narrow results', exact: true }));
await waitFor(() => assert.ok(screen.getByRole('progressbar', { name: 'Memory scan progress' })));
assert.deepEqual(calls.filter(c => c[0] === 'scan').at(-1), ['scan', 'increased_by', '25', 'auto']);
const bar = screen.getByRole('progressbar');
assert.ok(screen.getByRole('button', { name: 'Narrow results', exact: true }).compareDocumentPosition(bar) & window.Node.DOCUMENT_POSITION_FOLLOWING);
assert.ok(bar.compareDocumentPosition(screen.getByRole('button', { name: 'Start a new search', exact: true })) & window.Node.DOCUMENT_POSITION_FOLLOWING);
state.scan.progress = 0.4;
await waitFor(() => assert.equal(screen.getByRole('progressbar', { name: 'Memory scan progress' }).value, 40));
state.scan.progress = 0.85;
await waitFor(() => assert.equal(screen.getByRole('progressbar', { name: 'Memory scan progress' }).value, 85));
await act(async () => finishScan());
await waitFor(() => assert.equal(screen.queryByRole('progressbar', { name: 'Memory scan progress' }), null));
console.log('PASS: Increased by X sends the controller-entered amount, and live progress appears between Narrow results and Start a new search.');
fireEvent.change(screen.getByLabelText('Compare'), { target: { value: 'decreased_by' } });
fillPad('Change amount', '7');
scanWait = undefined;
activate(screen.getByRole('button', { name: 'Narrow results', exact: true }));
await waitFor(() => assert.deepEqual(calls.filter(c => c[0] === 'scan').at(-1), ['scan', 'decreased_by', '7', 'auto']));
await waitFor(() => assert.equal(screen.queryByRole('progressbar'), null));
console.log('PASS: Decreased by X uses the same controller amount pad and its own direction.');

const viewport = screen.container;
viewport.style.overflowY = 'auto';
Object.defineProperty(viewport, 'scrollHeight', { value: 2000, configurable: true });
Object.defineProperty(viewport, 'clientHeight', { value: 400, configurable: true });
viewport.scrollTop = 100;
const nativeAxis = value => { for (const callback of nativeListeners) callback([{ unControllerIndex: 0, sRightStickY: value }]); };
assert.equal(nativeListeners.size, 1);
nativeAxis(-32767);
await waitFor(() => assert.ok(viewport.scrollTop > 100));
nativeAxis(0);
const stopped = viewport.scrollTop;
await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
assert.equal(viewport.scrollTop, stopped);
nativeAxis(1200);
await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
assert.equal(viewport.scrollTop, stopped, 'Stick drift inside the dead zone must not scroll.');
nativeAxis(32767);
await waitFor(() => assert.ok(viewport.scrollTop < stopped));
nativeAxis(0);
assert.equal(screen.queryByLabelText('Right-stick scrolling'), null);
assert.equal(screen.queryByRole('heading', { name: 'Controls' }), null);
assert.equal(nativeListeners.size, 1);
console.log('PASS: right-stick scrolling is always enabled while visible, respects the dead zone, and has no toggle.');

viewport.scrollTop = 0;
nativeAxis(-32767);
await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
const heldAt = viewport.scrollTop;
await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
assert.ok(viewport.scrollTop > heldAt, 'A held stick must keep scrolling when disconnect tracking is available.');
for (const callback of controllerListListeners) callback([]);
const disconnectedAt = viewport.scrollTop;
await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
assert.equal(viewport.scrollTop, disconnectedAt);
console.log('PASS: holding the stick keeps scrolling, and a controller disconnect stops it without a neutral report.');

nativeAxis(-32767);
await act(async () => { visibilitySetter(false); });
assert.equal(nativeListeners.size, 0);
const hiddenAt = viewport.scrollTop;
await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
assert.equal(viewport.scrollTop, hiddenAt);
await act(async () => { visibilitySetter(true); });
assert.equal(nativeListeners.size, 1);
screen.unmount();
assert.equal(nativeListeners.size, 0);
assert.ok(nativeUnregistered > 0);
console.log("PASS: hiding/unmounting releases only this plugin's controller subscription and stops scrolling.");

window.SteamClient = undefined;
let webAxis = 1;
Object.defineProperty(window.navigator, 'getGamepads', { configurable: true,
  value: () => [{ connected: true, axes: [0, 0, 0, webAxis] }] });
screen = render(h(Shell));
screen.container.style.overflowY = 'auto';
Object.defineProperty(screen.container, 'scrollHeight', { value: 2000, configurable: true });
Object.defineProperty(screen.container, 'clientHeight', { value: 400, configurable: true });
await waitFor(() => assert.ok(screen.container.scrollTop > 0));
webAxis = 0;
screen.unmount();
assert.equal(uiErrors.length, 0, String(uiErrors));
console.log('PASS: browser Gamepad API scrolling works when native Steam controller callbacks are unavailable.');
console.log('21 UI scenarios passed (simulated Steam/gamepad input; hardware validation remains on-device).');
dom.window.close();
