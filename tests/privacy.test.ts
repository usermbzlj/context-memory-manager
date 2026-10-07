import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { errorMessage } from '../src/util/validation.js';
import { completeWithFailover } from '../src/providers/failover.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { makeManager, cleanup } from './util.js';
import type { Logger, ProviderCallRecord } from '../src/types.js';

const secret = 'PRIVATE_CUSTOMER_PAYLOAD_941ab';
const logger: Logger = {log(){},child(){return this;},close(){}};

test('malformed JSON configuration errors do not echo its private source content',async t=>{
  const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));
  fs.writeFileSync(path.join(dir,'config.json'),secret);
  assert.throws(()=>loadConfig(dir),(e:unknown)=>{
    assert.match(errorMessage(e),/configuration was not reset/);
    assert.ok(!errorMessage(e).includes(secret));return true;
  });
  assert.equal(fs.readFileSync(path.join(dir,'config.json'),'utf8'),secret);
});
test('provider JSON validation failure still fails over without storing response excerpts',async()=>{
  const calls:ProviderCallRecord[]=[];
  const first={name:'invalid',complete:async()=>({text:secret,model:'local',tokensIn:1,tokensOut:2})};
  const second={name:'valid',complete:async()=>({text:'{}',model:'local',tokensIn:1,tokensOut:2})};
  const result=await completeWithFailover([first,second],{user:'test'},{purpose:'retention',logger,recordCall:r=>calls.push(r),validate:r=>{JSON.parse(r.text);}});
  assert.equal(result.text,'{}');assert.equal(calls.length,2);assert.equal(calls[0].ok,false);
  assert.ok(!JSON.stringify(calls).includes(secret));assert.match(calls[0].error!,/source content omitted/);
});
test('all HTTP provider adapters omit private error bodies from failure diagnostics',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(secret,{status:429}));
  const base={name:'fixture',model:'fixture',apiKey:'not-a-real-key'};
  const providers=[new OpenAICompatibleProvider({...base,kind:'openai-compatible'}),new AnthropicProvider({...base,kind:'anthropic'}),new GeminiProvider({...base,kind:'gemini'})];
  for(const p of providers)await assert.rejects(()=>p.complete({user:'test'}),(e:unknown)=>{
    assert.match(errorMessage(e),/HTTP 429/);assert.ok(!errorMessage(e).includes(secret));return true;
  });
});
