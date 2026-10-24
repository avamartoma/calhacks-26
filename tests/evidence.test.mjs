import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { workspaceVersion, testReview, isTestCommand, assertReviewVersion, trimEvidence, commandWorkspace } from '../server/evidence.mjs';
import { completionGaps, updateWork } from '../server/orchestration.mjs';
import { checkWorkspace } from '../server/workspace-check.mjs';

test('source edits and untracked files invalidate observed checks; ignored outputs do not', async t => {
  const folder=await mkdtemp(path.join(os.tmpdir(),'fourteenth-evidence-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  execFileSync('git',['init'],{cwd:folder,windowsHide:true,stdio:'ignore'});
  await writeFile(path.join(folder,'.gitignore'),'output.log\n');
  await writeFile(path.join(folder,'app.js'),'export const version=1;');
  const before=await workspaceVersion(folder);
  assert.equal((await commandWorkspace(folder,folder)).cwdVerified,true);
  assert.equal((await commandWorkspace(folder,os.tmpdir())).cwdVerified,false);
  assert.equal((await commandWorkspace(folder,undefined)).cwdVerified,false);
  const pass={id:'test-1',kind:'test',source:'observed-command',command:'npm test',text:'PASS',passed:true,workspaceVersion:before.version,stableWorkspace:true,cwdVerified:true};
  const item={id:'task',title:'Feature',evidence:[pass],requiredEvidence:['test'],acceptanceCriteria:[],dependsOn:[]};
  assert.equal(testReview(item,before).current,true);
  await writeFile(path.join(folder,'output.log'),'generated');
  assert.equal((await workspaceVersion(folder)).version,before.version);
  await writeFile(path.join(folder,'app.js'),'export const version=2;');
  item.reviewState=testReview(item,await workspaceVersion(folder));
  assert.equal(item.reviewState.current,false);
  assert.ok(completionGaps({demo:false,workItems:[item]},item).includes('Checks need rerunning'));
  assert.throws(()=>updateWork({demo:false,workItems:[item]},item,{status:'done'}),/rerunning/);
  await writeFile(path.join(folder,'app.js'),'export const version=1;');
  await writeFile(path.join(folder,'new-source.js'),'export const extra=true;');
  assert.notEqual((await workspaceVersion(folder)).version,before.version);
});

test('latest failure supersedes a pass; changing code during checks and legacy reports fail closed',()=>{
  const snapshot={version:'v1',checkedAt:1};
  const pass={kind:'test',command:'npm test',source:'observed-command',text:'PASS',passed:true,workspaceVersion:'v1',stableWorkspace:true,cwdVerified:true};
  assert.equal(testReview({evidence:[pass,{...pass,passed:false,text:'FAIL'}]},snapshot).current,false);
  assert.equal(testReview({evidence:[{...pass,stableWorkspace:false}]},snapshot).current,false);
  assert.equal(testReview({evidence:[{...pass,workspaceVersion:null}]},snapshot).current,false);
  assert.equal(testReview({evidence:[{...pass,source:'cursor-reported'}]},snapshot).current,false);
  assert.equal(testReview({evidence:[{...pass,cwdVerified:false}]},snapshot).current,false);
  assert.equal(testReview({evidence:[{...pass,workspaceVersion:'old'}, {...pass,command:'node --test narrow.test.mjs'}]},snapshot).current,false);
});

test('reading a test file or viewing a diff cannot become passing test evidence',()=>{
  assert.equal(isTestCommand('Get-Content tests/project.test.mjs'),false);
  assert.equal(isTestCommand('git diff --no-index -- /dev/null tests/project.test.mjs'),false);
  assert.equal(isTestCommand('echo npm test'),false);
  assert.equal(isTestCommand('"C:\\tools\\pwsh.exe" -NoProfile -Command \'npm test\''),true);
  assert.equal(isTestCommand('node --test tests/project.test.mjs'),true);
  assert.equal(isTestCommand("npm test; Write-Output 'finished'"),false);
  assert.equal(isTestCommand('npm test || echo recovered'),false);
  assert.equal(isTestCommand('npm test && npm run build'),false);
});

test('live approval requires the exact ticket revision and source version reviewed',()=>{
  const room={demo:false},item={updatedAt:7,reviewState:{version:'abc'}};
  assert.throws(()=>assertReviewVersion(room,item,{status:'done'}),/Refresh/);
  assert.throws(()=>assertReviewVersion(room,item,{status:'done'},7,null),/Refresh/);
  assert.throws(()=>assertReviewVersion(room,item,{status:'done'},6,'abc'),/ticket changed/);
  assert.throws(()=>assertReviewVersion(room,item,{status:'done'},7,'old'),/files changed/);
  assert.doesNotThrow(()=>assertReviewVersion(room,item,{status:'done'},7,'abc'));
});

test('routine logs cannot erase the latest failed check and falsely clear the gate',()=>{
  const failed={id:'failed',kind:'test',command:'npm test',source:'observed-command',text:'FAIL',passed:false,workspaceVersion:'v1',stableWorkspace:true,cwdVerified:true};
  const item={id:'item',evidence:[failed,...Array.from({length:35},(_,i)=>({kind:'log',text:String(i)})),{...failed,id:'narrow',command:'node --test narrow.test.mjs',passed:true}]};
  trimEvidence({messages:[]},item);
  assert.ok(item.evidence.includes(failed));
  assert.equal(testReview(item,{version:'v1'}).current,false);
});

test('preflight detects the wrong working directory before any model turn',async()=>{
  let calls=0;
  const codex={call:async(method,params)=>{calls++;assert.equal(method,'command/exec');assert.equal(params.sandboxPolicy.type,'readOnly');return {exitCode:0,stdout:'C:\\',stderr:''};}};
  await assert.rejects(checkWorkspace(codex,'C:\\Projects\\example','win32'),/cannot read/);
  assert.equal(calls,1);
  const ready=await checkWorkspace({call:async()=>({exitCode:0,stdout:'C:\\Projects\\example\r\npackage.json'})},'C:\\Projects\\example','win32');
  assert.equal(ready.readable,true);
});
