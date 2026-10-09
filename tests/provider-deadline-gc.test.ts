import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const providers=new URL('../src/providers/index.js',import.meta.url).href;

// Garbage collection during a stalled body used to drop the weakly held timeout signal, so the
// request waited for undici's 300 s body timeout instead of its own deadline.
for(const kind of ['openai-compatible','anthropic','gemini','systemone']){
  test(`${kind}: the request deadline survives garbage collection while a body stalls`,()=>{
    const script=`
      import http from 'node:http';
      import {buildProviders} from ${JSON.stringify(providers)};
      const server=http.createServer((_q,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"answers":');});
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      const [p]=buildProviders([{name:'p',kind:${JSON.stringify(kind)},model:'m',apiKey:'k',baseUrl:'http://127.0.0.1:'+server.address().port}]);
      const churn=setInterval(()=>{globalThis.gc();},10);
      const started=Date.now();let message='resolved';
      try{await p.complete({user:'{"state":{},"questions":{}}',timeoutMs:300});}catch(e){message=e.message;}
      clearInterval(churn);server.closeAllConnections();server.close();
      process.stdout.write(JSON.stringify({ms:Date.now()-started,message}));`;
    const run=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',script],{encoding:'utf8',timeout:20000});
    assert.equal(run.status,0,run.stderr||String(run.error));
    const result=JSON.parse(run.stdout) as {ms:number;message:string};
    assert.match(result.message,/timed out or was cancelled/);
    assert.ok(result.ms<5000,`deadline took ${result.ms} ms`);
  });
}
