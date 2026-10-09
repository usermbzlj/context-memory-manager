import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { fork, spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeChild } from '../util/child-lifecycle.js';
import { loadConfig } from '../config.js';
import { enableRuntime, readRuntime, createRuntimeObserver } from '../observability/runtime.js';

type Data = Record<string, unknown>;
type PublicError = { code: string; status?: number; message: string };
const methods = new Set(['scopes','overview','list','detail','chain','capsule','content','pin','settings',
  'saveSettings','testProvider','diagnostics','runtime','startJob','jobs','cancelJob']);
const assetsRoot = fileURLToPath(new URL('./assets/', import.meta.url));
const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status: number, code: string, message: string): never => { throw { status, code, message }; };
async function body(req: IncomingMessage): Promise<Data> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415,'JSON_REQUIRED','仅接受 JSON。');
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) fail(413,'BODY_LIMIT','请求超过大小限制。');
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))); }
  catch { fail(400,'INVALID_JSON','JSON 无效。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'INVALID_REQUEST','请求格式无效。');
  return value as Data;
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export async function startDashboard(options: {storage: string; port?: number; agent?: string; workspace?: string; open?: boolean}) {
  if (!fs.existsSync(path.join(options.storage,'config.json')) || !fs.existsSync(path.join(options.storage,'cmm.db')))
    throw new Error('Choose an existing CMM storage containing config.json and cmm.db.');
  if (!fs.existsSync(path.join(assetsRoot,'index.html'))) throw new Error('Dashboard assets missing; run npm run build.');
  loadConfig(options.storage);
  if (!Number.isInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) throw new Error('Invalid port');
  const lease = enableRuntime(options.storage);
  const child = fork(fileURLToPath(new URL('./worker.js',import.meta.url)), [options.storage], {
    stdio:['pipe','ignore','ignore','ipc'], windowsHide:true,
  });
  const lifecycle = observeChild(child);
  let workerReady = false, stopped = false, nextId = 0;
  const pending = new Map<number,{resolve:(value:unknown)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
  const jobs = new Map<string,Data>();
  let readyResolve:()=>void, readyReject:(error:unknown)=>void;
  const ready = new Promise<void>((resolve,reject) => {readyResolve=resolve;readyReject=reject;});
  const readyTimer = setTimeout(() => readyReject(new Error('Dashboard worker startup timed out')),10000);
  child.on('message',(raw: unknown) => {
    const message = raw as {type:string;id:number|string;result?:unknown;error?:PublicError;status?:string;progress?:unknown};
    if (message.type === 'ready') { workerReady=true;clearTimeout(readyTimer);readyResolve(); }
    else if (message.type === 'fatal') {clearTimeout(readyTimer);readyReject(new Error('Cannot open dashboard storage'));}
    else if (message.type === 'response') {
      const call = pending.get(Number(message.id)); if (!call) return;
      clearTimeout(call.timer);pending.delete(Number(message.id));
      message.error ? call.reject(message.error) : call.resolve(message.result);
    } else if (message.type === 'jobProgress' || message.type === 'jobEnd') {
      const job = jobs.get(String(message.id)); if (!job) return;
      if (message.type === 'jobProgress') job.progress=message.progress;
      else {job.status=message.status;job.result=message.result;job.error=message.error;job.finishedAt=Date.now();}
    }
  });
  child.on('error',() => readyReject(new Error('Dashboard worker could not start')));
  child.on('close',() => {
    workerReady=false;clearTimeout(readyTimer);readyReject(new Error('Dashboard worker stopped'));
    for (const call of pending.values()) {clearTimeout(call.timer);call.reject({status:503,code:'WORKER_STOPPED',message:'管理进程已停止。'});}
    pending.clear();
    for (const job of jobs.values()) if (job.status === 'running') {job.status='interrupted';job.finishedAt=Date.now();}
  });
  const request = (method:string, params:Data={}):Promise<unknown> => {
    if (!workerReady) return Promise.reject({status:503,code:'WORKER_UNAVAILABLE',message:'管理进程不可用。'});
    if (pending.size >= 16) return Promise.reject({status:429,code:'QUEUE_LIMIT',message:'操作队列已满。'});
    const id=++nextId;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{pending.delete(id);reject({status:504,code:'TIMEOUT',message:'操作超时，未自动重试。'});},30000);
      pending.set(id,{resolve,reject,timer});
      child.send({id,method,params}, error=>{if(error){clearTimeout(timer);pending.delete(id);reject({status:503,code:'WORKER_UNAVAILABLE',message:'管理进程不可用。'});}});
    });
  };
  const bootstrap=token(); let bootstrapUsed=false;
  const sessions=new Map<string,{csrf:string;expires:number}>();
  const health=new Map<string,Data>();
  let cpuSample=process.cpuUsage(),cpuSampleAt=performance.now();
  const resources=()=>{
    const now=performance.now(),current=process.cpuUsage(),elapsed=now-cpuSampleAt;
    const cpuPercent=elapsed>0?((current.user-cpuSample.user)+(current.system-cpuSample.system))/(elapsed*1000)*100:undefined;
    cpuSample=current;cpuSampleAt=now;
    return {pid:process.pid,status:'ready',uptimeSeconds:process.uptime(),memoryBytes:process.memoryUsage().rss,
      cpuPercent:cpuPercent===undefined?undefined:Math.round(cpuPercent*100)/100,cpuBasis:'100% = one logical CPU',source:'process-sample',observedAt:Date.now()};
  };
  const modelHealth=async()=>{
    const current=loadConfig(options.storage);
    const providers=Object.values(current.providers).flat();
    const local = [...new Map(providers.filter(p=>p.baseUrl && ['localhost','127.0.0.1','[::1]'].includes(new URL(p.baseUrl).hostname)).map(p=>[p.name,p])).values()];
    await Promise.all(local.map(async p=>{
      const previous=health.get(p.name);
      if(previous && Date.now()-Number(previous.observedAt)<10000)return;
      const report:Data={name:p.name,model:p.model,observedAt:Date.now(),status:'unknown',source:'local-health-endpoint'};
      try {const res=await fetch(new URL('/health',p.baseUrl),{signal:AbortSignal.timeout(1000),redirect:'error'});
        report.status=res.ok?'ok':res.status===404?'unsupported':'unreachable';await res.body?.cancel();
      }catch{report.status='unreachable';}
      health.set(p.name,report);
    }));
    return {localModels:local.map(p=>health.get(p.name)),remoteModels:providers.filter(p=>p.baseUrl && !local.some(l=>l.name===p.name)).map(p=>({name:p.name,model:p.model,status:'configured',source:'saved-config'}))};
  };
  let origin='';
  const server=http.createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
    res.setHeader('content-security-policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
    try {
      if(req.headers.host!==new URL(origin).host)fail(403,'HOST_REJECTED','请求地址不允许。');
      if(req.headers.origin && req.headers.origin!==origin)fail(403,'ORIGIN_REJECTED','来源不允许。');
      if(req.headers['sec-fetch-site']==='cross-site')fail(403,'CROSS_SITE','跨站请求不允许。');
      const url=new URL(req.url ?? '/',origin);
      if(url.pathname.startsWith('/api/')){
        if(req.method==='POST' && req.headers.origin!==origin)fail(403,'ORIGIN_REQUIRED','需要同源请求。');
        if(url.pathname==='/api/session' && req.method==='POST'){
          const data=await body(req);
          if(bootstrapUsed || typeof data.token!=='string' || !equal(data.token,bootstrap))fail(401,'AUTH_REQUIRED','启动凭据无效，请重新打开启动链接。');
          bootstrapUsed=true;
          const id=token(),csrf=token();sessions.set(id,{csrf,expires:Date.now()+8*60*60*1000});
          res.setHeader('set-cookie',`cmm_session=${id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800`);
          json(res,200,{csrfToken:csrf,preference:{agent:options.agent,workspaceId:options.workspace}});return;
        }
        const cookie=/(?:^|;\s*)cmm_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
        const session=cookie ? sessions.get(cookie) : undefined;
        if(!session || session.expires<Date.now())fail(401,'AUTH_REQUIRED','请使用启动链接连接看板。');
        const authenticated=session!;
        if(url.pathname==='/api/session' && req.method==='GET'){json(res,200,{csrfToken:authenticated.csrf,preference:{agent:options.agent,workspaceId:options.workspace}});return;}
        if(req.method==='POST' && (typeof req.headers['x-cmm-csrf']!=='string' || !equal(req.headers['x-cmm-csrf'],authenticated.csrf)))fail(403,'CSRF_REQUIRED','请求凭据无效。');
        if(url.pathname==='/api/download' && req.method==='GET'){
          const result=await request('download',Object.fromEntries(url.searchParams)) as {text:string;filename:string;sha256:string};
          res.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-disposition':`attachment; filename="${result.filename.replace(/[^A-Za-z0-9._-]/g,'_')}"`,'x-content-sha256':result.sha256});res.end(Buffer.from(result.text,'utf8'));return;
        }
        if(url.pathname!=='/api/command' || req.method!=='POST')fail(404,'NOT_FOUND','接口不存在。');
        const data=await body(req);
        if(typeof data.method!=='string' || !methods.has(data.method) || !data.params || typeof data.params!=='object' || Array.isArray(data.params))fail(400,'INVALID_COMMAND','操作格式无效。');
        const method=data.method as string;
        const params=data.params as Data;
        let result:unknown;
        if(data.method==='runtime'){
          const scope=await request('scope',{scopeId:params.scopeId}) as {agent:string;workspaceId:string};
          const snapshot=readRuntime(options.storage,scope);
          result={...snapshot,scope,...await modelHealth(),server:resources(),
            worker:{pid:child.pid,status:workerReady?(pending.size || [...jobs.values()].some(j=>j.status==='running')?'busy':'ready'):'stopped'},jobs:[...jobs.values()].filter(j=>j.scopeId===params.scopeId),revision:Date.now()};
        }else if(data.method==='startJob'){
          await request('scope',{scopeId:params.scopeId});
          if([...jobs.values()].some(j=>j.status==='running'))fail(409,'JOB_RUNNING','已有维护任务正在执行。');
          if(jobs.size>=50){const completed=[...jobs.entries()].find(([,j])=>j.status!=='running');if(completed)jobs.delete(completed[0]);}
          const id=randomUUID(), job:Data={id,scopeId:params.scopeId,reindex:params.reindex===true,status:'running',startedAt:Date.now(),progress:{checked:0,total:0}};
          jobs.set(id,job);
          try{await request('startJob',{...params,id});}catch(e){jobs.delete(id);throw e;}
          result=job;
        }else if(data.method==='jobs'){
          await request('scope',{scopeId:params.scopeId});result={jobs:[...jobs.values()].filter(j=>j.scopeId===params.scopeId)};
        }else if(data.method==='cancelJob'){
          const job=jobs.get(String(params.id));
          if(!job || job.scopeId!==params.scopeId)fail(404,'NOT_FOUND','任务不存在。');
          await request('scope',{scopeId:params.scopeId});result=await request('cancelJob',params);
        }else result=await request(method,params);
        json(res,200,{result});return;
      }
      if(req.method!=='GET' && req.method!=='HEAD')fail(405,'METHOD_NOT_ALLOWED','方法不允许。');
      let relative=decodeURIComponent(url.pathname);
      if(relative==='/' || relative==='/index.html')relative='/index.html';
      if(relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..'))fail(404,'NOT_FOUND','资源不存在。');
      const target=path.resolve(assetsRoot,'.'+relative);
      if(!target.startsWith(assetsRoot) || !fs.existsSync(target) || !fs.statSync(target).isFile())fail(404,'NOT_FOUND','资源不存在。');
      const real=fs.realpathSync(target);if(!real.startsWith(fs.realpathSync(assetsRoot)+path.sep))fail(404,'NOT_FOUND','资源不存在。');
      const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2'};
      res.writeHead(200,{'content-type':mime[path.extname(target)] ?? 'application/octet-stream'});
      if(req.method==='HEAD')res.end();else fs.createReadStream(target).pipe(res);
    }catch(error){
      const e=error as PublicError;
      const exposed = typeof e.code==='string' && /^[A-Z_]+$/.test(e.code) && Number.isInteger(e.status) && Number(e.status)>=400 && Number(e.status)<=599;
      if(!res.headersSent)json(res,exposed?e.status!:400,{error:{code:exposed?e.code:'OPERATION_FAILED',message:exposed?e.message:'操作未完成。'}});
      else res.end();
    }
  });
  server.requestTimeout=10000;server.headersTimeout=5000;server.maxHeadersCount=40;
  let observer:ReturnType<typeof createRuntimeObserver>|undefined;
  const close=async()=>{
    if(stopped)return;stopped=true;
    lease.stop();observer?.close();
    const closed=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeIdleConnections();
    await lifecycle.shutdown();await closed;
  };
  try {
    await ready;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port ?? 0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
    origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    observer=createRuntimeObserver(options.storage,{component:'dashboard',persistent:true});
  }catch(error){clearTimeout(readyTimer);lease.stop();await lifecycle.shutdown();throw error;}
  const launchUrl=origin+'/#token='+bootstrap;
  if(options.open){
    if(process.platform==='win32'){const opener=spawn('rundll32.exe',['url.dll,FileProtocolHandler',launchUrl],{windowsHide:true,stdio:'ignore'});opener.on('error',()=>{});opener.unref();}
    else {const opener=spawn(process.platform==='darwin'?'open':'xdg-open',[launchUrl],{stdio:'ignore'});opener.on('error',()=>{});opener.unref();}
  }
  return {url:origin,launchUrl,close,server,workerPid:child.pid};
}
