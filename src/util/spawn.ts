import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Resolve executables using the caller's PATH without a Unix shell. */
export function resolveExecutable(command:string, env:NodeJS.ProcessEnv=process.env, platform:NodeJS.Platform=process.platform):string {
  const paths=command.includes('/') || command.includes('\\') ? [''] : (env.PATH ?? env.Path ?? '').split(platform==='win32' ? ';' : ':');
  const suffixes=platform==='win32' && !path.extname(command) ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for(const directory of paths) for(const suffix of suffixes) {
    const target=directory ? path.join(directory,command+suffix) : command+suffix;
    try {if(fs.statSync(target).isFile()) return target;} catch { /* Try next PATH entry. */ }
  }
  return command;
}

/** Windows batch files need cmd.exe. Reject metacharacters rather than guessing escapes. */
export function windowsBatchLine(command:string,args:readonly string[]):string {
  for(const part of [command,...args]) {
    if(/[\r\n"%!^&|<>]/.test(part)) throw new Error('Unsafe characters in Windows batch arguments. Invoke node.exe with the CLI .js file instead.');
  }
  return '"'+[command,...args].map(v=>'"'+v+'"').join(' ')+'"';
}
export function spawnCommand(command:string,args:string[],options:SpawnOptions={}):ChildProcess {
  const executable=resolveExecutable(command,options.env ?? process.env);
  if(process.platform==='win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    return spawn(process.env.ComSpec ?? 'cmd.exe',['/d','/s','/c',windowsBatchLine(executable,args)],
      {...options,shell:false,windowsVerbatimArguments:true});
  }
  return spawn(executable,args,{...options,shell:false});
}
