// Independent test client: deliberately does not import CMM's framing/RPC code.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
export class RawPeer {
  readonly child:ChildProcessWithoutNullStreams;
  private id=0;
  private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private readonly exit:Promise<void>;
  private exited=false;
  private closing:Promise<void>|undefined;
  stderr='';
  constructor(command:string,args:string[],cwd?:string) {
    this.child=spawn(command,args,{cwd,stdio:'pipe'});
    this.exit=new Promise(resolve=>this.child.once('close',()=>{this.exited=true;resolve();}));
    this.child.stderr.on('data',b=>this.stderr+=b.toString());
    createInterface({input:this.child.stdout}).on('line',line=>{
      let message:any;try{message=JSON.parse(line);}catch{this.fail(new Error('Non-protocol stdout: '+line));return;}
      const p=this.pending.get(message.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(message.id);p.resolve(message);
    });
    this.child.once('error',e=>this.fail(e));this.child.once('exit',code=>this.fail(new Error('Peer exited '+code)));
    this.child.stdin.on('error',e=>this.fail(e));
  }
  private fail(error:Error) {for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
  request(method:string,params:unknown={}):Promise<any> {
    if(this.exited || this.closing)return Promise.reject(new Error('Peer is closed'));
    const id=++this.id;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Protocol response timeout'));},5000);
      this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  }
  notify(method:string,params?:unknown) {this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');}
  async init(version='2025-06-18') {const result=await this.request('initialize',{protocolVersion:version,capabilities:{},clientInfo:{name:'independent-test',version:'1'}});this.notify('notifications/initialized');return result;}
  close():Promise<void> {
    if(this.closing)return this.closing;
    if(this.exited)return this.closing=Promise.resolve();
    this.fail(new Error('Peer closed'));
    this.child.stdin.end();
    this.closing=new Promise<void>((resolve,reject)=>{
      const graceful=setTimeout(()=>{try{this.child.kill();}catch{/* Try the forced shutdown below. */}},1000);
      const forced=setTimeout(()=>{try{this.child.kill('SIGKILL');}catch{/* Report failure at the deadline. */}},2000);
      const deadline=setTimeout(()=>{clearTimeout(graceful);clearTimeout(forced);reject(new Error('Peer did not exit after shutdown'));},5000);
      void this.exit.then(()=>{clearTimeout(graceful);clearTimeout(forced);clearTimeout(deadline);resolve();});
    });
    return this.closing;
  }
}
