import type { ChildProcess } from 'node:child_process';

export interface ChildCompletion {
  code:number|null;
  signal:NodeJS.Signals|null;
  error?:Error;
}
export interface ShutdownDeadlines {graceMs?:number;forceMs?:number;deadlineMs?:number}

/** Observe immediately after spawn, before asynchronous startup can fail. */
export function observeChild(child:ChildProcess) {
  let completion:ChildCompletion|undefined;
  let childError:Error|undefined;
  let stopping:Promise<ChildCompletion>|undefined;
  child.on('error',error=>{childError ??= error;});
  // Ending a pipe may report EPIPE asynchronously. Termination still waits for
  // close, and consumers can retain their own input-error diagnostics.
  child.stdin?.on('error',()=>{});
  const closed=new Promise<ChildCompletion>(resolve=>child.once('close',(code,signal)=>{
    completion={code,signal,...(childError ? {error:childError} : {})};
    resolve(completion);
  }));
  return {
    closed,
    get didClose(){return completion!==undefined;},
    shutdown(options:ShutdownDeadlines={}):Promise<ChildCompletion> {
      if(completion)return Promise.resolve(completion);
      if(stopping)return stopping;
      const grace=options.graceMs ?? 1000,force=options.forceMs ?? 2000,deadline=options.deadlineMs ?? 5000;
      if(![grace,force,deadline].every(value=>Number.isSafeInteger(value) && value>0) || grace>=force || force>=deadline)
        return Promise.reject(new Error('Shutdown deadlines must be positive, increasing integer milliseconds'));
      // EOF gives a cooperative process time to release databases and flush logs.
      // A kill signal is only a request; close is the proof that it finished.
      try{child.stdin?.end();}catch{/* Still attempt termination if the input pipe failed. */}
      stopping=new Promise<ChildCompletion>((resolve,reject)=>{
        const terminate=setTimeout(()=>{try{child.kill('SIGTERM');}catch{/* Escalate below. */}},grace);
        const forced=setTimeout(()=>{try{child.kill('SIGKILL');}catch{/* The deadline will report failure. */}},force);
        const timeout=setTimeout(()=>{
          clearTimeout(terminate);clearTimeout(forced);
          // An OS failure to terminate must not trap the parent in shutdown.
          // Release only this child's parent-side handles. This does not prove
          // child termination, so callers must preserve its temporary files.
          child.unref();
          child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
          reject(new Error('Child close was not observed before the shutdown deadline; keep its temporary files'));
        },deadline);
        const clear=()=>{clearTimeout(terminate);clearTimeout(forced);clearTimeout(timeout);};
        void closed.then(result=>{clear();resolve(result);});
      });
      // A signal handler may start shutdown before its caller begins awaiting it.
      void stopping.catch(()=>{});
      return stopping;
    },
  };
}
