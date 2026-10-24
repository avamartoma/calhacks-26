import test from 'node:test';
import assert from 'node:assert/strict';
import { seed, agent, event, workItem, evidenceFrom, canDelegate, handoff, publicItem } from '../server/domain.mjs';

test('worker budget counts active specialists and excludes the manager', () => {
  const room = { paused: false, budget: 2, agents: [agent('M','Manager','Goal',0,{manager:true,status:'working'}),agent('A','Research','A',0,{status:'working'}),agent('B','Review','B',0,{status:'approval'})] };
  assert.throws(() => canDelegate(room), /limit/);
  room.agents[1].status='done'; assert.doesNotThrow(()=>canDelegate(room));
  room.paused=true; assert.throws(()=>canDelegate(room), /paused/);
});
test('replacement handoff preserves observed work without assuming interrupted operations completed', () => {
  const a=agent('A','Research','Find a regression'); a.plan=[{step:'Inspect src/router.ts',status:'inProgress'}];
  event(a,'command','npm test: exit 1'); event(a,'update','The redirect test fails.');
  const output=handoff(a); assert.match(output,/src\/router.ts/);assert.match(output,/exit 1/); assert.match(output,/Do not assume/);
});
test('raw reasoning is excluded while commands, final output and diffs are observable', () => {
  assert.equal(publicItem({type:'reasoning',content:['private'],summary:['summary']}),null);
  assert.deepEqual(publicItem({type:'agentMessage',text:'Done'}),{kind:'update',text:'Done'});
  assert.match(publicItem({type:'commandExecution',command:'npm test',aggregatedOutput:'passed',exitCode:0}).text,/Exit: 0/);
});
test('bounded histories and explicitly marked demo seed', () => {
  const state=seed('C:/example'); assert.equal(state.rooms[0].demo,true);
  assert.equal(state.rooms[0].workItems.length,state.rooms[0].agents.length);
  assert.ok(state.rooms[0].workItems.every(item=>item.acceptanceCriteria.length));
  const a=state.rooms[0].agents[0]; for(let i=0;i<200;i++)event(a,'update',`event ${i}`);
  assert.equal(a.events.length,120); assert.equal(a.events.at(-1).text,'event 199');
});
test('mission work captures bounded observable evidence', () => {
  const item=workItem('Inspect routing','Find the regression',{acceptanceCriteria:['Name the failing route']});
  assert.equal(item.status,'queued'); assert.equal(item.acceptanceCriteria.length,1);
  const a=agent('A','Review','Inspect routing'); event(a,'command','npm test: passed'); event(a,'update','The route is covered.'); a.diff='diff --git a/router.ts';
  const evidence=evidenceFrom(a); assert.equal(evidence.length,3); assert.equal(evidence.at(-1).kind,'diff');
});
