// Shared workspace regression suite; imported by scripts/sync_web_ui.py.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const root=new URL('../web/',import.meta.url);
async function workspace(mode='offline') {
  const dom=new JSDOM(readFileSync(new URL('index.html',root),'utf8'),{url:'https://192.168.1.20:52881/',runScripts:'outside-only'});
  const w=dom.window,d=w.document,calls=[],held=[],timers=new Map();let clock=1,sequence=0;
  const RealDate=w.Date;w.Date=class extends RealDate {static now(){return clock;}};
  w.setTimeout=(fn,delay=0)=>{const id=++sequence;timers.set(id,{fn,at:clock+Math.max(1,delay)});return id;};
  w.clearTimeout=id=>timers.delete(id);
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  const state={session:{id:'game-a',pid:42,name:'Connected game',groups:[],entries:[]},alive:true,scan:{id:'scan-a',kind:'auto',has_scan:false,results:[],busy:false,count:0},storage_warning:null};
  const reply=(id,data,error)=>w.ForgeReply(id,error?{ok:false,error,status:0}:{ok:true,data:structuredClone(data)});
  w.ForgeNative={request(id,action,text){
    const args=JSON.parse(text);calls.push({id,action,args});
    if(action==='settings')return reply(id,{paired:true,endpoint:'192.168.1.20:52881',network_permission:true});
    if(action==='cancel_reads')return reply(id,{});
    if(action==='state'){
      if(mode==='hold'){held.push(id);return;}
      return mode==='online'?reply(id,state):reply(id,null,'Machine is offline');
    }
    throw Error(action);
  }};
  w.eval(readFileSync(new URL('app.js',root),'utf8'));await flush();
  const advance=async ms=>{
    const target=clock+ms;
    for(let guard=0;guard<1000;guard++){
      const next=[...timers.entries()].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)break;
      clock=next[1].at;timers.delete(next[0]);next[1].fn();await flush();
      if(guard===999)throw Error('Runaway retry loop');
    }
    clock=target;await flush();
  };
  return {w,d,calls,held,state,advance,flush,reply,setMode:value=>{mode=value;},reads:()=>calls.filter(c=>c.action==='state'),toggle:async()=>{w.ValueForgeUI.showTab('connection');d.getElementById('connectionPageToggle').click();await flush();},close:()=>{w.ValueForgeUI.close();dom.window.close();}};
}
let app=await workspace();
try{
  assert.equal(app.d.getElementById('connectionPageToggle').textContent,'Disconnect');
  assert.equal(app.d.querySelectorAll('[data-action="toggleConnection"]').length,1);
  assert.ok(app.d.getElementById('connectionPageToggle').closest('#tab-connection'));
  await app.advance(9999);assert.equal(app.d.querySelector('#connectionBadge span').textContent,'Reconnecting');
  assert.ok(app.reads().length>1);assert.ok(app.reads().every(r=>r.args.timeout_ms<=8000));
  await app.advance(1);assert.equal(app.d.getElementById('connectionPageToggle').textContent,'Reconnect');
  assert.match(app.d.getElementById('connectionHint').textContent,/10 seconds/);
  const stopped=app.reads().length;await app.advance(60000);assert.equal(app.reads().length,stopped);
  app.w.ForgeLifecycle(false);app.w.ForgeLifecycle(true);await app.flush();await app.advance(20000);assert.equal(app.reads().length,stopped);
  app.setMode('online');await app.toggle();assert.equal(app.d.querySelector('#connectionBadge span').textContent,'Connected');
  assert.equal(app.d.getElementById('gameName').textContent,'Connected game');
  console.log('PASS automatic failures stop at 10 seconds, stay stopped after resume, and manual Connect starts a new attempt.');
  app.w.ValueForgeUI.showTab('connection');
  assert.equal(app.d.getElementById('connectionPageToggle').textContent,'Disconnect');
  app.d.getElementById('connectionPageToggle').click();await app.flush();
  assert.equal(app.d.getElementById('connectionPageToggle').textContent,'Reconnect');
  const disconnected=app.reads().length;await app.advance(60000);
  assert.equal(app.reads().length,disconnected);assert.equal(app.d.querySelector('#connectionBadge span').textContent,'Disconnected');
  assert.equal(app.d.getElementById('pairedInfo').hidden,false);
  assert.ok(app.d.querySelector('[data-action="manual"]').disabled);
  app.w.ForgeLifecycle(false);app.w.ForgeLifecycle(true);await app.flush();await app.advance(20000);assert.equal(app.reads().length,disconnected);
  console.log('PASS manual Disconnect pauses reads and edits, preserves pairing, and survives background/resume.');
  app.d.getElementById('connectionPageToggle').click();await app.flush();
  assert.equal(app.d.querySelector('#connectionBadge span').textContent,'Connected');
  assert.equal(app.d.getElementById('connectionPageToggle').textContent,'Disconnect');
}finally{app.close();}
app=await workspace('hold');
try{
  const old=app.held[0];await app.advance(10000);
  assert.equal(app.d.getElementById('connectionPageToggle').textContent,'Reconnect');
  assert.ok(app.calls.filter(c=>c.action==='cancel_reads').length>=2);
  app.reply(old,app.state);await app.flush();
  assert.equal(app.d.querySelector('#connectionBadge span').textContent,'Disconnected');
  assert.notEqual(app.d.getElementById('gameName').textContent,'Connected game');
  app.setMode('online');await app.toggle();assert.equal(app.d.querySelector('#connectionBadge span').textContent,'Connected');
  console.log('PASS the retry deadline cancels a pending read and ignores its late success before manual reconnection.');
}finally{app.close();}
app=await workspace('online');
try{
  await app.advance(1200);assert.ok(app.reads().length>=2);
  app.setMode('hold');await app.advance(1200);await app.advance(10000);
  assert.equal(app.d.querySelector('#connectionBadge span').textContent,'Disconnected');
  const stopped=app.reads().length;await app.advance(60000);assert.equal(app.reads().length,stopped);
  console.log('PASS a previously healthy connection also stops after a hung 10-second reconnect window.');
}finally{app.close();}
app=await workspace('hold');
try{
  const old=app.held[0];await app.toggle();app.reply(old,app.state);await app.flush();await app.advance(20000);
  assert.equal(app.d.querySelector('#connectionBadge span').textContent,'Disconnected');
  assert.equal(app.reads().length,1);
  console.log('PASS Disconnect during the first attempt prevents a late read from re-enabling the connection.');
}finally{app.close();}
console.log('5 connection lifecycle scenarios passed with a controlled clock.');
