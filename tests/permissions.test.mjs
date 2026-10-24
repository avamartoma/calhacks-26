import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionsFor, permissionMode } from '../server/permissions.mjs';

test('office permissions remain consistent across models, roles and replacements',()=>{
  for(const model of ['gpt-6-sol','gpt-6-astra','Account default']) {
    assert.deepEqual(permissionsFor({permissionMode:'read-only'},{manager:true,model}),{sandbox:'read-only',approvalPolicy:'never',canWrite:false});
    assert.deepEqual(permissionsFor({permissionMode:'project-write'},{manager:true,model}),{sandbox:'workspace-write',approvalPolicy:'on-request',canWrite:true});
    assert.equal(permissionsFor({permissionMode:'project-write'},{manager:false,model}).sandbox,'read-only');
  }
  assert.equal(permissionsFor({},{manager:true}).sandbox,'workspace-write','legacy offices retain existing access');
  assert.equal(permissionMode.safeParse('danger-full-access').success,false);
});
