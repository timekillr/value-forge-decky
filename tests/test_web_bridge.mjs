import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const root = new URL('../web/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('UI_SOURCE.json', root)));
const {createHash} = await import('node:crypto');
assert.equal(createHash('sha256').update(readFileSync(new URL('app.js', root))).digest('hex'), manifest.source_sha256['app.js']);
const dom = new JSDOM(readFileSync(new URL('index.html', root),'utf8'), {url:'https://192.168.1.20:52881/',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window, d=w.document, calls=[], replies=new Map(), held=[];
let hold=false, fail=false, lastReply=null;
w.AbortController=AbortController;
w.fetch=async (path, options) => {
  calls.push({path,...options});
  if(hold) return new Promise((resolve,reject)=>{
    held.push({resolve,reject,path,options});
    options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})));
  });
  if(fail) return {ok:false,status:401,json:async()=>({ok:false,error:'Pair this browser again.'})};
  return {ok:true,status:200,json:async()=>({ok:true,data:{paired:true,endpoint:w.location.host,network_permission:true}})};
};
w.ForgeReply=(id,response)=>{lastReply=response;replies.get(id)?.(response);replies.delete(id);};
w.eval(readFileSync(new URL('browser-bridge.js',root),'utf8'));
let id=0;
const request=(action,args={})=>new Promise(resolve=>{const key=String(++id);replies.set(key,resolve);w.ForgeNative.request(key,action,JSON.stringify(args));});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
try{
  assert.equal(d.querySelector('[data-action="address"]').hidden,true);
  assert.equal(d.getElementById('endpoint').closest('label').hidden,true);
  assert.equal(d.getElementById('pairButton').textContent,'Pair this browser');
  assert.match(d.querySelector('#pairForm ol').textContent,/Pair a phone or browser/);
  assert.equal(d.querySelectorAll('[data-action="toggleConnection"]').length,1);
  assert.ok(d.getElementById('connectionPageToggle').closest('#tab-connection'));
  let r=await request('settings');assert.equal(r.data.paired,true);
  r=await request('pair',{code:'12'});assert.equal(r.ok,false);assert.equal(calls.length,1);
  r=await request('pair',{code:'123456',endpoint:'evil.invalid'});assert.equal(r.ok,true);
  const pair=calls.at(-1);assert.equal(pair.path,'/web-api/pair');assert.equal(JSON.parse(pair.body).code,'123456');assert.equal(JSON.parse(pair.body).endpoint,undefined);
  await request('state',{refresh:true,timeout_ms:1000});assert.equal(calls.at(-1).path,'/web-api/state?refresh=1');
  await request('processes');assert.equal(calls.at(-1).path,'/web-api/processes');
  const envelope={method:'write_results',args:{value:'18446744073709551615',scan_id:'scan-a'},expected_session_id:'game-a'};
  await request('command',envelope);const first=JSON.parse(calls.at(-1).body);
  await request('command',envelope);const second=JSON.parse(calls.at(-1).body);
  assert.notEqual(first.request_id,second.request_id);assert.equal(first.args.value,envelope.args.value);assert.equal(first.expected_session_id,'game-a');
  for(const call of calls){assert.ok(call.path.startsWith('/web-api/'));assert.equal(call.credentials,'same-origin');assert.equal(call.redirect,'error');assert.equal(call.headers['X-Value-Forge-Web'],'1');assert.equal(call.headers.Authorization,undefined);}
  assert.equal(w.localStorage.length,0);assert.equal(d.cookie,'');
  hold=true;
  const read=request('state');const command=request('command',envelope);await flush();
  const readFetch=held.find(r=>r.path.startsWith('/web-api/state'));
  const commandFetch=held.find(r=>r.path==='/web-api/command');
  await request('cancel_reads');assert.equal((await read).ok,false);assert.equal(readFetch.options.signal.aborted,true);assert.equal(commandFetch.options.signal.aborted,false);
  commandFetch.resolve({ok:true,status:200,json:async()=>({ok:true,data:{completed:true}})});assert.equal((await command).data.completed,true);
  hold=false;fail=true;r=await request('ping');assert.equal(r.status,401);assert.match(r.error,/Pair this browser/);
  fail=false;await request('forget');assert.equal(calls.at(-1).path,'/web-api/unpair');assert.equal(calls.at(-1).method,'POST');
  let lifecycle=[];w.ForgeLifecycle=value=>lifecycle.push(value);
  w.dispatchEvent(new w.Event('pagehide'));w.dispatchEvent(new w.Event('pageshow'));assert.deepEqual(lifecycle,[false,true]);
  console.log('PASS browser pairing, same-origin cookie transport, unique write IDs, cancellation, revocation errors, lifecycle and shared-source integrity.');
}finally{dom.window.close();}
