import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { JSDOM } from 'jsdom';
import { FILTER_STORAGE_KEY } from '../src/projectFilters.js';

let appCode;
before(async () => {
  // Bundle the actual entry point in memory, including React and JSX.
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: 'src/main.jsx', output: { format: 'iife' } },
    },
  });
  appCode = result.output.find(item => item.type === 'chunk').code;
});

async function eventually(check) {
  const deadline = Date.now() + 2000;
  while (true) {
    try { check(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

async function mount(t, prepare = () => {}) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  prepare(dom.window);
  dom.window.eval(appCode);
  const document = dom.window.document;
  await eventually(() => assert.ok(document.querySelector('[role="status"]')));
  return { window: dom.window, document };
}

function enterQuery(window, value) {
  const input = window.document.querySelector('input');
  // Use the native setter to simulate an edit without React's value tracker.
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function selectStatus(window, value) {
  const select = window.document.querySelector('select');
  select.value = value;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function expectResults(document, names, count) {
  assert.deepEqual([...document.querySelectorAll('li h2')].map(el => el.textContent), names);
  assert.equal(document.querySelector('[role="status"]').textContent, count);
}

test('UI searches, combines status, announces zero results, and clears with focus and status retained', async t => {
  const { window, document } = await mount(t);
  assert.equal(document.querySelector('input').labels[0].textContent, 'Search projects');
  assert.equal(document.querySelector('select').labels[0].textContent, 'Status');
  assert.equal(document.querySelector('[role="status"]').getAttribute('aria-live'), 'polite');
  enterQuery(window, 'PORTAL');
  await eventually(() => expectResults(document, ['Customer portal'], '1 project found'));
  enterQuery(window, 'OPERATIONS');
  await eventually(() => expectResults(document, ['Release console'], '1 project found'));
  selectStatus(window, 'Active');
  await eventually(() => {
    expectResults(document, [], '0 projects found');
    assert.equal(document.querySelector('.empty-state').textContent, 'No projects match your filters.');
  });
  const clear = document.querySelector('button');
  assert.equal(clear.textContent, 'Clear search');
  clear.focus();
  clear.click();
  await eventually(() => {
    expectResults(document, ['Customer portal', 'Search service', 'Design guide'], '3 projects found');
    assert.equal(document.querySelector('input').value, '');
    assert.equal(document.querySelector('select').value, 'Active');
    assert.equal(document.activeElement, document.querySelector('input'));
    assert.equal(document.querySelector('.empty-state'), null);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(FILTER_STORAGE_KEY)), { query: '', status: 'Active' });
  });
});

test('UI persists edits and restores both preferences on a fresh mount', async t => {
  const first = await mount(t);
  enterQuery(first.window, 'DOCUMENTATION');
  selectStatus(first.window, 'Active');
  await eventually(() => assert.deepEqual(JSON.parse(first.window.localStorage.getItem(FILTER_STORAGE_KEY)), {
    query: 'DOCUMENTATION', status: 'Active',
  }));
  const saved = first.window.localStorage.getItem(FILTER_STORAGE_KEY);
  const { document } = await mount(t, window => window.localStorage.setItem(FILTER_STORAGE_KEY, saved));
  assert.equal(document.querySelector('input').value, 'DOCUMENTATION');
  assert.equal(document.querySelector('select').value, 'Active');
  expectResults(document, ['Design guide'], '1 project found');
});

test('UI recovers from malformed storage and saves the next user edit', async t => {
  const { window, document } = await mount(t, window => window.localStorage.setItem(FILTER_STORAGE_KEY, '{'));
  assert.equal(document.querySelector('input').value, '');
  assert.equal(document.querySelector('select').value, 'All');
  assert.equal(document.querySelectorAll('li').length, 4);
  enterQuery(window, 'API');
  await eventually(() => {
    expectResults(document, ['Search service'], '1 project found');
    assert.deepEqual(JSON.parse(window.localStorage.getItem(FILTER_STORAGE_KEY)), { query: 'API', status: 'All' });
  });
});

test('failed initial read does not overwrite saved preferences before a user edit', async t => {
  let saved = JSON.stringify({ query: 'guide', status: 'Active' });
  let writes = 0;
  const { window, document } = await mount(t, window => {
    Object.defineProperty(window, 'localStorage', { value: {
      getItem() { throw new Error('temporarily unavailable'); },
      setItem(key, value) { assert.equal(key, FILTER_STORAGE_KEY); writes++; saved = value; },
    } });
  });
  // Allow the initial passive effect to run before checking for unwanted writes.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(document.querySelectorAll('li').length, 4);
  assert.equal(writes, 0);
  assert.deepEqual(JSON.parse(saved), { query: 'guide', status: 'Active' });
  enterQuery(window, 'portal');
  await eventually(() => assert.deepEqual(JSON.parse(saved), { query: 'portal', status: 'All' }));
});
