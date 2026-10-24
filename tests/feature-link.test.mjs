import test from 'node:test';
import assert from 'node:assert/strict';
import { featureUrl } from '../server/feature-link.mjs';
import { updateWork, initOffice, officeFrame, applyTemplate } from '../server/orchestration.mjs';
import { agent } from '../server/domain.mjs';
import { createCursorDesk } from '../server/cursor.mjs';

test('feature destinations accept local and hosted routes and reject executable or credential URLs',()=>{
  for(const url of ['http://localhost:5173/search?q=office#results','http://127.0.0.1:3000/','https://example.com/feature',''])assert.equal(featureUrl.parse(url),url);
  for(const url of ['javascript:alert(1)','file:///C:/project/index.html','data:text/html,test','//example.com','https://name:secret@example.com'])assert.equal(featureUrl.safeParse(url).success,false);
});
test('agent feature links survive snapshots and failed completion stays atomic',()=>{
  const manager=agent('Morgan','Manager','Build',0,{manager:true});
  const room=initOffice({agents:[manager],workItems:[],messages:[],skills:[],budget:3});
  applyTemplate(room,'feature','Add search');const item=room.workItems[0];
  const previewUrl='http://localhost:5173/search';
  updateWork(room,item,{status:'review',previewUrl});
  assert.equal(officeFrame(room).workItems[0].previewUrl,previewUrl);
  assert.throws(()=>updateWork(room,item,{status:'done',previewUrl:'https://example.com/new'}),/Missing/);
  assert.equal(item.previewUrl,previewUrl);assert.equal(item.status,'review');
  assert.throws(()=>updateWork(room,item,{status:'review',previewUrl:'javascript:alert(1)'}));
  updateWork(room,item,{status:'review',previewUrl:''});assert.equal(item.previewUrl,'');
});
test('Cursor can report the exact feature URL without automatically verifying a ticket',()=>{
  const room=initOffice({id:'room',path:process.cwd(),agents:[],workItems:[],messages:[],skills:[]});
  const desk=createCursorDesk({state:{rooms:[room]},changed(){}});
  const run=desk.start(room,{task:'Build search',acceptanceCriteria:['Works']});
  desk.finish(room,run.agentId,{summary:'Ready to inspect',outcome:'review',previewUrl:'http://localhost:5173/search'});
  assert.equal(room.workItems[0].previewUrl,'http://localhost:5173/search');assert.equal(room.workItems[0].status,'review');
});
