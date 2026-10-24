import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/task-layout.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { taskLayout } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
import { createDemo, stepDemo, applyTemplate } from '../server/orchestration.mjs';

test('compact graph handles unordered fan-out and converging dependencies in both orientations',()=>{
  const task=(id,dependsOn=[])=>({id,dependsOn,status:'queued'});
  const items=[task('review',['api','ui']),task('api',['plan']),task('plan'),task('ui',['plan'])];
  for(const vertical of [false,true]){
    const graph=taskLayout(items,vertical),nodes=new Map(graph.nodes.map(node=>[node.item.id,node]));
    assert.equal(graph.invalid,false);assert.equal(graph.edges.length,4);
    assert.equal(nodes.get('plan').lane,0);assert.equal(nodes.get('api').lane,1);assert.equal(nodes.get('ui').lane,1);assert.equal(nodes.get('review').lane,2);
    assert.equal(new Set(graph.nodes.map(node=>`${node.x},${node.y}`)).size,4);
    for(const node of graph.nodes){assert.ok(node.x+248<=graph.width);assert.ok(node.y+124<=graph.height);}
  }
});
test('compact graph keeps malformed and empty histories inspectable',()=>{
  assert.equal(taskLayout([]).nodes.length,0);
  const graph=taskLayout([{id:'a',dependsOn:['b']},{id:'b',dependsOn:['a']},{id:'c',dependsOn:['missing']}]);
  assert.equal(graph.invalid,true);assert.equal(graph.nodes.length,3);assert.equal(graph.edges.length,2);
  assert.ok(graph.nodes.every(node=>Number.isFinite(node.x) && Number.isFinite(node.y)));
});
test('choosing a template exits the scripted demo without losing its recorded history',()=>{
  const room=createDemo('.');stepDemo(room);const history=room.timeline.length;const backlog=room.workItems.map(t=>t.id);
  applyTemplate(room,'bug','Repair the loading state');
  assert.equal(room.demoStep,undefined);assert.equal(room.templateId,'bug');assert.equal(room.workItems.length,backlog.length+1);assert.deepEqual(room.workItems.slice(0,-1).map(t=>t.id),backlog);
  assert.deepEqual(room.workItems.at(-1).requiredEvidence,['diff','test','log']);assert.ok(room.timeline.length>history);
  assert.throws(()=>stepDemo(room),/guided demo/);
});
