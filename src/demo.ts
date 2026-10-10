import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isEntryPoint} from './util/entry.js';
import {ContextManager} from './core/context-manager.js';
import {MemoryService} from './runtime/memory.js';
import {sha256} from './storage/blob-store.js';

/** Disposable offline lifecycle proof, not a model, billing or task-quality benchmark. */
export async function runDemo(): Promise<void> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-demo-'));
  const manager=ContextManager.open(dir,{logging:{dir:null}});
  try {
    const service=new MemoryService(manager,{agent:'demo',workspaceId:dir});
    const original=Array.from({length:3000},(_,i)=>i===1500
      ? 'MIDDLE_EVIDENCE_1500: the exact diagnostic is retained here.'
      : `PASS case-${String(i).padStart(4,'0')}: cache, retry and archive evidence verified`).join('\n')+
      '\nSUMMARY: 3000 passed; 0 failed. Exit code: 0.\n';
    const saved=await service.capture({sessionId:'offline-demo',toolCallId:'read-log',toolName:'Read',input:'artifacts/test.log',result:original},'opencode');
    if (!saved.archived || !saved.eventId) throw new Error('Demo archive failed: '+saved.error);
    const first=await service.project(saved.eventId,original,'ingress');
    if (first.replaced) throw new Error('First-use evidence unexpectedly changed');
    // New observations make the old result eligible; none of these call a model.
    for(let i=0;i<12;i++) await service.capture({sessionId:'offline-demo',toolCallId:`later-${i}`,toolName:'Read',input:`unrelated-${i}.txt`,result:'ok'},'opencode');
    const low=await service.transform('offline-demo',[{eventId:saved.eventId,output:original}],{usedTokens:45000,contextWindow:200000,source:'estimated'});
    if (low.projections.some(p=>p.replaced)) throw new Error('Low-pressure history should remain intact');
    const high=await service.transform('offline-demo',[{eventId:saved.eventId,output:original}],{usedTokens:180000,contextWindow:200000,source:'estimated'});
    const projected=high.projections.find(p=>p.eventId===saved.eventId);
    if (!projected?.replaced) throw new Error('Expected pressure-triggered historical projection');
    const stable=await service.transform('offline-demo',[{eventId:saved.eventId,output:projected.text}],{usedTokens:140000,contextWindow:200000,source:'estimated'});
    if (stable.projections[0]?.text!==projected.text) throw new Error('A stable view unexpectedly changed bytes');
    const found=service.search('MIDDLE_EVIDENCE_1500').results;
    const focused=await service.recall(saved.eventId,{find:'MIDDLE_EVIDENCE_1500',limit:1000});
    let rebuilt='',offset=0,pages=0;
    do {
      const page=await service.recall(saved.eventId,{offset,limit:12000});rebuilt+=page.text;pages++;
      if(page.nextOffset===null)break;offset=page.nextOffset!;
    }while(true);
    if (!found.some(r=>r.eventId===saved.eventId) || !focused.text.includes('MIDDLE_EVIDENCE_1500') || sha256(rebuilt)!==sha256(original))
      throw new Error('Search/recall proof failed');
    await service.pin(saved.eventId,true);
    const restored=await service.transform('offline-demo',[{eventId:saved.eventId,output:projected.text}],{usedTokens:10000,contextWindow:200000,source:'estimated'});
    if (restored.projections[0]?.text!==original) throw new Error('Pin did not restore the exact original');
    const filtered=original+'\n[full output: rtk recall 012345abcdef]';
    const external=await service.capture({sessionId:'offline-demo',toolCallId:'rtk-filtered',toolName:'Bash',input:'rtk test sample',result:filtered});
    manager.db.updateToolEvent(external.eventId!,{state:'capsule'});
    const untouched=await service.project(external.eventId!,filtered,'history','offline-demo');
    if (untouched.replaced || untouched.reason!=='upstream-filtered') throw new Error('RTK result was compressed twice');
    process.stdout.write(JSON.stringify({demo:'Capture -> preserve first use -> pressure batch -> stable view -> mid-log search -> exact recall -> pin restoration',
      networkCalls:0,firstUsePreserved:true,belowPressureUnchanged:true,stableProjection:true,middleEvidenceFound:true,
      pinRestoresOriginal:true,rtkDoubleCompressionBlocked:true,originalChars:original.length,projectedChars:projected.text.length,
      visibleCharacterReductionPercent:Number(((1-projected.text.length/original.length)*100).toFixed(2)),
      recallPages:pages,sha256:sha256(original),exactRecallVerified:true,
      note:'Synthetic trace with supplied estimated usage. Character counts are not measured API tokens, cost savings, cache hits or task quality.',
      excerpt:projected.text.slice(0,800)},null,2)+'\n');
  } finally {
    manager.close();
    // Windows may briefly hold a just-written file open (e.g. antivirus); that must not fail a finished proof.
    try {fs.rmSync(dir,{recursive:true,force:true});}
    catch (error) {process.stderr.write(`Demo storage was not removed (${(error as NodeJS.ErrnoException).code ?? 'error'}): ${dir}\n`);}
  }
}
if(isEntryPoint(import.meta.url))runDemo().catch(e=>{console.error(e);process.exitCode=1;});
