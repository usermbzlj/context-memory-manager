// Independent upstream MCP fixture: never imports the implementation under test.
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const counter=process.argv[2];let count=0;
const send=(id:unknown,result:unknown)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const names=['large','small','structured','image','annotated','error','schema','side_effect','slow'];
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.id===undefined)return;
  if(m.method==='initialize')return void send(m.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'independent-fixture',version:'1'}});
  if(m.method==='tools/list')return void send(m.id,{tools:names.map(name=>({name,description:name,inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:name!=='side_effect'},...(name==='schema'?{outputSchema:{type:'object',properties:{}}}:{})}))});
  if(m.method==='tools/call') {
    count++;if(counter)fs.writeFileSync(counter,String(count));const name=m.params.name;
    const text='repeated tool evidence\n'.repeat(2500)+'\nSUMMARY: 2500 passed, 0 failed\n';
    const base={content:[{type:'text',text}],_meta:{upstream:true}};
    const result=name==='small'?{content:[{type:'text',text:'small'}]}:
      name==='structured'?{...base,structuredContent:{exact:'machine readable'}}:
      name==='image'?{...base,content:[...base.content,{type:'image',data:'eA==',mimeType:'image/png'}]}:
      name==='annotated'?{...base,content:[{type:'text',text,annotations:{audience:['user']}}]}:
      name==='error'?{...base,isError:true}:base;
    if(name==='slow')setTimeout(()=>send(m.id,result),150);else send(m.id,result);
    return;
  }
  send(m.id,{});
});
