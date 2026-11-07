import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportProposal, exportAnalysis } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/network.json', import.meta.url));
for (const scenario of [
  { title: 'Minimum connection cost with replacement checks', costs: ['4','9','20','2','3'], status: 'complete', total: '9' },
  { title: 'Free links still form a usable tree', costs: ['0','0','0','0','0'], status: 'complete', total: '0' },
  { title: 'One unavailable candidate leaves another connection', costs: ['4','Unavailable','20','2','3'], status: 'complete', total: '9' },
  { title: 'Unavailable links isolate one site', costs: ['4','9','Unavailable','2','Unavailable'], status: 'complete' },
  { title: 'Unknown cost withholds the whole analysis', costs: ['Unknown','9','20','2','3'], status: 'incomplete' },
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-tree-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (const cost of scenario.costs) {
      result = await step(options); api.answer(result.answers.find(answer => answer.status === 'pending').questionId, cost); result = await step(options);
    }
    assert.equal(result.status, scenario.status);
    if (scenario.total !== undefined) { assert.equal(result.analysis.tree.totalCost, scenario.total); assert.deepEqual(await exportProposal(directory, input), result.proposal); }
    else { assert.equal(result.proposal, null); await assert.rejects(exportProposal(directory, input)); }
    if (result.status === 'complete') await exportAnalysis(directory, input); else await assert.rejects(exportAnalysis(directory, input));
    console.log(JSON.stringify({ scenario: scenario.title, status: result.status, analysis: result.analysis }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline demo used the pinned SDK with local mock transport. No live phone delivery, installation or deployment.');
