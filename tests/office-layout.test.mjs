import test from 'node:test';
import assert from 'node:assert/strict';
import {officePosition, MAX_TEAMMATES, MAX_DETAILED_OFFICES} from '../src/office-layout.ts';
import {createDemoTeammate, demoTeammateNames, withDemoTeammate} from '../src/demo-teammates.ts';

test('nine-office district has distinct city lots, clear of streets and the river',()=>{
  const lots=[{x:0,z:0},...Array.from({length:MAX_TEAMMATES},(_,i)=>officePosition(i))];
  assert.equal(lots.length,9);
  assert.equal(new Set(lots.map(p=>`${p.x},${p.z}`)).size,9);
  for(const lot of lots){assert.equal(Math.abs(lot.x%50),0);assert.equal(Math.abs(lot.z%50),0);assert.ok(Math.abs(lot.x-200)>32);}
  for(let i=0;i<lots.length;i++)for(let j=i+1;j<lots.length;j++)assert.ok(Math.hypot(lots[i].x-lots[j].x,lots[i].z-lots[j].z)>=50);
  assert.throws(()=>officePosition(MAX_TEAMMATES));
  assert.throws(()=>officePosition(-1));
  assert.equal(MAX_DETAILED_OFFICES,2);
});

test('eight demo offices have unique agents and never mutate a live project or its paired team',()=>{
  const projects=[{id:'one',team:{owner:'Alex',remote:{id:'real-peer'}},agents:[],messages:[],workItems:[]},{id:'two',agents:[],messages:[],workItems:[]}];
  const before=structuredClone(projects);
  const offices=demoTeammateNames.map((_,i)=>createDemoTeammate(i));
  assert.equal(offices.length,MAX_TEAMMATES);
  assert.equal(new Set(offices.flatMap(o=>o.agents.map(a=>a.id))).size,24);
  for(const selected of offices){const view=withDemoTeammate(projects[1],selected,offices);assert.equal(view.team.offices.length,8);assert.equal(view.team.remote.id,selected.id);assert.equal(view.team.simulated,true);assert.equal(view.team.connected,false);assert.equal(view.agents,projects[1].agents);}
  assert.equal(withDemoTeammate(projects[0],offices[0],offices),projects[0], 'paired office and real handoffs remain visible when previews were previously selected');
  assert.deepEqual(projects,before);
  assert.throws(()=>createDemoTeammate(MAX_TEAMMATES));
});
