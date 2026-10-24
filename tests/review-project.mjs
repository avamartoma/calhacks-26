import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export async function reviewProject(temp) {
  const project=path.join(temp,'project');
  await mkdir(project);
  execFileSync('git',['init'],{cwd:project,windowsHide:true,stdio:'ignore'});
  await writeFile(path.join(project,'source.js'),'export const example = true;\n');
  return project;
}

export async function reviewGuards(req, endpoint) {
  const {data}=await req(endpoint+'/review');
  return {expectedUpdatedAt:data.updatedAt,expectedVersion:data.review.version};
}
