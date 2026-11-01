// Shared workspace regression suite; imported by scripts/sync_web_ui.py.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const root = new URL('../web/',import.meta.url);
const dom = new JSDOM(readFileSync(new URL('index.html',root),'utf8'),{url:'https://192.168.1.20:52881/',runScripts:'outside-only',pretendToBeVisual:true});
const {window} = dom, d = window.document;
const calls = [];
let settings = {paired:true,endpoint:'192.168.1.20:52881',network_permission:true}, online = true, finishScan = null, quickFailureAddress = null;
let state = {session:{id:'session-a',pid:42,name:'Demo.exe',groups:[{id:'g1',name:'Gold'},{id:'g2',name:'Health'}],entries:[
  {id:'e1',group_id:'g1',name:'Gold',address:'0x1234',kind:'int32',value:'100',status:'ok',frozen:false},
  {id:'e2',group_id:'g1',name:'Gold copy',address:'0x1250',kind:'int32',value:'100',status:'ok',frozen:false}
]},alive:true,storage_warning:null,scan:{id:'scan-a',kind:'auto',has_scan:true,busy:false,count:1,progress:1,operator:'equal',input:'100',results:[{address:'0x9999',kind:'int32',value:'100',error:null,candidate_kinds:['int32','int64'],values:{int32:'100',int64:'100'}}]}};
const processes = Array.from({length:120},(_,i)=>({id:'process-'+i,pid:i+10,name:'Game'+i+'.exe',command:'/game/'+i}));
function response(id,data,error,status=0) { window.queueMicrotask(()=>window.ForgeReply(id,error?{ok:false,error,status}:{ok:true,data:structuredClone(data)})); }
window.ForgeNative = {request(id,action,text) {
  const args = JSON.parse(text); calls.push({action,args});
  if (action === 'cancel_reads') return response(id,{});
  if (action === 'settings') return response(id,settings);
  if (action === 'forget') { settings.paired=false;return response(id,settings); }
  if (action === 'address') { settings.endpoint=args.endpoint;return response(id,settings); }
  if (action === 'pair') { settings.paired=true;return response(id,settings); }
  if (!online) return response(id,null,'Connection lost',0);
  if (action === 'state') return response(id,state);
  if (action === 'processes') return response(id,{processes});
  if (action === 'command') {
    const {method,args:a} = args;
    assert.ok(args.expected_session_id,'Every mutation includes the observed session identity.');
    const entry = state.session.entries.find(e=>e.id===a.entry_id);
    switch(method) {
      case 'write_group': {
        const members=state.session.entries.filter(e=>e.group_id===a.group_id);
        members.forEach(e=>e.value=a.value);
        state.group_write={total:members.length,written:members.map(e=>e.id),failed:[]}; break;
      }
      case 'write_entry': entry.value=a.value;break;
      case 'write_results': {
        assert.equal(a.session_id,state.session.id);assert.equal(a.scan_id,state.scan.id);
        const written=[],failed=[];
        for(const target of a.addresses){
          if(target.address===quickFailureAddress){failed.push({id:target.address,address:target.address,error:'Test write failed'});continue;}
          const row=state.scan.results.find(r=>r.address===target.address);row.value=a.value;if(row.values)row.values[target.kind]=a.value;written.push(target.address);
        }
        state.quick_write={total:a.addresses.length,written,failed};break;
      }
      case 'rename_entry': entry.name=a.name;break;
      case 'move_entry': entry.group_id=a.group_id;break;
      case 'remove_entry': state.session.entries=state.session.entries.filter(e=>e.id!==a.entry_id);break;
      case 'freeze_entry': entry.frozen=a.enabled;break;
      case 'rename_group': state.session.groups.find(g=>g.id===a.group_id).name=a.name;break;
      case 'remove_group': state.session.groups=state.session.groups.filter(g=>g.id!==a.group_id);state.session.entries=state.session.entries.filter(e=>e.group_id!==a.group_id);break;
      case 'save_entries': {
        let group=state.session.groups.find(g=>g.id===a.group_id);
        if(!group){group={id:'g'+(state.session.groups.length+1),name:a.name};state.session.groups.push(group);}
        for(const row of a.addresses)state.session.entries.push({...row,id:'saved-'+row.address,group_id:group.id,name:a.name||group.name,value:'100',status:'ok',frozen:false});break;
      }
      case 'reset_scan': state.scan={...state.scan,has_scan:false,results:[],count:0,busy:false,operator:'equal'};break;
      case 'scan':
        state.scan.busy=true;state.scan.progress=0;
        finishScan=()=>{state.scan={...state.scan,busy:false,has_scan:true,progress:1,operator:a.operator,input:a.value,kind:a.kind};response(id,state);};
        return;
      case 'attach': state.session.id=a.expected_id;state.session.pid=a.pid;break;
      default: throw new Error(method);
    }
    return response(id,state);
  }
  throw new Error(action);
}};
window.eval(readFileSync(new URL('app.js',root),'utf8'));
const $=id=>d.getElementById(id);
const until=async fn=>{await new Promise(r=>setTimeout(r,0));for(let i=0;i<100;i++){try{fn();return;}catch{}await new Promise(r=>setTimeout(r,10));}fn();};
const click=selector=>{const el=d.querySelector(selector);assert.ok(el,selector);assert.equal(el.disabled,false,selector+' is enabled');el.click();};
const change=(el,value)=>{el.value=value;el.dispatchEvent(new window.Event('change',{bubbles:true}));};
const commands=()=>calls.filter(c=>c.action==='command');
try {
  await until(()=>assert.equal($('gameName').textContent,'Demo.exe'));
  assert.equal($('connectionBadge').querySelector('span').textContent,'Connected');
  assert.equal($('pairedAddress').textContent,settings.endpoint);
  assert.equal(d.querySelectorAll('[data-entry]').length,2);
  console.log('PASS remembered pairing connects and loads shared groups.');

  click('[data-tab="scan"]');change(d.querySelector('[data-result-kind="0x9999"]'),'int64');
  const quick=d.querySelector('[data-action="quickResult"]'),save=d.querySelector('[data-action="saveResult"]');
  assert.ok(quick.compareDocumentPosition(save) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  click('[data-action="quickResult"]');$('quickValue').value='4294967297';click('#modalApply');
  await until(()=>assert.match($('quickReport').textContent,/Updated 1 of 1 search addresses/));
  assert.equal(commands().at(-1).args.args.addresses[0].kind,'int64');
  assert.equal(commands().at(-1).args.args.value,'4294967297');
  assert.equal(state.session.entries.length,2);assert.equal(state.session.groups.length,2);
  assert.equal(commands().filter(c=>c.args.method==='save_entries').length,0);
  click('[data-action="closeModal"]');
  console.log('PASS Quick edit is above Save to group, preserves the chosen Auto width and numeric string, and creates no saved entries.');

  state.scan.results.push({address:'0x999a',kind:'uint64',value:'100',error:null});window.ValueForgeUI.update(structuredClone(state));
  click('[data-select="0x9999"]');click('[data-select="0x999a"]');click('#quickSelected');
  $('quickValue').value='123';quickFailureAddress='0x999a';click('#modalApply');
  await until(()=>assert.match($('quickReport').textContent,/Updated 1 of 2 search addresses/));
  assert.match($('quickReport').textContent,/0x999a: Test write failed/);
  assert.equal(commands().at(-1).args.args.addresses.length,2);
  assert.equal(state.session.entries.length,2);assert.equal(state.session.groups.length,2);
  quickFailureAddress=null;click('[data-action="closeModal"]');click('[data-action="clearSelection"]');
  state.scan.results.pop();window.ValueForgeUI.update(structuredClone(state));
  console.log('PASS several selected results receive one quick value with per-address failure feedback and no saved group.');

  click('[data-action="quickResult"]');online=false;await window.ValueForgeUI.poll();assert.equal($('modalApply').disabled,true);
  online=true;await window.ValueForgeUI.poll();assert.equal($('modalApply').disabled,false);
  state.scan.id='new-search-from-decky';window.ValueForgeUI.update(structuredClone(state));
  assert.equal($('modalApply').disabled,true);assert.match($('modalMessage').textContent,/changed/);
  click('[data-action="closeModal"]');
  console.log('PASS quick edits are blocked while offline and an old dialog cannot apply after another client changes the search.');

  click('[data-tab="saved"]');

  click('[data-action="groupWrite"][data-id="g1"]');$('groupValue').value='88';click('#modalApply');
  await until(()=>assert.match($('groupReport').textContent,/Updated 2 of 2/));
  assert.equal(commands().at(-1).args.method,'write_group');
  assert.ok(state.session.entries.every(e=>e.value==='88'));
  click('[data-action="closeModal"]');
  click('[data-action="freeze"][data-id="e1"]');
  await until(()=>assert.equal(state.session.entries[0].frozen,true));
  console.log('PASS one group action writes every member and individual freezing remains available.');

  click('[data-action="entry"][data-id="e1"]');$('entryName').value='Linked gold';click('[data-action="renameEntry"]');
  await until(()=>assert.equal(state.session.entries[0].name,'Linked gold'));
  $('entryValue').value='18446744073709551601';click('[data-action="writeEntry"]');
  await until(()=>assert.equal(state.session.entries[0].value,'18446744073709551601'));
  $('moveGroup').value='g2';click('[data-action="moveEntry"]');
  await until(()=>assert.equal($('modalBackdrop').hidden,true));
  assert.equal(state.session.entries[0].group_id,'g2');
  console.log('PASS labels, exact numeric strings, and moves work independently for each address.');

  click('[data-tab="scan"]');change(d.querySelector('[data-result-kind="0x9999"]'),'int64');
  click('[data-action="saveResult"]');$('groupName').value='Result';click('#modalApply');
  await until(()=>assert.equal($('modalBackdrop').hidden,true));
  assert.equal(commands().at(-1).args.args.addresses[0].kind,'int64');
  console.log('PASS ambiguous Auto results retain the selected concrete type when saved.');

  click('[data-tab="scan"]');change($('scanOperator'),'increased_by');$('scanValue').value='25';
  click('#scanAction');await until(()=>assert.ok(finishScan));
  state.scan.progress=.42;await window.ValueForgeUI.poll();
  assert.equal($('progress').value,42);
  assert.equal($('valueCaption').textContent,'Change amount');
  assert.equal(commands().at(-1).args.args.value,'25');
  assert.ok($('scanAction').compareDocumentPosition($('scanProgress')) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok($('scanProgress').compareDocumentPosition($('resetScan')) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  finishScan();await until(()=>assert.equal($('scanProgress').hidden,true));
  console.log('PASS exact-difference search streams progress between Narrow and Start a new search.');

  $('scanValue').value='7654321';state.session.entries[0].value='17';await window.ValueForgeUI.poll();
  assert.equal($('scanValue').value,'7654321');
  click('#resetScan');await until(()=>assert.equal(state.scan.has_scan,false));
  change($('scanOperator'),'unknown');assert.equal($('valueLabel').hidden,true);
  click('#scanAction');await until(()=>assert.ok(state.scan.busy));
  assert.ok($('scanProgress').compareDocumentPosition($('scanAction')) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  finishScan();await until(()=>assert.equal($('scanProgress').hidden,true));
  console.log('PASS refreshes preserve numeric drafts and unknown initial scans have visible progress above Start.');

  click('[data-tab="process"]');await until(()=>assert.equal(d.querySelectorAll('.process').length,120));
  $('processFilter').value='Game119';$('processFilter').dispatchEvent(new window.Event('input',{bubbles:true}));
  assert.equal(d.querySelectorAll('.process').length,1);click('.process');
  await until(()=>assert.equal(state.session.id,'process-119'));
  assert.equal(commands().at(-1).args.args.pid,129);
  console.log('PASS all processes share one list and a single tap connects to a filtered process.');

  click('[data-tab="saved"]');click('[data-action="manual"]');$('groupName').value='<img src=x onerror=alert(1)>';$('manualAddress').value='0xabcdef';change($('manualKind'),'uint64');click('#modalApply');
  await until(()=>assert.equal($('modalBackdrop').hidden,true));
  assert.equal(commands().at(-1).args.args.addresses[0].kind,'uint64');
  assert.equal(d.querySelector('#savedGroups img'),null);
  console.log('PASS manual addresses support every concrete type and group labels are escaped.');

  online=false;await window.ValueForgeUI.poll();
  assert.equal($('connectionBadge').querySelector('span').textContent,'Reconnecting');
  assert.ok(d.querySelector('[data-action="manual"]').disabled);
  click('[data-tab="connection"]');click('[data-action="address"]');
  assert.equal($('modalApply').disabled,false);
  online=true;$('newAddress').value='192.168.1.21:52881';click('#modalApply');
  await until(()=>assert.equal($('modalBackdrop').hidden,true));
  assert.equal(settings.paired,true);assert.equal(settings.endpoint,'192.168.1.21:52881');
  await window.ValueForgeUI.poll();
  assert.equal($('connectionBadge').querySelector('span').textContent,'Connected');
  console.log('PASS disconnects disable writes and remembered pairing reconnects at an updated address.');

  online=false;await window.ValueForgeUI.poll();click('[data-action="forget"]');assert.equal($('modalApply').disabled,false);click('#modalApply');
  await until(()=>assert.equal($('pairForm').hidden,false));
  assert.equal(settings.paired,false);assert.ok(state.session.groups.length>0);
  console.log('PASS forgetting a pairing works while offline and does not delete saved groups.');
  console.log('13 companion UI scenarios passed.');
} finally { window.ValueForgeUI.close();dom.window.close(); }
