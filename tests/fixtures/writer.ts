import { ContextManager } from '../../src/core/context-manager.js';
import { MemoryService } from '../../src/runtime/memory.js';
const [dir,who,count]=process.argv.slice(2);const manager=ContextManager.open(dir,{logging:{dir:null}});
try {
  const service=new MemoryService(manager,{agent:'concurrent',workspaceId:dir});
  for(let i=0;i<Number(count);i++) {
    const result=await service.capture({sessionId:who,toolCallId:'call-'+i,toolName:'Read',input:'test.txt',result:'Shared verified content\n'.repeat(800)});
    if(!result.archived)throw new Error(result.error);
  }
}finally{manager.close();}
