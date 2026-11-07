import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const MAX_COST = 999999;
export const POLICY = Object.freeze({ algorithm: 'kruskal-undirected-v1', order: 'cost-then-ascii-edge-id-v1', unavailable: 'exclude-v1', disconnected: 'no-proposal-v1' });
export const POLICY_HASH = hash(POLICY);
const safeId = value => word(value) && value.length <= 16 && !['constructor', 'prototype', '__proto__'].includes(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_COST && !Object.is(value, -0);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const linkPrompt = (input, link) => {
  const from = input.sites.find(site => site.id === link.from), to = input.sites.find(site => site.id === link.to);
  return `${input.title}\nContext: ${input.context}\nPlan ${input.planId}\nLink ${link.id}: ${link.label}\n${from.id} (${from.label}) <-> ${to.id} (${to.label})\nCost unit: ${input.costUnit}\nCost means: ${input.costDefinition}\nReply 0..999999, Unavailable, or Unknown. Digits only; no leading zeros. Planning only.`;
};

export function validateInput(input) {
  if (!keys(input, ['planId', 'title', 'context', 'costUnit', 'costDefinition', 'sites', 'links']) || !word(input.planId)
    || !line(input.title, 40) || !line(input.context, 60) || !line(input.costUnit, 20) || !line(input.costDefinition, 60)
    || !Array.isArray(input.sites) || input.sites.length < 2 || input.sites.length > 6
    || !Array.isArray(input.links) || input.links.length < 1 || input.links.length > 8) throw new Error('Provide a plan ID, title, context, common cost unit/definition, two to six sites and one to eight links.');
  const siteIds = new Set();
  for (const site of input.sites) {
    if (!keys(site, ['id', 'label']) || !safeId(site.id) || siteIds.has(site.id) || !line(site.label, 24)) throw new Error('Sites require unique safe IDs and labels up to 24 characters.');
    siteIds.add(site.id);
  }
  const linkIds = new Set(), pairs = new Set(), links = [];
  for (const link of input.links) {
    if (!keys(link, ['id', 'from', 'to', 'label']) || !safeId(link.id) || linkIds.has(link.id) || !line(link.label, 30)
      || !siteIds.has(link.from) || !siteIds.has(link.to) || link.from === link.to) throw new Error('Links require unique safe IDs, labels up to 30 and distinct declared endpoints.');
    const [from, to] = [link.from, link.to].sort(compare), pair = `${from}:${to}`;
    if (pairs.has(pair)) throw new Error('Duplicate undirected endpoint pair.');
    pairs.add(pair); linkIds.add(link.id); links.push({ ...link, from, to });
  }
  const canonicalInput = { ...structuredClone(input), sites: structuredClone(input.sites).sort((a, b) => compare(a.id, b.id)), links: links.sort((a, b) => compare(a.id, b.id)) };
  if (canonicalInput.links.some(link => linkPrompt(canonicalInput, link).length > 500)) throw new Error('Full link prompt exceeds 500 characters. Shorten its descriptions.');
  return canonicalInput;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact connection planner UUID and label.');
  return structuredClone(config);
}
export const tasksFor = input => validateInput(input).links;
export function parseCost(text) {
  if (text === 'Unknown') return { kind: 'unknown', cost: null };
  if (text === 'Unavailable') return { kind: 'unavailable', cost: null };
  if (typeof text !== 'string' || !/^(?:0|[1-9][0-9]{0,5})(?![\s\S])/.test(text)) throw new Error('Reply 0 to 999999 without spaces or leading zeros, exactly Unavailable, or exactly Unknown.');
  return { kind: 'quantity', cost: Number(text) };
}
export function requestFor(rawInput, config, taskId, attemptId) {
  const input = validateInput(rawInput), link = input.links.find(row => row.id === taskId); validateConfig(config);
  if (!link || !isId(attemptId)) throw new Error('Invalid link or attempt.');
  const key = `tree-${attemptId}`;
  return { prompt: linkPrompt(input, link), context: `To ${config.participant.id}`, text_input: { placeholder: '0..999999, Unavailable, Unknown', max_length: 60 },
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), link_hash: hash(link), policy_hash: POLICY_HASH, task_id: taskId, attempt_id: attemptId }, idempotencyKey: key };
}

function knownCosts(input, costs) {
  if (!keys(costs, input.links.map(link => link.id)) || Object.values(costs).some(cost => cost !== null && !integer(cost))) throw new Error('Every link needs an integer cost or null for declared Unavailable.');
  return costs;
}
function components(input, edges) {
  const remaining = new Set(input.sites.map(site => site.id)), groups = [];
  while (remaining.size) {
    const queue = [remaining.values().next().value]; remaining.delete(queue[0]);
    for (let i = 0; i < queue.length; i++) for (const edge of edges) {
      const neighbor = edge.from === queue[i] ? edge.to : edge.to === queue[i] ? edge.from : null;
      if (remaining.has(neighbor)) { remaining.delete(neighbor); queue.push(neighbor); }
    }
    groups.push(queue.sort(compare));
  }
  return groups.sort((a, b) => compare(a[0], b[0]));
}
function treePath(edges, from, to) {
  const queue = [{ site: from, path: [] }], seen = new Set([from]);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]; if (current.site === to) return current.path;
    for (const edge of edges) {
      const next = edge.from === current.site ? edge.to : edge.to === current.site ? edge.from : null;
      if (next !== null && !seen.has(next)) { seen.add(next); queue.push({ site: next, path: [...current.path, edge] }); }
    }
  }
  throw new Error('Selected edges do not connect a required path.');
}
function replacementChecks(available, selected) {
  const chosen = new Set(selected.map(link => link.id));
  return available.filter(link => !chosen.has(link.id)).map(link => {
    const path = treePath(selected, link.from, link.to), maximum = Math.max(...path.map(edge => edge.cost));
    if (link.cost < maximum) throw new Error('A cheaper cycle replacement disproves minimum cost.');
    return { edgeId: link.id, cost: link.cost, pathEdgeIds: path.map(edge => edge.id), maximumPathCost: maximum,
      maximumPathEdgeIds: path.filter(edge => edge.cost === maximum).map(edge => edge.id).sort(compare),
      replacementDelta: (BigInt(link.cost) - BigInt(maximum)).toString() };
  });
}

/** Verify spanning connectivity and each possible single-edge cycle replacement. */
export function verifyTree(rawInput, rawCosts, tree) {
  const input = validateInput(rawInput), costs = knownCosts(input, rawCosts);
  if (!keys(tree, ['edgeIds', 'links', 'totalCost', 'replacementChecks']) || !Array.isArray(tree.edgeIds) || tree.edgeIds.length !== input.sites.length - 1
    || new Set(tree.edgeIds).size !== tree.edgeIds.length) throw new Error('Tree must contain exactly sites minus one distinct links.');
  const available = input.links.filter(link => costs[link.id] !== null).map(link => ({ ...link, cost: costs[link.id] }));
  const selected = tree.edgeIds.map(id => available.find(link => link.id === id));
  if (selected.some(link => !link) || components(input, selected).length !== 1 || hash(tree.links) !== hash(selected)) throw new Error('Tree edges must be available, correctly priced and connect every site.');
  const totalCost = selected.reduce((sum, link) => sum + BigInt(link.cost), 0n).toString();
  if (tree.totalCost !== totalCost || hash(tree.replacementChecks) !== hash(replacementChecks(available, selected))) throw new Error('Tree total or replacement certificate differs from the supplied costs.');
  return tree;
}

/** Kruskal accepts only edges joining separate components; all sums are exact. */
export function minimumTree(rawInput, rawCosts) {
  const input = validateInput(rawInput), costs = knownCosts(input, rawCosts);
  const available = input.links.filter(link => costs[link.id] !== null).map(link => ({ ...link, cost: costs[link.id] }));
  const groups = components(input, available), unavailableEdgeIds = input.links.filter(link => costs[link.id] === null).map(link => link.id);
  if (groups.length !== 1) return { connectable: false, reason: 'disconnected', components: groups, unavailableEdgeIds, tree: null };
  const parents = new Map(input.sites.map(site => [site.id, site.id])), selected = [];
  const root = id => { while (parents.get(id) !== id) id = parents.get(id); return id; };
  const ordered = [...available].sort((a, b) => compare(a.cost, b.cost) || compare(a.id, b.id));
  for (const link of ordered) {
    const a = root(link.from), b = root(link.to);
    if (a !== b) { parents.set(b, a); selected.push(link); }
  }
  const tree = { edgeIds: selected.map(link => link.id), links: selected,
    totalCost: selected.reduce((sum, link) => sum + BigInt(link.cost), 0n).toString(), replacementChecks: replacementChecks(available, selected) };
  verifyTree(input, costs, tree);
  return { connectable: true, reason: null, components: groups, unavailableEdgeIds, tree };
}
export function connectionTree(rawInput, answers) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(answers) || answers.length !== tasks.length || answers.some((row, index) => !keys(row, ['linkId', 'text']) || row.linkId !== tasks[index].id || row.text !== null && typeof row.text !== 'string')) throw new Error('Provide one ordered answer or missing outcome for every link.');
  const outcomes = answers.map(row => row.text === null ? { kind: 'missing', cost: null } : parseCost(row.text));
  if (outcomes.some(row => !['quantity', 'unavailable'].includes(row.kind))) return { status: 'incomplete', analysis: null };
  return { status: 'complete', analysis: minimumTree(input, Object.fromEntries(tasks.map((link, index) => [link.id, outcomes[index].cost]))) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed connection network. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved cost request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = tasksFor(input).map(link => {
    const attempt = state.attempts.find(row => row.taskId === link.id), answer = attempt?.observation?.answer;
    return { linkId: link.id, linkHash: hash(link), status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      text: answer?.text ?? null, kind: answer?.kind ?? null, cost: answer?.cost ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = connectionTree(input, answers.map(({ linkId, text }) => ({ linkId, text })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  const evidence = { planId: input.planId, source: input, sourceHash: hash(input), configHash: hash(state.config), policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, answers, analysis: calculation.analysis, linksInstalled: false };
  return { ...evidence, status, proposal: calculation.status === 'complete' && calculation.analysis.connectable ? { ...evidence, status: 'complete' } : null };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'cost', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseCost(answer.text)) !== hash({ kind: answer.kind, cost: answer.cost })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved cost evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain cost evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or connection planner.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parseCost(answer.text), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
