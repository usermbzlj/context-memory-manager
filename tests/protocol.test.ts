import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
import { jsonLines, runJsonlServer } from '../src/runtime/jsonl.js';
import { RpcClient } from '../src/runtime/rpc-client.js';
import { MemoryService } from '../src/runtime/memory.js';
import { MemoryProxy, plainMcpText } from '../src/mcp/proxy.js';
import { makeManager, cleanup, registerCleanup } from './util.js';
import { RawPeer } from './fixtures/raw-peer.js';
const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
const upstream=fileURLToPath(new URL('./fixtures/upstream.js',import.meta.url));

test('JSONL handles arbitrary UTF-8 chunk boundaries, CRLF and trailing JSON',async()=>{
  const bytes=Buffer.from('{"text":"\u4f60\u597d\ud83d\ude80"}\r\n\n{"last":true}');const chunks=[...bytes].map(b=>Buffer.from([b]));
  const lines=[];for await(const line of jsonLines(Readable.from(chunks)))lines.push(JSON.parse(line));
  assert.deepEqual(lines,[{text:'\u4f60\u597d\ud83d\ude80'},{last:true}]);
});
test('invalid UTF-8 and over-limit JSONL cannot silently alter captured evidence',async()=>{
  await assert.rejects(async()=>{for await(const _ of jsonLines(Readable.from([Buffer.from([0xff,10])])))void _;},/encoded|encoding|UTF/i);
  await assert.rejects(async()=>{for await(const _ of jsonLines(Readable.from(['123456789\n']),5))void _;},/exceeds/);
});
test('JSON-RPC rejects malformed JSON, batch requests and invalid ids, then keeps serving',async()=>{
  const input=Readable.from(['nope\n[]\n{"jsonrpc":"2.0","id":null,"method":"ping"}\n{"jsonrpc":"2.0","id":7,"method":"ping"}\n']);
  const output=new PassThrough();let text='';output.on('data',b=>text+=b.toString());
  await runJsonlServer({input,output,handle:()=>({pong:true})});
  const frames=text.trim().split('\n').map(v=>JSON.parse(v));assert.deepEqual(frames.slice(0,3).map(v=>v.error.code),[-32700,-32600,-32600]);assert.deepEqual(frames[3].result,{pong:true});
});
test('JSON-RPC cancellation signals handlers and does not report an aborted operation as success',async()=>{
  const input=new PassThrough(),output=new PassThrough();let text='';output.on('data',b=>text+=b.toString());
  const running=runJsonlServer({input,output,async handle(_m,_p,signal){await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));return {executed:true};}});
  input.write('{"jsonrpc":"2.0","id":1,"method":"slow"}\n');
  await new Promise(r=>setImmediate(r));input.end('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n');await running;
  assert.equal(JSON.parse(text).error.code,-32800);
});
test('actual CLI stdio MCP is interoperable with an independent client and emits no banner',async t=>{
  const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));const service=new MemoryService(manager,{agent:'claude',workspaceId:dir});
  const saved=await service.capture({sessionId:'s',toolName:'Read',input:'x.txt',result:'interoperable unique evidence'});
  const peer=new RawPeer(process.execPath,[cli,'serve','--storage',dir,'--workspace',dir,'--agent','claude']);registerCleanup(manager,()=>peer.close());
  assert.equal((await peer.request('tools/list')).error.code,-32002);
  assert.equal((await peer.init('2025-06-18')).result.protocolVersion,'2025-06-18');
  const listing=await peer.request('tools/list');assert.equal(listing.result.tools.length,5);assert.ok(listing.result.tools.every((v:any)=>v.inputSchema.additionalProperties===false));
  const found=await peer.request('tools/call',{name:'context_search',arguments:{query:'interoperable'}});assert.equal(JSON.parse(found.result.content[0].text).results[0].eventId,saved.eventId);
  const recalled=await peer.request('tools/call',{name:'context_recall',arguments:{eventId:saved.eventId}});assert.equal(JSON.parse(recalled.result.content[0].text).text,'interoperable unique evidence');
  const bad=await peer.request('tools/call',{name:'context_search',arguments:{workspace:dir}});assert.equal(bad.result.isError,true);
  assert.equal((await peer.request('resources/list')).error.code,-32601);assert.deepEqual((await peer.request('ping')).result,{});
});
test('MCP negotiates a supported version instead of pretending to implement unknown future versions',async t=>{
  const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));
  const peer=new RawPeer(process.execPath,[cli,'serve','--storage',dir,'--workspace',dir]);registerCleanup(manager,()=>peer.close());
  assert.equal((await peer.init('2099-12-31')).result.protocolVersion,'2025-11-25');
});
test('dual-era MCP serves stateless 2026-07-28 requests without a handshake and keeps legacy gating',async t=>{
  const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));const service=new MemoryService(manager,{agent:'kimi',workspaceId:dir});
  const saved=await service.capture({sessionId:'s',toolName:'Read',input:'x.txt',result:'stateless unique evidence'});
  const peer=new RawPeer(process.execPath,[cli,'serve','--storage',dir,'--workspace',dir,'--agent','kimi']);registerCleanup(manager,()=>peer.close());
  const meta=(version='2026-07-28')=>({_meta:{'io.modelcontextprotocol/protocolVersion':version,'io.modelcontextprotocol/clientCapabilities':{}}});
  const discovered=(await peer.request('server/discover',meta())).result;
  assert.equal(discovered.supportedVersions[0],'2026-07-28');assert.ok(discovered.supportedVersions.includes('2025-11-25'));
  assert.equal(discovered.resultType,'complete');assert.deepEqual(discovered.capabilities,{tools:{}});assert.equal(discovered.cacheScope,'private');
  const listing=(await peer.request('tools/list',meta())).result;assert.equal(listing.tools.length,5);assert.equal(typeof listing.ttlMs,'number');
  assert.equal(listing._meta['io.modelcontextprotocol/serverInfo'].name,'context-memory-manager');
  const found=(await peer.request('tools/call',{...meta(),name:'context_search',arguments:{query:'stateless'}})).result;
  assert.equal(found.resultType,'complete');assert.equal(JSON.parse(found.content[0].text).results[0].eventId,saved.eventId);
  const unsupported=(await peer.request('tools/list',meta('2099-01-01'))).error;
  assert.equal(unsupported.code,-32022);assert.equal(unsupported.data.requested,'2099-01-01');assert.ok(unsupported.data.supported.includes('2026-07-28'));
  assert.equal((await peer.request('tools/list')).error.code,-32002,'legacy traffic still requires initialize');
  assert.equal((await peer.init('2025-11-25')).result.protocolVersion,'2025-11-25');
  assert.equal((await peer.request('tools/list')).result.tools.length,5);
});
test('MCP gateway executes each tool once, shrinks eligible text and preserves every structured/error shape',async t=>{
  const {manager,dir}=await makeManager({integration:{ingressCompression:true}});t.after(()=>cleanup(dir,manager));const countFile=path.join(dir,'count');
  const client=new RpcClient(process.execPath,[upstream,countFile]);registerCleanup(manager,()=>client.close());await client.initialize();
  const service=new MemoryService(manager,{agent:'proxy',workspaceId:dir}),proxy=new MemoryProxy(service,client);await proxy.list();
  const signal=new AbortController().signal;
  const large=await proxy.call('large',{},signal) as any;assert.match(large.content[0].text,/^\[CMM archive /);assert.equal(large._meta.upstream,true);
  for(const name of ['structured','image','annotated','error','schema']) {
    const value=await proxy.call(name,{},signal) as any;assert.ok(value.content[0].text.startsWith('repeated tool evidence'));if(name==='error')assert.equal(value.isError,true);
  }
  const small=await proxy.call('small',{},signal) as any;assert.equal(small.content[0].text,'small');
  assert.equal(fs.readFileSync(countFile,'utf8'),'7');assert.equal(service.search('',50).results.length,7);
  assert.equal((await service.verify()).failed,0);
});
test('MCP gateway keeps original output if archiving fails; it never repeats the upstream call',async t=>{
  const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));const count=path.join(dir,'count');
  const client=new RpcClient(process.execPath,[upstream,count]);registerCleanup(manager,()=>client.close());await client.initialize();
  const proxy=new MemoryProxy(new MemoryService(manager,{agent:'proxy',workspaceId:dir}),client);manager.archive.failNextArchive();
  const value=await proxy.call('side_effect',{},new AbortController().signal) as any;
  assert.ok(value.content[0].text.startsWith('repeated tool evidence'));assert.equal(fs.readFileSync(count,'utf8'),'1');
});
test('upstream request timeout does not retry side effects',async t=>{
  const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));const count=path.join(dir,'count');
  const client=new RpcClient(process.execPath,[upstream,count]);registerCleanup(manager,()=>client.close());await client.initialize();
  await assert.rejects(()=>client.request('tools/call',{name:'slow',arguments:{}},{timeoutMs:25}),/not retried/);
  await new Promise(r=>setTimeout(r,200));assert.equal(fs.readFileSync(count,'utf8'),'1');
});
test('the actual CLI proxy exposes memory plus upstream tools',async t=>{
  const {manager,dir}=await makeManager({integration:{ingressCompression:true}});t.after(()=>cleanup(dir,manager));
  const peer=new RawPeer(process.execPath,[cli,'proxy','--storage',dir,'--workspace',dir,'--agent','codex','--',process.execPath,upstream]);registerCleanup(manager,()=>peer.close());
  await peer.init();assert.equal((await peer.request('tools/list')).result.tools.length,14);
  const call=await peer.request('tools/call',{name:'large',arguments:{}});assert.match(call.result.content[0].text,/^\[CMM archive /);
});

test('fixture cleanup closes an actual SQLite child even when another resource cleanup fails',async t=>{
  const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));
  const peer=new RawPeer(process.execPath,[cli,'serve','--storage',dir,'--workspace',dir]);
  registerCleanup(manager,()=>peer.close());
  registerCleanup(manager,()=>{throw new Error('synthetic cleanup failure');});
  await peer.init();
  await assert.rejects(()=>cleanup(dir,manager),/synthetic cleanup failure/);
  assert.ok(peer.child.exitCode!==null || peer.child.signalCode!==null);
  assert.equal(fs.existsSync(dir),false,'child resources are closed before removing storage on Windows');
});

test('RPC client and independent peer await actual termination when a child ignores stdin EOF',async t=>{
  const code='process.stdin.resume();setInterval(()=>{},1000);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{ready:true}})+"\\n");';
  const client=new RpcClient(process.execPath,['-e',code],{stderr:'ignore'});
  t.after(()=>client.close());
  assert.equal((await client.request<{ready:boolean}>('ping')).ready,true);
  const closing=client.close();assert.equal(client.close(),closing);await closing;
  assert.ok(client.process.exitCode!==null || client.process.signalCode!==null);
  assert.equal(client.process.stdout?.destroyed,true);
  const peer=new RawPeer(process.execPath,['-e',code]);t.after(()=>peer.close());
  assert.equal((await peer.request('ping')).result.ready,true);
  await peer.close();
  assert.ok(peer.child.exitCode!==null || peer.child.signalCode!==null);
  assert.equal(peer.child.stdout.destroyed,true);
});
test('multimedia and annotated text are not projection candidates',()=>{
  assert.equal(plainMcpText({content:[{type:'image',data:'AAAA'}]}),undefined);
  assert.equal(plainMcpText({content:[{type:'text',text:'x',annotations:{}}]}),undefined);
  assert.equal(plainMcpText({content:[{type:'text',text:'x'}],structuredContent:{}}),undefined);
  assert.equal(plainMcpText({content:[{type:'text',text:'a'},{type:'text',text:'b'}]}),'a\nb');
});
