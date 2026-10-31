import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ButtonItem, DialogButton, DropdownItem, Focusable, PanelSection, PanelSectionRow,
  SteamSpinner, ToggleField, staticClasses } from '@decky/ui';
import { callable, definePlugin, useQuickAccessVisible } from '@decky/api';
import { ControllerPad } from './components/ControllerPad';
import { useRightStickScroll } from './hooks/useRightStickScroll';

interface Entry {
  id: string; group_id: string; name: string; address: string; kind: string; value: string | null;
  previous: string | null; changed: boolean; status: 'ok' | 'unavailable' | 'exited';
  error: string | null; frozen: boolean; updated_at: number | null;
}
interface Group { id: string; name: string }
interface Address { address: string; kind: string }
interface Match { address: string; kind: string; value: string | null; error: string | null; candidate_kinds?: string[]; values?: Record<string, string | null> }
interface GroupWriteReport {
  group_id: string; name: string; value: string; total: number; written: string[];
  failed: { id: string; name: string; address: string; error: string }[]; updated_at: number;
}
interface State {
  session: { id: string; pid: number; name: string; entries: Entry[]; groups: Group[] } | null;
  alive: boolean; storage_warning: string | null; group_write?: GroupWriteReport | null;
  scan: { kind: string; has_scan: boolean; count: number; results: Match[]; operator: string; input: string; busy: boolean; progress?: number };
}
interface Process { id: string; pid: number; name: string; command: string }
const api = {
  state: callable<[refresh: boolean], State>('get_state'),
  processes: callable<[], Process[]>('get_processes'),
  attach: callable<[pid: number, identity: string], State>('attach'),
  scan: callable<[operator: string, value: string, kind: string], State>('scan'),
  reset: callable<[], State>('reset_scan'),
  save: callable<[name: string, addresses: Address[], groupId: string], State>('save_entries'),
  renameGroup: callable<[id: string, name: string], State>('rename_group'),
  removeGroup: callable<[id: string], State>('remove_group'),
  move: callable<[id: string, groupId: string], State>('move_entry'),
  rename: callable<[id: string, name: string], State>('rename_entry'),
  remove: callable<[id: string], State>('remove_entry'),
  write: callable<[id: string, value: string], State>('write_entry'),
  writeGroup: callable<[id: string, value: string], State>('write_group'),
  freeze: callable<[id: string, enabled: boolean], State>('freeze_entry'),
};
const types = ['int32', 'uint32', 'float32', 'float64', 'int8', 'uint8', 'int16', 'uint16', 'int64', 'uint64'];
const operators = [
  ['equal', 'Equals'], ['not_equal', 'Does not equal'], ['greater', 'Greater than'], ['less', 'Less than'],
  ['changed', 'Changed'], ['unchanged', 'Unchanged'], ['increased', 'Increased'], ['decreased', 'Decreased'],
  ['increased_by', 'Increased by X'], ['decreased_by', 'Decreased by X'], ['unknown', 'Unknown initial value'],
];
const withoutValue = new Set(['unknown', 'changed', 'unchanged', 'increased', 'decreased']);
const initialOperators = new Set(['equal', 'not_equal', 'greater', 'less', 'unknown']);
const typeOptions = types.map(data => ({ data, label: data }));
const searchTypeOptions = [{ data: 'auto', label: 'Auto' }, ...typeOptions];
type Tab = 'saved' | 'scan' | 'process';
// Keep navigation and the connected process identity across panel remounts.
// A process row press connects directly; refreshing the list never attaches.
let lastTab: Tab = 'saved';
let processChoice: Process | null = null;
let processCache: Process[] = [];
type Form = { mode: 'save'; addresses: Address[] } | { mode: 'edit'; entry: Entry } | { mode: 'group'; group: Group } | { mode: 'group-write'; group: Group } | null;

const styles = `
.mds { color:#e6edf3; font-size:14px; padding-bottom:20px; }
.mds .mds-progress { display:block; width:100%; height:14px; margin-top:8px; accent-color:#8de2c8; }
.mds .mds-banner { margin:0 16px 14px; padding:12px; background:#172631; border:1px solid #315263; border-radius:10px; }
.mds .mds-pad { margin:8px 0; }
.mds .mds-pad-readout { display:block; font:18px monospace; padding:8px; border:1px solid #354453; border-radius:6px; overflow-wrap:anywhere; }
.mds .mds-keypad { display:grid; gap:6px; margin:8px 0; }
.mds .mds-keypad-number { grid-template-columns:repeat(3,minmax(0,1fr)); }
.mds .mds-keypad-hex { grid-template-columns:repeat(4,minmax(0,1fr)); }
.mds .mds-keypad-text { grid-template-columns:repeat(6,minmax(0,1fr)); }
.mds .mds-keypad button { min-width:0!important; padding:8px 2px!important; font-size:14px; }
.mds .mds-muted { color:#aebdca; font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
.mds .mds-error { margin:10px 16px; padding:10px; background:#3a2027; border-radius:8px; color:#ffc2c7; overflow-wrap:anywhere; }
.mds .mds-notice { margin:8px 16px; color:#8de2c8; font-size:12px; }
.mds .mds-tabs { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; margin:0 16px 16px; }
.mds .mds-tabs button,.mds .mds-actions button { min-width:0!important; padding:8px!important; font-size:12px; }
.mds .mds-tabs .mds-active { background:#25617c; color:white; }
.mds .mds-process-choice[data-selected="true"] { border-left:3px solid #8de2c8; padding-left:8px; }
.mds .mds-card { background:#18212c; border:1px solid #354453; border-radius:10px; padding:12px; margin-bottom:10px; }
.mds .mds-address { border-top:1px solid #354453; padding-top:10px; margin-top:12px; }
.mds .mds-address.mds-changed { border-top-color:#d9ae57; }
.mds .mds-card.mds-changed { border-color:#d9ae57; }
.mds .mds-value { font-family:monospace; font-size:23px; line-height:1.35; margin:5px 0; overflow-wrap:anywhere; }
.mds .mds-changed .mds-value { color:#f3d085; }
.mds .mds-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; margin-top:10px; }
.mds .mds-name { font-size:15px; font-weight:600; overflow-wrap:anywhere; }
.mds .mds-code { font-family:monospace; }
.mds .mds-empty { padding:12px 0; color:#aebdca; line-height:1.6; }
.mds .mds-form { border-top:1px solid #354453; padding-top:12px; margin-top:12px; }
`;
function Row({ children }: { children: ReactNode }) { return <PanelSectionRow>{children}</PanelSectionRow>; }

function Content() {
  // Keep the content mounted while Steam opens its own menus, and refresh
  // saved values when the QAM becomes visible again.
  const visible = typeof useQuickAccessVisible === 'function' ? useQuickAccessVisible() : true;
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanPending, setScanPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useRightStickScroll(rootRef, visible);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<Tab>(lastTab);
  const [processes, setProcesses] = useState<Process[]>(processCache);
  const [selectedProcessId, setSelectedProcessId] = useState<string | undefined>(processChoice?.id);
  const [processFilter, setProcessFilter] = useState('');
  const [loadingProcesses, setLoadingProcesses] = useState(false);
  const [kind, setKind] = useState('auto');
  const [operator, setOperator] = useState('equal');
  const [input, setInput] = useState('0');
  const [page, setPage] = useState(0);
  const [form, setForm] = useState<Form>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [manualAddress, setManualAddress] = useState('');
  const [manualKind, setManualKind] = useState('int32');
  const [destinationGroup, setDestinationGroup] = useState('');
  const [moveGroup, setMoveGroup] = useState('');
  const [selectedMatches, setSelectedMatches] = useState<string[]>([]);
  const [resultTypes, setResultTypes] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  const operationPending = useRef(false);
  const processRequest = useRef(0);
  const attachedSession = useRef<string | undefined>(undefined);
  const searchSnapshot = useRef<string | null>(null);
  attachedSession.current = state?.session?.id;
  useEffect(() => { lastTab = tab; }, [tab]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestVersion.current++; processRequest.current++; }; }, []);
  const apply = useCallback((next: State) => {
    setState(next);
    // A values-only refresh must not overwrite a search field the user is
    // currently editing, for example when a Steam dropdown closes.
    const snapshot = JSON.stringify([next.session?.id, next.scan.kind, next.scan.has_scan,
      next.scan.operator, next.scan.input, next.scan.count]);
    if (searchSnapshot.current !== snapshot) {
      searchSnapshot.current = snapshot;
      setKind(next.scan.kind);
      setOperator(next.scan.operator);
      setInput(next.scan.input || '0');
    }
  }, []);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setRefreshing(true);
    setError('');
    try {
      const next = await api.state(true);
      if (mounted.current && version === requestVersion.current) apply(next);
    } catch (e) {
      if (mounted.current && version === requestVersion.current) setError(String(e));
    } finally {
      if (mounted.current && version === requestVersion.current) setRefreshing(false);
    }
  }, [apply]);
  useEffect(() => { if (visible) void refresh(); }, [visible, refresh]);
  useEffect(() => {
    if (!visible || !(scanPending || state?.scan.busy)) return;
    let active = true;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void api.state(false).then(next => {
        if (active && mounted.current) apply(next);
      }).catch(e => { if (active && mounted.current) setError(String(e)); }).finally(() => { pending = false; });
    }, 250);
    return () => { active = false; clearInterval(timer); };
  }, [visible, scanPending, state?.scan.busy, apply]);

  const run = async (operation: () => Promise<State>, message = '') => {
    if (operationPending.current) return;
    operationPending.current = true;
    ++requestVersion.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await operation();
      if (mounted.current) { apply(next); setNotice(message); }
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      operationPending.current = false;
      if (mounted.current) { setBusy(false); setRefreshing(false); }
    }
  };
  const chooseProcess = (candidate: Process | null) => {
    processChoice = candidate;
    setSelectedProcessId(candidate?.id);
  };
  const loadProcesses = async () => {
    const version = ++processRequest.current;
    setLoadingProcesses(true);
    setError('');
    try {
      const next = await api.processes();
      if (!mounted.current || version !== processRequest.current) return;
      processCache = next;
      setProcesses(next);
      // Compare full session identities, not PIDs. Read the current choice
      // after the response arrives so a slow reload cannot undo a recent click.
      const previous = processChoice;
      const candidate = previous ? next.find(p => p.id === previous.id)
        : next.find(p => p.id === attachedSession.current);
      chooseProcess(candidate ?? null);
      if (previous && !candidate) setNotice('The selected process exited. Choose another running process.');
    } catch (e) {
      if (mounted.current && version === processRequest.current) setError(String(e));
    } finally {
      if (mounted.current && version === processRequest.current) setLoadingProcesses(false);
    }
  };
  useEffect(() => { if (tab === 'process') void loadProcesses(); }, [tab]);
  const edit = (entry: Entry) => {
    setForm({ mode: 'edit', entry }); setName(entry.name); setValue(entry.value ?? '');
    setMoveGroup(entry.group_id); setConfirmRemove(null);
  };
  const save = (addresses: Address[], groupId = '') => {
    setForm({ mode: 'save', addresses }); setName(''); setDestinationGroup(groupId);
    setManualAddress(''); setTab('saved');
  };
  const editGroup = (group: Group) => { setForm({ mode: 'group', group }); setName(group.name); setConfirmRemove(null); };
  // A background read must not disable the focused Steam control. That can
  // dismiss its menu while the user is selecting an option.
  const locked = busy || (!state && refreshing) || Boolean(state?.scan.busy);
  const entries = state?.session?.entries ?? [];
  const groups = state?.session?.groups ?? [];
  const groupOptions = groups.map(group => ({ data: group.id, label: group.name }));
  const live = state?.alive ?? false;
  const selected = processes.find(p => p.id === selectedProcessId);
  const filter = processFilter.trim().toLocaleLowerCase();
  const filteredProcesses = processes.filter(p => !filter ||
    `${p.name} ${p.pid} ${p.command}`.toLocaleLowerCase().includes(filter));
  const currentEntry = form?.mode === 'edit' ? entries.find(e => e.id === form.entry.id) : undefined;
  const matches = state?.scan.results ?? [];
  const matchType = (match: Match) => resultTypes[match.address] ?? match.kind;
  const matchAddress = (match: Match): Address => ({ address: match.address, kind: matchType(match) });
  const connectProcess = (candidate: Process) => void run(async () => {
    await api.attach(candidate.pid, candidate.id);
    processChoice = candidate; setSelectedProcessId(candidate.id);
    const next = await api.state(true);
    setTab(next.session?.entries.length ? 'saved' : 'scan'); setForm(null);
    setSelectedMatches([]); setResultTypes({}); return next;
  }, 'Connected to this game session.');
  const groupMembers = form?.mode === 'group-write' ? entries.filter(entry => entry.group_id === form.group.id) : [];
  const groupReport = form?.mode === 'group-write' && state?.group_write?.group_id === form.group.id && state.group_write.value === value ? state.group_write : null;
  const showForm = form && <div className="mds-form">
    {form.mode === 'edit' ? <>
      <ControllerPad label="Address label" mode="text" value={name} disabled={locked} onChange={setName} />
      <ControllerPad label="New value" value={value} disabled={locked || !live} onChange={setValue} />
      <Focusable className="mds-actions">
        <DialogButton disabled={locked || !name.trim()} onClick={() => void run(() => api.rename(form.entry.id, name), 'Address label saved.')}>Save label</DialogButton>
        <DialogButton disabled={locked || !live || currentEntry?.status !== 'ok'} onClick={() => void run(() => api.write(form.entry.id, value), 'Value written and read back.')}>Write value</DialogButton>
      </Focusable>
      <ToggleField label="Freeze value" description="Reapply this address every 0.5 seconds." checked={currentEntry?.frozen ?? false}
        disabled={locked || !live || currentEntry?.status !== 'ok'} onChange={enabled => void run(() => api.freeze(form.entry.id, enabled))} />
      <DropdownItem label="Move to group" rgOptions={groupOptions} selectedOption={moveGroup} disabled={locked} onChange={o => setMoveGroup(o.data)} />
      <ButtonItem layout="below" disabled={locked || !moveGroup || moveGroup === currentEntry?.group_id} onClick={() => void run(async () => {
        const next = await api.move(form.entry.id, moveGroup); setForm(null); return next;
      }, 'Address moved. Its value was not changed.')}>Move address</ButtonItem>
      <Focusable className="mds-actions">
        <DialogButton disabled={locked} onClick={() => {
          if (confirmRemove !== form.entry.id) { setConfirmRemove(form.entry.id); return; }
          void run(async () => { const next = await api.remove(form.entry.id); setForm(null); return next; }, 'Address removed. Other addresses kept.');
        }}>{confirmRemove === form.entry.id ? 'Confirm remove' : 'Remove address'}</DialogButton>
        <DialogButton disabled={locked} onClick={() => setForm(null)}>Done</DialogButton>
      </Focusable>
    </> : form.mode === 'group-write' ? <>
      <div className="mds-name">Change all values in {form.group.name}</div>
      <div className="mds-muted">Apply one value to all {groupMembers.length} addresses, using each address's saved type. Frozen addresses keep the new value.</div>
      <ControllerPad label="Group value" value={value} disabled={locked || !live} onChange={setValue} initialOpen />
      <Focusable className="mds-actions">
        <DialogButton disabled={locked || !live || !groupMembers.length} onClick={() => void run(() => api.writeGroup(form.group.id, value))}>Apply to entire group</DialogButton>
        <DialogButton disabled={locked} onClick={() => setForm(null)}>Done</DialogButton>
      </Focusable>
      {groupReport && <div role={groupReport.failed.length ? 'alert' : 'status'} className="mds-muted">
        Updated {groupReport.written.length} of {groupReport.total} addresses at {new Date(groupReport.updated_at * 1000).toLocaleTimeString()}.
        {groupReport.failed.map(failure => <div key={failure.id}>{failure.name} ({failure.address}): {failure.error}</div>)}
      </div>}
    </> : form.mode === 'group' ? <>
      <ControllerPad label="Group name" mode="text" value={name} disabled={locked} onChange={setName} />
      <Focusable className="mds-actions">
        <DialogButton disabled={locked || !name.trim()} onClick={() => void run(() => api.renameGroup(form.group.id, name), 'Group name saved.')}>Save group name</DialogButton>
        <DialogButton disabled={locked} onClick={() => setForm(null)}>Done</DialogButton>
      </Focusable>
      <ButtonItem layout="below" disabled={locked} description="Remove this saved group and all its addresses. Game memory is not changed." onClick={() => {
        const id = 'group:' + form.group.id;
        if (confirmRemove !== id) { setConfirmRemove(id); return; }
        void run(async () => { const next = await api.removeGroup(form.group.id); setForm(null); return next; }, 'Group removed.');
      }}>{confirmRemove === 'group:' + form.group.id ? 'Confirm delete group' : 'Delete group'}</ButtonItem>
    </> : <>
      <DropdownItem label="Save to group" rgOptions={[{ data: '', label: 'New group' }, ...groupOptions]} selectedOption={destinationGroup}
        disabled={locked} onChange={o => setDestinationGroup(o.data)} />
      {!destinationGroup && <ControllerPad label="Group name" mode="text" value={name} disabled={locked} onChange={setName} placeholder="Gold, Health, Ammo…" />}
      {form.addresses.length ? <div className="mds-muted">{form.addresses.length} selected address{form.addresses.length === 1 ? '' : 'es'}
        {form.addresses.map(row => <div className="mds-code" key={row.address + row.kind}>{row.address} · {row.kind}</div>)}</div> : <>
          <ControllerPad label="Address (hex)" mode="hex" value={manualAddress} disabled={locked} placeholder="0x1234abcd" onChange={setManualAddress} />
          <DropdownItem label="Value type" rgOptions={typeOptions} selectedOption={manualKind} disabled={locked} onChange={o => setManualKind(o.data)} />
        </>}
      <Focusable className="mds-actions">
        <DialogButton disabled={locked || !live || (!destinationGroup && !name.trim()) || (!form.addresses.length && !manualAddress.trim())} onClick={() => void run(async () => {
          const addresses = form.addresses.length ? form.addresses : [{ address: manualAddress.trim(), kind: manualKind }];
          const next = await api.save(name, addresses, destinationGroup); setForm(null); setSelectedMatches([]); return next;
        }, 'Addresses saved together in their group.')}>Save addresses</DialogButton>
        <DialogButton disabled={locked} onClick={() => setForm(null)}>Cancel</DialogButton>
      </Focusable>
    </>}
  </div>;

  const scanning = scanPending || Boolean(state?.scan.busy);
  const progress = Math.round(Math.max(0, Math.min(1, state?.scan.progress ?? 0)) * 100);
  const deltaSearch = operator === 'increased_by' || operator === 'decreased_by';
  const scanProgress = scanning && <div className="mds-notice" role="status">
    Scanning memory: {progress}%
    <progress className="mds-progress" aria-label="Memory scan progress" max={100} value={progress} />
  </div>;
  return <div className="mds" ref={rootRef}>
    <style>{styles}</style>
    <div className="mds-banner">
      <div className="mds-name">{state?.session?.name ?? 'Choose your game process'}</div>
      <div className="mds-muted">{state?.session ? `PID ${state.session.pid} · ${live ? 'Session active' : 'Game not running'}` : 'Named address groups for your current session.'}</div>
      <div className="mds-muted">{refreshing ? 'Reading current values…' : 'Values refresh whenever you reopen this panel.'}</div>
      <div className="mds-muted">Based on Memory Deck by Camzie99 and contributors · scanmem.</div>
    </div>
    <Focusable className="mds-tabs">
      {([['saved', `Saved (${groups.length})`], ['scan', 'Search'], ['process', 'Process']] as [Tab, string][]).map(([id, label]) =>
        <DialogButton key={id} className={tab === id ? 'mds-active' : ''} disabled={locked} onClick={() => { setTab(id); setForm(null); }}>{label}</DialogButton>)}
    </Focusable>
    {error && <div role="alert" className="mds-error">{error}</div>}
    {state?.storage_warning && <div role="alert" className="mds-error">{state.storage_warning}</div>}
    {notice && <div role="status" className="mds-notice">{notice}</div>}
    {tab !== 'scan' && scanProgress}
    {!scanning && busy && <div role="status" className="mds-notice">Working… <SteamSpinner /></div>}
    {!state && refreshing && <SteamSpinner />}
    {tab === 'saved' && <PanelSection title="Your saved groups">
      <Row><ButtonItem layout="below" disabled={locked || !state?.session} onClick={() => void refresh()}>Refresh values</ButtonItem></Row>
      {!groups.length && <Row><div className="mds-empty">Find one or more addresses in Search, then save them together in a named group. Each address keeps its own value and controls.</div></Row>}
      {form?.mode === 'save' && <Row>{showForm}</Row>}
      {groups.map(group => {
        const members = entries.filter(entry => entry.group_id === group.id);
        return <Row key={group.id}><div className="mds-card">
          <div className="mds-name" role="heading" aria-level={3}>{group.name}</div>
          <div className="mds-muted">{members.length} address{members.length === 1 ? '' : 'es'}</div>
          <Focusable className="mds-actions">
            <DialogButton disabled={locked} onClick={() => editGroup(group)}>Rename / Delete group</DialogButton>
            <DialogButton disabled={locked || !live} onClick={() => save([], group.id)}>Add address</DialogButton>
          </Focusable>
          <ButtonItem layout="below" disabled={locked || !live || !members.length} onClick={() => {
            setValue(members[0]?.value ?? '0'); setForm({ mode: 'group-write', group });
          }}>Change all values</ButtonItem>
          {(form?.mode === 'group' || form?.mode === 'group-write') && form.group.id === group.id && showForm}
          {!members.length && <div className="mds-empty">No saved addresses. Add another address to reuse this group.</div>}
          {members.map((entry, index) => <div key={entry.id} className={`mds-address ${entry.changed ? 'mds-changed' : ''}`}>
            <div className="mds-name">{entry.name === group.name ? `Address ${index + 1}` : entry.name}{entry.frozen ? ' · Frozen' : ''}</div>
            <div className="mds-value">{refreshing ? 'Refreshing…' : entry.status === 'ok' ? entry.value : entry.status === 'exited' ? 'Game not running' : 'Unavailable'}</div>
            {!refreshing && entry.changed && <div className="mds-muted">Changed from {entry.previous}</div>}
            <div className="mds-muted mds-code">{entry.address} · {entry.kind}</div>
            {entry.updated_at && !refreshing && <div className="mds-muted">Read at {new Date(entry.updated_at * 1000).toLocaleTimeString()}</div>}
            {entry.error && <div className="mds-muted">{entry.error}</div>}
            {form?.mode === 'edit' && form.entry.id === entry.id ? showForm : <Focusable className="mds-actions">
              <DialogButton disabled={locked} onClick={() => edit(entry)}>Edit address</DialogButton>
              <DialogButton disabled={locked || !live || entry.status !== 'ok'} onClick={() => void run(() => api.freeze(entry.id, !entry.frozen))}>{entry.frozen ? 'Unfreeze' : 'Freeze'}</DialogButton>
            </Focusable>}
          </div>)}
        </div></Row>;
      })}
      {live && !form && <Row><ButtonItem layout="below" disabled={locked} onClick={() => save([])}>Add address manually</ButtonItem></Row>}
    </PanelSection>}
    {tab === 'scan' && <PanelSection title="Find a value">
      {!live ? <Row><div className="mds-empty">Select your running game in Process to start searching.</div></Row> : <>
        <Row><DropdownItem label="Value type" rgOptions={searchTypeOptions} selectedOption={kind} disabled={locked || state?.scan.has_scan} onChange={o => setKind(o.data)} /></Row>
        <Row><DropdownItem label="Compare" selectedOption={operator} disabled={locked} rgOptions={operators.filter(([id]) => state?.scan.has_scan ? id !== 'unknown' : initialOperators.has(id)).map(([data, label]) => ({ data, label }))} onChange={o => setOperator(o.data)} /></Row>
        {!withoutValue.has(operator) && <Row><ControllerPad label={deltaSearch ? 'Change amount' : 'Search value'} value={input} disabled={locked} onChange={setInput} initialOpen /></Row>}
        {deltaSearch && <Row><div className="mds-muted">Enter how much the value {operator === 'increased_by' ? 'increased' : 'decreased'} since the previous search, rather than its current total. Use a positive amount. Each narrow search becomes the next comparison point.</div></Row>}
        {!state?.scan.has_scan && scanProgress && <Row>{scanProgress}</Row>}
        <Row><ButtonItem layout="below" disabled={locked} onClick={() => void run(async () => {
          setScanPending(true);
          setState(previous => previous ? { ...previous, scan: { ...previous.scan, progress: 0 } } : previous);
          try { const next = await api.scan(operator, input, kind); setPage(0); setSelectedMatches([]); setResultTypes({}); return next; }
          finally { if (mounted.current) setScanPending(false); }
        })}>{state?.scan.has_scan ? 'Narrow results' : 'Start search'}</ButtonItem></Row>
        {state?.scan.has_scan && scanProgress && <Row>{scanProgress}</Row>}
        {state?.scan.has_scan && <Row><ButtonItem layout="below" disabled={locked} description="Your named entries stay saved." onClick={() => void run(async () => { const next = await api.reset(); setOperator('equal'); setSelectedMatches([]); setResultTypes({}); next.scan.operator = 'equal'; return next; }, 'Search reset. Saved entries kept.')}>Start a new search</ButtonItem></Row>}
        <Row><div className="mds-muted">{state?.scan.has_scan ? `${state.scan.count.toLocaleString()} matches · showing up to the first 200` : 'Change the value in-game between searches to narrow the results.'}</div></Row>
        {matches.length > 0 && <Row>
          <Focusable className="mds-actions">
            <DialogButton disabled={locked || !selectedMatches.length} onClick={() => save(matches.filter(row => selectedMatches.includes(row.address)).map(matchAddress))}>Save selected ({selectedMatches.length})</DialogButton>
            <DialogButton disabled={locked || !selectedMatches.length} onClick={() => setSelectedMatches([])}>Clear selection</DialogButton>
          </Focusable>
        </Row>}
        {matches.slice(page * 10, page * 10 + 10).map(match => <Row key={match.address}><div className="mds-card">
          <div className="mds-value">{(match.values ? match.values[matchType(match)] : match.value) ?? 'Unavailable'}</div>
          <div className="mds-muted mds-code">{match.address} · {matchType(match)}</div>
          {state?.scan.kind === 'auto' && (match.candidate_kinds?.length ?? 0) > 1 && <>
            <div className="mds-muted">Several types match. Choose the type to save; the default is a suggestion.</div>
            <DropdownItem label={`Saved type for ${match.address}`} selectedOption={matchType(match)} disabled={locked}
              rgOptions={match.candidate_kinds!.map(data => ({ data, label: data }))}
              onChange={option => setResultTypes(previous => ({ ...previous, [match.address]: option.data }))} />
          </>}
          <ToggleField label={`Select ${match.address}`} checked={selectedMatches.includes(match.address)} disabled={locked}
            onChange={checked => setSelectedMatches(previous => checked ? [...previous, match.address] : previous.filter(address => address !== match.address))} />
          <ButtonItem layout="below" disabled={locked} onClick={() => save([matchAddress(match)])}>Save to group</ButtonItem>
        </div></Row>)}
        {matches.length > 10 && <Row><Focusable className="mds-actions">
          <DialogButton disabled={locked || page === 0} onClick={() => setPage(p => p - 1)}>Previous</DialogButton>
          <DialogButton disabled={locked || (page + 1) * 10 >= matches.length} onClick={() => setPage(p => p + 1)}>Next</DialogButton>
        </Focusable><div className="mds-muted">Page {page + 1} of {Math.ceil(matches.length / 10)}</div></Row>}
      </>}
    </PanelSection>}
    {tab === 'process' && <PanelSection title="Select a running game">
      <Row><div className="mds-muted">Select the game's executable, rather than Steam or its launcher. Switching back to the same running process restores its named entries.</div></Row>
      <Row><ButtonItem layout="below" disabled={locked || loadingProcesses} onClick={() => void loadProcesses()}>Reload process list</ButtonItem></Row>
      <Row><ControllerPad label="Filter processes" mode="text" placeholder="All processes" value={processFilter}
        disabled={locked} onChange={setProcessFilter} /></Row>
      {loadingProcesses && <Row><div role="status" className="mds-muted">Loading processes…</div></Row>}
      <Row><div className="mds-muted">{filteredProcesses.length} matching process{filteredProcesses.length === 1 ? '' : 'es'}. Scroll with the D-pad and press A on a row to connect.</div></Row>
      {filteredProcesses.map(candidate => <Row key={candidate.id}>
        <div className="mds-process-choice" data-selected={selectedProcessId === candidate.id}>
          <ButtonItem layout="below" disabled={locked} onClick={event => {
            event?.stopPropagation?.(); connectProcess(candidate);
          }}>{selectedProcessId === candidate.id ? '✓ ' : ''}{candidate.name} · PID {candidate.pid}</ButtonItem>
        </div>
      </Row>)}
      {selected && <Row><div className="mds-muted">Connected selection: {selected.name} · PID {selected.pid}</div></Row>}
      {!loadingProcesses && !processes.length && <Row><div className="mds-empty">No processes listed yet. Start your game, then reload the list.</div></Row>}
      {!loadingProcesses && processes.length > 0 && !filteredProcesses.length && <Row><div className="mds-empty">No processes match this filter. Try another name or clear the filter.</div></Row>}
    </PanelSection>}
  </div>;
}

export default definePlugin(() => ({
  name: 'Value Forge',
  titleView: <div className={staticClasses.Title}>Value Forge</div>,
  content: <Content />,
  icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 3h14v18l-7-4-7 4V3Z" /></svg>,
  // Steam menus can temporarily hide QAM visibility. Unmounting here would
  // destroy the control that opened the menu before its selection is returned.
  alwaysRender: true,
  onDismount() {},
}));
