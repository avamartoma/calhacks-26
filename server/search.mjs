import { z } from 'zod';

// Semantic search for the sky: a small sentence-embedding model runs here in the office server,
// so queries and project text never leave this computer and no API key is needed. The model
// (about 23 MB) downloads once into the data folder. Until it is ready, or if it can't load,
// search falls back to matching words.
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const CACHE = 4000;
const BATCH = 32;
const LIMIT = 8;
// Below about .25 this model's similarities are noise. A result also has to come near the best one.
const FLOOR = 0.25;
const NEAR_BEST = 0.55;

export const searchRequest = z.object({
  query: z.string().trim().min(1).max(200),
  items: z.array(z.object({ id: z.string().min(1).max(120), text: z.string().max(400) }).strict()).max(150),
}).strict();

const clip = (text, n = 300) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** What can be found in one office project: the project itself, each agent and each open ticket. */
export function roomDocs(room) {
  const docs = [{ text: clip(`${room.name}. ${room.goal}`, 500), label: '' }];
  for (const agent of room.agents || []) {
    if (agent.status === 'ejected') continue;
    docs.push({ text: clip(`${agent.name}, ${agent.title || agent.role}: ${agent.task}`), label: `Agent ${agent.name}${agent.title ? ` · ${agent.title}` : ''}` });
  }
  for (const item of room.workItems || []) {
    if (item.archived) continue;
    docs.push({ text: clip(`${item.title}. ${item.description} ${(item.acceptanceCriteria || []).join('. ')}`), label: `Ticket · ${clip(item.title, 80)}` });
  }
  return docs;
}

const words = text => text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];

/** The share of the query's words found in the text, so an exact name still ranks first. */
export function keywordScore(query, text) {
  const terms = [...new Set(words(query))];
  if (!terms.length) return 0;
  const haystack = text.toLowerCase();
  return terms.filter(term => haystack.includes(term)).length / terms.length;
}

async function loadModel(cacheDir) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  const extract = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  return async texts => (await extract(texts, { pooling: 'mean', normalize: true })).tolist();
}

export function createSearch({ cacheDir, load = loadModel, log = console.error }) {
  let model = null, state = 'idle', failure = '';
  const vectors = new Map();

  function ready() {
    if (!model) {
      state = 'loading';
      model = load(cacheDir).then(embed => { state = 'ready'; failure = ''; return embed; }, error => {
        state = 'error'; failure = error.message; model = null;
        log(`Semantic search is unavailable, using word matching: ${error.message}`);
        throw error;
      });
    }
    return model;
  }

  async function embed(texts) {
    const embedText = await ready();
    const missing = [...new Set(texts.filter(text => !vectors.has(text)))];
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      (await embedText(batch)).forEach((vector, j) => vectors.set(batch[j], vector));
    }
    // Oldest first: drop what hasn't been asked for in a while.
    for (const text of texts) { const vector = vectors.get(text); vectors.delete(text); vectors.set(text, vector); }
    while (vectors.size > CACHE) vectors.delete(vectors.keys().next().value);
    return texts.map(text => vectors.get(text));
  }

  return {
    /** Starts loading the model in the background, so the first search doesn't wait for it. */
    warm() { ready().catch(() => {}); },
    status() { return { state, error: failure }; },
    /** items: [{ id, docs: [{ text, label }] }]. Returns the best matches, each with what matched. */
    async search(query, items) {
      const docs = items.flatMap(item => item.docs.filter(doc => doc.text).map(doc => ({ ...doc, id: item.id })));
      let scores, mode = 'semantic';
      try {
        const [q, ...rest] = await embed([query, ...docs.map(doc => doc.text)]);
        scores = rest.map((vector, i) => vector.reduce((sum, x, j) => sum + x * q[j], 0) + .35 * keywordScore(query, docs[i].text));
      } catch {
        mode = 'keyword';
        scores = docs.map(doc => keywordScore(query, doc.text));
      }
      const best = new Map();
      docs.forEach((doc, i) => {
        const score = scores[i], kept = best.get(doc.id);
        if (score >= (mode === 'semantic' ? FLOOR : .5) && (!kept || score > kept.score)) best.set(doc.id, { id: doc.id, score, match: doc.label });
      });
      const ranked = [...best.values()].sort((a, b) => b.score - a.score);
      const top = ranked[0]?.score || 0;
      return { mode, results: ranked.filter(r => r.score >= top * NEAR_BEST).slice(0, LIMIT).map(r => ({ ...r, score: Math.round(r.score * 1000) / 1000 })) };
    },
  };
}
