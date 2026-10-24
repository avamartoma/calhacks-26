import { Codex } from '../server/codex.mjs';
const codex = new Codex();
try {
  await codex.connect();
  const account = await codex.call('account/read', { refreshToken: false });
  const models = await codex.call('model/list', { limit: 100 });
  console.log(JSON.stringify({ initialized: true, signedIn: !!account.account, models: models.data.filter(m=>!m.hidden).map(m=>({id:m.model,name:m.displayName})), isolatedAuth: true }, null, 2));
} finally { codex.close(); }
