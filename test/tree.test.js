import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportProposal, exportAnalysis } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseCost, connectionTree, minimumTree, verifyTree, MAX_COST, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/network.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-tree-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later costs; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), '5'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a count', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), '5'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.proposal, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across costs', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), '5'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).proposal, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), '5');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), '5'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), '5'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), '5');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), '5'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).proposal, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});



const costsFor = (input, values) => Object.fromEntries(tasksFor(input).map((link, i) => [link.id, values[i]]));
const answersFor = (input, values) => tasksFor(input).map((link, i) => ({ linkId: link.id, text: values[i] === null ? null : String(values[i]) }));
function network(siteIds, pairs) {
  return { planId:'fixture',title:'Practice connections',context:'One simultaneous practice installation.',costUnit:'labor points',costDefinition:'Total effort to install this undirected link',
    sites:siteIds.map(id=>({id,label:id})),links:pairs.map(([from,to])=>({id:from+to,from,to,label:`${from} and ${to}`})) };
}
const triangle = () => network(['a','b','c'],[['a','b'],['a','c'],['b','c']]);

// Exhaustive n−1-edge subsets with reachability, independent of Kruskal/union-find.
function exhaustiveOracle(input, costs) {
  const links=input.links.filter(link=>costs[link.id]!==null);let best=null;
  for(let mask=0;mask<2**links.length;mask++) {
    const selected=links.filter((_,i)=>mask&(1<<i));if(selected.length!==input.sites.length-1)continue;
    const reached=new Set([input.sites[0].id]);let changed=true;
    while(changed) {changed=false;for(const edge of selected)for(const [a,b] of [[edge.from,edge.to],[edge.to,edge.from]])if(reached.has(a)&&!reached.has(b)){reached.add(b);changed=true;}}
    if(reached.size!==input.sites.length)continue;
    const total=selected.reduce((sum,link)=>sum+costs[link.id],0);if(best===null||total<best)best=total;
  }
  return best;
}

test('strict normalized cost grammar distinguishes free, Unavailable and Unknown', () => {
  assert.deepEqual(parseCost('0'),{kind:'quantity',cost:0});assert.deepEqual(parseCost('999999'),{kind:'quantity',cost:999999});
  assert.deepEqual(parseCost('Unavailable'),{kind:'unavailable',cost:null});assert.deepEqual(parseCost('Unknown'),{kind:'unknown',cost:null});
  for(const text of ['', '-0','+1','01','1.0','1e2','1000000','unavailable','unknown',' Unknown','Unavailable\n','1 ','1\n','1\r\n','1\u2028','1\u2029','１２','١','\ud800',null,1])assert.throws(()=>parseCost(text));
});

test('ordinary costs produce a minimum tree and exact replacement paths', () => {
  const costs=costsFor(example,[4,9,20,2,3]),result=minimumTree(example,costs);
  assert.equal(result.connectable,true);assert.deepEqual(result.tree.edgeIds,['bc','cd','ab']);assert.equal(result.tree.totalCost,'9');
  assert.deepEqual(result.tree.replacementChecks,[
    {edgeId:'ac',cost:9,pathEdgeIds:['ab','bc'],maximumPathCost:4,maximumPathEdgeIds:['ab'],replacementDelta:'5'},
    {edgeId:'ad',cost:20,pathEdgeIds:['ab','bc','cd'],maximumPathCost:4,maximumPathEdgeIds:['ab'],replacementDelta:'16'},
  ]);
  assert.equal(verifyTree(example,costs,result.tree),result.tree);assert.doesNotThrow(()=>JSON.stringify(result));
});

test('10657 cost/availability assignments match independent spanning-subset enumeration', () => {
  const cases=[{input:network(['a','b','c','d'],[['a','b'],['a','c'],['a','d'],['b','c'],['b','d'],['c','d']]),values:[null,0,1,2]},
    {input:network(['a','b','c','d','e','f'],[['a','b'],['a','c'],['a','f'],['b','c'],['b','e'],['c','d'],['d','e'],['e','f']]),values:[null,0,3]}];
  let checked=0;
  for(const {input,values} of cases)for(let code=0;code<values.length**input.links.length;code++) {
    let digits=code;const costs=Object.fromEntries(input.links.map(link=>{const value=values[digits%values.length];digits=Math.floor(digits/values.length);return [link.id,value];}));
    const expected=exhaustiveOracle(input,costs),actual=minimumTree(input,costs);assert.equal(actual.connectable,expected!==null);
    if(expected===null){assert.equal(actual.tree,null);assert.equal(actual.reason,'disconnected');}
    else{assert.equal(actual.tree.totalCost,String(expected),`assignment ${code}`);assert.equal(actual.tree.edgeIds.length,input.sites.length-1);verifyTree(input,costs,actual.tree);}
    checked++;
  }
  assert.equal(checked,10657);
});

test('cheapest n−1 links can form a cycle; Kruskal instead reaches the isolated site', () => {
  const input=network(['a','b','c','d'],[['a','b'],['a','c'],['a','d'],['b','c'],['c','d']]);
  const result=minimumTree(input,{ab:1,ac:1,ad:9,bc:1,cd:5});
  assert.deepEqual(result.tree.edgeIds,['ab','ac','cd']);assert.equal(result.tree.totalCost,'7');
  assert.ok(!result.tree.edgeIds.includes('bc'));assert.equal(result.tree.replacementChecks.find(row=>row.edgeId==='bc').replacementDelta,'0');
});

test('input order is not a cost heuristic; a later cheap connection replaces an expensive earlier one', () => {
  const input=network(['a','b','c','d'],[['a','b'],['a','c'],['b','c'],['c','d']]);
  const result=minimumTree(input,{ab:10,ac:1,bc:1,cd:1});assert.equal(result.tree.totalCost,'3');assert.deepEqual(result.tree.edgeIds,['ac','bc','cd']);
});

test('equal and all-zero costs follow edge IDs and retain real free links', async t => {
  const input=triangle();
  for(const value of [0,5]){const result=minimumTree(input,{ab:value,ac:value,bc:value});assert.deepEqual(result.tree.edgeIds,['ab','ac']);assert.equal(result.tree.totalCost,String(2*value));assert.equal(result.tree.replacementChecks[0].replacementDelta,'0');}
  const s=await setup(t,input),result=await decide(s,['0','0','0']);assert.equal(result.status,'complete');assert.equal(result.analysis.tree.totalCost,'0');assert.equal((await exportProposal(s.directory,input)).analysis.tree.totalCost,'0');
});

test('Unavailable excludes an edge but can leave a connected usable tree', async t => {
  const input=triangle(),s=await setup(t,input),result=await decide(s,['Unavailable','0','4']);
  assert.equal(result.status,'complete');assert.equal(result.analysis.connectable,true);assert.deepEqual(result.analysis.unavailableEdgeIds,['ab']);assert.deepEqual(result.analysis.tree.edgeIds,['ac','bc']);assert.equal(result.analysis.tree.totalCost,'4');
  assert.equal((await exportProposal(s.directory,input)).answers[0].kind,'unavailable');
});

test('disconnected known graph exports sorted components and no tree proposal', async t => {
  const input=network(['f','b','a','d','c','e'],[['a','b'],['b','c'],['d','e'],['e','f']]);
  const s=await setup(t,input),result=await decide(s,['4','Unavailable','1','Unavailable']);
  assert.equal(result.status,'complete');assert.equal(result.analysis.connectable,false);assert.equal(result.analysis.reason,'disconnected');assert.equal(result.analysis.tree,null);assert.equal(result.proposal,null);
  assert.deepEqual(result.analysis.components,[['a','b'],['c'],['d','e'],['f']]);
  await assert.rejects(exportProposal(s.directory,input));const audit=await exportAnalysis(s.directory,input),{observedStatus,...expected}=result;assert.deepEqual(audit,expected);
  assert.equal((await stat(join(s.directory,'analysis.json'))).mode&0o777,0o600);await assert.rejects(readFile(join(s.directory,'proposal.json')),{code:'ENOENT'});
});

test('all unavailable links and isolated declared sites remain explicit', () => {
  const input=triangle(),result=minimumTree(input,{ab:null,ac:null,bc:null});assert.deepEqual(result.components,[['a'],['b'],['c']]);assert.equal(result.tree,null);
  const isolated=network(['a','b','c'],[['a','b']]);assert.deepEqual(minimumTree(isolated,{ab:0}).components,[['a','b'],['c']]);
});

test('maximum integer costs have an exact five-link sum', () => {
  const input=network(['a','b','c','d','e','f'],[['a','b'],['b','c'],['c','d'],['d','e'],['e','f']]),result=minimumTree(input,costsFor(input,Array(5).fill(MAX_COST)));
  assert.equal(result.tree.totalCost,'4999995');assert.deepEqual(result.tree.replacementChecks,[]);
  assert.equal(minimumTree(network(['a','b'],[['a','b']]),{ab:MAX_COST}).tree.totalCost,'999999');
});

test('canonical site/link order and reversed undirected endpoints preserve identity', () => {
  const input=structuredClone(example),costs=costsFor(input,[4,9,20,2,3]),changed=structuredClone(input);changed.sites.reverse();changed.links.reverse();
  for(const link of changed.links)[link.from,link.to]=[link.to,link.from];
  assert.deepEqual(validateInput(changed),validateInput(input));assert.equal(hash(validateInput(changed)),hash(validateInput(input)));assert.deepEqual(minimumTree(changed,costs),minimumTree(input,costs));
  changed.sites[0].label='Other desk';assert.notEqual(hash(validateInput(changed)),hash(validateInput(input)));
});

test('Unknown or missing on any candidate withholds the complete analysis even when other links connect', async t => {
  const input=triangle();
  for(const values of [[0,0,null],[0,0,'Unknown']])assert.deepEqual(connectionTree(input,answersFor(input,values)),{status:'incomplete',analysis:null});
  for(const values of [['0','0','Unknown'],['0','0','01']]){
    const s=await setup(t,input),result=await decide(s,values);assert.equal(result.status,'incomplete');assert.equal(result.proposal,null);assert.equal(result.analysis,null);
    await assert.rejects(exportProposal(s.directory,input));await assert.rejects(exportAnalysis(s.directory,input));
  }
});

test('schema rejects duplicate undirected pairs, self-links, unknown endpoints and ambiguous costs', () => {
  const mutations=[v=>v.sites=[],v=>v.sites.push(v.sites[0]),v=>v.links=[],v=>v.links.push(v.links[0]),v=>v.links[0].from=v.links[0].to,
    v=>v.links[0].to='missing',v=>v.links.push({...v.links[0],id:'reverse',from:v.links[0].to,to:v.links[0].from}),v=>v.sites[0].id='constructor',
    v=>v.links[0].cost=3,v=>v.extra=true,v=>v.costUnit='',v=>v.costDefinition='',v=>v.title+='\n',v=>v.context='\ud800',v=>v.sites[0]={'id,label':'a'}];
  for(const change of mutations){const value=triangle();change(value);assert.throws(()=>validateInput(value));}
  for(const costs of [{ab:1,ac:2},{ab:1,ac:2,bc:3,extra:0},{ab:1,ac:2,bc:-0},{ab:1,ac:2,bc:1.5},{ab:1,ac:2,bc:1000000},{'ab,ac,bc':1},{ab:1,ac:2,bc:'Unknown'}])assert.throws(()=>minimumTree(triangle(),costs));
  assert.throws(()=>validateConfig({participant:{...CONFIG.participant,extra:true}}));assert.throws(()=>connectionTree(triangle(),[{linkId:'ac',text:'1'},{linkId:'ab',text:'1'},{linkId:'bc',text:'1'}]));
});

test('full endpoint labels, IDs and common cost meaning fit current SDK limits', () => {
  const input=network(['a'.repeat(16),'b'.repeat(16)],[['a'.repeat(16),'b'.repeat(16)]]);input.links[0].id='e'.repeat(16);
  input.planId='p'.repeat(40);input.title='🙂'.repeat(20);input.context='🙂'.repeat(30);input.costUnit='🙂'.repeat(10);input.costDefinition='🙂'.repeat(30);
  for(const site of input.sites)site.label='🙂'.repeat(12);input.links[0].label='🙂'.repeat(15);
  const request=requestFor(input,CONFIG,input.links[0].id,id(1));assert.ok(request.prompt.length<=500);assert.ok(request.context.length<=40);assert.equal(Object.keys(request.data).length,5);assert.ok(Buffer.byteLength(JSON.stringify(request.data))<=8192);
  for(const text of [input.context,input.planId,input.costUnit,input.costDefinition,input.links[0].id,input.links[0].label,...input.sites.flatMap(site=>[site.id,site.label])])assert.ok(request.prompt.includes(text));
  assert.equal(request.data.policy_hash,POLICY_HASH);assert.equal(request.target_user_id,CONFIG.participant.id);
});

test('tree verifier rejects infeasible, nonminimal, wrongly priced and forged certificates', () => {
  const input=triangle(),costs={ab:1,ac:2,bc:9},valid=minimumTree(input,costs).tree;
  for(const mutate of [v=>v.edgeIds=['ab','ab'],v=>v.edgeIds=['ab'],v=>v.links[0].cost++,v=>v.totalCost='4',v=>v.replacementChecks[0].pathEdgeIds.reverse(),v=>v.replacementChecks[0].maximumPathCost=1,v=>v.replacementChecks[0].replacementDelta='8',v=>v.extra=true]){const changed=structuredClone(valid);mutate(changed);assert.throws(()=>verifyTree(input,costs,changed));}
  const nonminimal={edgeIds:['ab','bc'],links:validateInput(input).links.filter(link=>['ab','bc'].includes(link.id)).map(link=>({...link,cost:costs[link.id]})),totalCost:'10',replacementChecks:[]};assert.throws(()=>verifyTree(input,costs,nonminimal),/cheaper/);
  assert.throws(()=>verifyTree(input,{ab:null,ac:2,bc:9},valid));
});

test('immutable topology, labels, cost definition and policy reject evidence reuse before API access', async t => {
  const s=await setup(t);await s.run();const before=s.api.calls.length;
  for(const mutate of [v=>v.planId='different',v=>v.context='New window',v=>v.costUnit='other unit',v=>v.costDefinition='Other effort',v=>v.links[0].label='Different cable',v=>v.sites[0].label='New desk',v=>v.links[0].to='d']){
    const input=structuredClone(s.options.input);mutate(input);await assert.rejects(s.run({input}));
  }
  const state=await s.saved();state.attempts[0].request.data.policy_hash='0'.repeat(64);await atomicJson(s.directory,'state.json',state);await assert.rejects(s.run());assert.equal(s.api.calls.length,before);
});

test('private proposal export preserves full attributed quotes and exact bytes', async t => {
  const s=await setup(t),result=await decide(s,['4','9','20','2','3']),exported=await exportProposal(s.directory,s.options.input);assert.deepEqual(exported,result.proposal);assert.equal(exported.linksInstalled,false);assert.equal(exported.analysis.tree.totalCost,'9');
  for(const answer of exported.answers){assert.equal(answer.responderId,CONFIG.participant.id);assert.equal(answer.askerId,ASKER);assert.ok(answer.questionId&&answer.attemptId&&answer.answeredAt);assert.equal(answer.cost,Number(answer.text));}
  const path=join(s.directory,'proposal.json'),bytes=await readFile(path,'utf8');assert.equal((await stat(path)).mode&0o777,0o600);await exportProposal(s.directory,s.options.input);assert.equal(await readFile(path,'utf8'),bytes);
});

test('strict boundaries reject line terminators and malformed Unicode before API access', async t => {
  const s=await setup(t);
  for(const ending of ['\n','\r','\r\n','\u2028','\u2029']){assert.equal(ROOM.test(ROOM_CODE+ending),false);assert.equal(isId(CONFIG.participant.id+ending),false);assert.equal(TOKEN.test('fixture'+ending),false);await assert.rejects(s.run({token:'fixture'+ending}));await assert.rejects(s.run({room:ROOM_CODE+ending}));const input=structuredClone(example);input.links[0].id+=ending;await assert.rejects(s.run({input}));await assert.rejects(atomicText(s.directory,'report.json'+ending,'{}'));}
  for(const ending of ['\u0000','\u0085','\u200e','\u2028','\ud800']){const input=structuredClone(example);input.sites[0].label+=ending;assert.throws(()=>validateInput(input));}assert.equal(s.api.calls.length,0);
});

test('saved costs and Unavailable kinds cannot be forged; regressing clocks preserve evidence', async t => {
  const s=await setup(t);await s.run();s.api.answer(id(1),'5');await s.run();const state=await s.saved();
  for(const mutate of [a=>a.cost++,a=>a.text='6',a=>a.kind='unavailable']){const changed=structuredClone(state);mutate(changed.attempts[0].observation.answer);assert.throws(()=>validateState(changed,s.options.input));}
  await s.run();const saved=await s.saved();s.clock.value='2026-01-01T08:59:59.000Z';await assert.rejects(s.run());assert.deepEqual(await s.saved(),saved);
});
