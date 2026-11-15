'use strict';
// P-52: streams that bypass the server are reported by the page and expire by themselves.
const test = require('node:test');
const assert = require('node:assert');
const { DirectReports } = require('../src/direct-report');

test('reports are counted per provider and replaced by the next report from the same device', () => {
  const d = new DirectReports();
  d.report('phone1', 'james', [{ p: 'a', kind: 'live', id: '10', name: 'CBC' }, { p: 'a', kind: 'movie', id: 'movie:5', name: 'Film' }, { p: 'b', kind: 'live', id: '3' }]);
  d.report('tv', 'james', [{ p: 'a', kind: 'live', id: '11' }]);
  assert.strictEqual(d.count('a'), 3);
  assert.strictEqual(d.count('b'), 1);
  d.report('phone1', 'james', [{ p: 'b', kind: 'live', id: '3' }]);
  assert.strictEqual(d.count('a'), 1);
  assert.strictEqual(d.list().length, 2);
});

test('an empty report takes the device off, and bad entries are ignored', () => {
  const d = new DirectReports();
  d.report('x1', 'u', [{ p: 'a', kind: 'live', id: '1' }]);
  d.report('x1', 'u', []);
  assert.strictEqual(d.count('a'), 0);
  assert.strictEqual(d.report('', 'u', [{ p: 'a', id: '1' }]), false, 'no device name');
  d.report('x2', 'u', [{ kind: 'live' }, null, { p: 'a', id: '' }]);
  assert.strictEqual(d.list().length, 0);
});

test('a report that is not renewed expires', async () => {
  const d = new DirectReports(30);
  d.report('x1', 'u', [{ p: 'a', kind: 'live', id: '1' }]);
  assert.strictEqual(d.count('a'), 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(d.count('a'), 0, 'a closed or crashed app drops off by itself');
});

test('the device name and the list size are limited', () => {
  const d = new DirectReports();
  d.report('a'.repeat(100) + '!!', 'u', Array.from({ length: 40 }, (_, i) => ({ p: 'a', kind: 'live', id: String(i) })));
  assert.ok(d.list().length <= 12);
  assert.ok(d.list()[0].device.length <= 40);
});
