const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Engine = require('../public/hit-play-engine.js');

const baseStates = [[], [1], [2], [3], [1, 2], [1, 3], [2, 3], [1, 2, 3]];
const hitBases = [1, 2, 3];
const causes = ['none', 'passed', 'throwing', 'throw', 'rundown'];
let scenarioCount = 0;

function makeFlow(bases, hitBase, startOuts = 0, automaticAward = false) {
  return Engine.create({
    hitBase,
    key: 'center',
    label: hitBase === 1 ? 'センター前ヒット' : hitBase === 2 ? '右中間二塁打' : '左中間三塁打',
    outs: startOuts,
    batterPlayerIndex: 9,
    runners: bases.map(base => ({ originBase: base, playerIndex: base - 1 })),
    automaticAward
  });
}

function chooseNormal(flow, variant) {
  while (flow.phase === 'normal') {
    const runner = Engine.nextNormalRunner(flow);
    const options = Engine.normalOptions(flow, runner.id);
    const safe = options.filter(option => option.kind === 'safe');
    assert.ok(options.length, `normal options missing for ${runner.id}`);
    const selected = safe.length ? (variant % 2 === 0 ? safe[0] : safe[safe.length - 1]) : options[0];
    Engine.applyNormal(flow, runner.id, selected.code);
  }
}

function chooseExtra(flow, variant) {
  while (flow.phase === 'additional-runner') {
    const runner = Engine.nextExtraRunner(flow);
    const options = Engine.extraOptions(flow, runner.id);
    let selected = options.find(option => option.kind === 'stay');
    if (variant === 1) selected = options.filter(option => option.kind === 'safe').at(-1) || selected;
    if (variant === 2) selected = options.find(option => option.kind === 'safe') || selected;
    if (variant === 3) selected = options.find(option => option.kind === 'tagOut') || selected;
    if (variant === 4 && runner.origin !== 'batter') selected = options.filter(option => option.kind === 'safe').at(-1) || selected;
    Engine.applyExtra(flow, runner.id, selected.code);
  }
}

function complete(flow, cause, variant) {
  chooseNormal(flow, variant);
  if (flow.phase === 'complete') return;
  assert.equal(flow.phase, 'additional-select');
  Engine.selectAdditional(flow, cause);
  if (flow.phase === 'additional-runner') chooseExtra(flow, variant);
  if (flow.phase === 'rundown-runner') {
    const targets = Engine.rundownTargets(flow);
    assert.ok(targets.length, 'rundown needs a reachable target');
    const target = targets[variant % targets.length];
    Engine.selectRundownRunner(flow, target.id);
    const intervals = Engine.rundownIntervals(flow);
    assert.equal(intervals.length, 1);
    Engine.selectRundownInterval(flow, intervals[0].code);
    const results = Engine.rundownResultOptions(flow);
    Engine.applyRundownResult(flow, results[variant % results.length].code);
  }
  assert.equal(flow.phase, 'complete');
}

function validate(flow, expectedHitBase) {
  const result = Engine.result(flow);
  const activeBases = result.active.map(runner => runner.currentBase);
  assert.equal(new Set(activeBases).size, activeBases.length, 'two runners cannot occupy one base');
  assert.ok(activeBases.every(base => [1, 2, 3].includes(base)));
  assert.equal(result.runs, result.detail.runners.filter(runner => runner.status === 'scored').length);
  assert.equal(result.outs, result.detail.runners.filter(runner => runner.isOut).length);
  assert.ok(flow.startOuts + result.outs <= 3, 'outs exceeded three');
  assert.equal(result.detail.hitBase, expectedHitBase, 'hit classification changed after advancement');
  assert.equal(result.detail.hitType, expectedHitBase === 1 ? 'single' : expectedHitBase === 2 ? 'double' : 'triple');
  assert.ok(result.rbi <= result.runs);
  assert.ok(result.commentary.length > 0);
  assert.notEqual(result.commentary, 'アウト');
  result.detail.runners.filter(runner => runner.isOut).forEach(runner => {
    assert.ok(runner.outLocation, 'out location must be recorded');
    assert.ok(runner.outReason, 'out reason must be recorded');
  });
  return result;
}

for (const bases of baseStates) {
  for (const hitBase of hitBases) {
    for (const cause of causes) {
      for (let variant = 0; variant < 5; variant++) {
        const flow = makeFlow(bases, hitBase);
        complete(flow, cause, variant);
        const result = validate(flow, hitBase);
        if (cause === 'passed' || cause === 'throwing') {
          assert.equal(result.error, true);
          assert.equal(result.errorType, cause);
        }
        scenarioCount++;
      }
    }
  }
}

assert.ok(scenarioCount >= 552, `expected at least 552 scenarios, got ${scenarioCount}`);

for (const hitBase of hitBases) {
  const flow = makeFlow([], hitBase);
  assert.equal(flow.runners.find(runner => runner.id === 'batter').currentBase, hitBase);
  complete(flow, 'throwing', 1);
  const result = validate(flow, hitBase);
  assert.equal(result.detail.hitBase, hitBase);
  assert.equal(result.rbi, 0, 'a run scored only on an error must not become an RBI');
}

{
  const flow = makeFlow([1], 1);
  const runner = Engine.nextNormalRunner(flow);
  const tagOut = Engine.normalOptions(flow, runner.id).find(option => option.kind === 'tagOut');
  Engine.applyNormal(flow, runner.id, tagOut.code);
  Engine.selectAdditional(flow, 'none');
  const result = validate(flow, 1);
  const out = result.detail.runners.find(item => item.id === 'r1');
  assert.equal(out.outReason, 'tagOut');
  assert.match(result.commentary, /二塁タッチアウト/);
}

{
  const flow = makeFlow([2], 1);
  chooseNormal(flow, 0);
  Engine.selectAdditional(flow, 'rundown');
  const target = Engine.rundownTargets(flow)[0];
  Engine.selectRundownRunner(flow, target.id);
  const interval = Engine.rundownIntervals(flow)[0];
  Engine.selectRundownInterval(flow, interval.code);
  Engine.applyRundownResult(flow, 'out');
  const result = validate(flow, 1);
  const out = result.detail.runners.find(item => item.id === target.id);
  assert.equal(out.outReason, 'rundown');
  assert.equal(out.outLocation, interval.code);
  assert.match(result.commentary, /挟殺アウト/);
}

{
  const flow = makeFlow([1, 2, 3], 2, 0, true);
  assert.equal(flow.phase, 'complete');
  const result = validate(flow, 2);
  assert.equal(result.runs, 2);
  assert.equal(result.rbi, 2);
  assert.deepEqual(result.active.map(runner => runner.currentBase).sort(), [2, 3]);
}

{
  const flow = makeFlow([1], 1, 2);
  const runner = Engine.nextNormalRunner(flow);
  const tagOut = Engine.normalOptions(flow, runner.id).find(option => option.kind === 'tagOut');
  Engine.applyNormal(flow, runner.id, tagOut.code);
  assert.equal(flow.phase, 'complete');
  assert.equal(flow.endedByThreeOuts, true);
  assert.equal(Engine.totalOuts(flow), 3);
  validate(flow, 1);
}

{
  const flow = makeFlow([1, 2], 1);
  chooseNormal(flow, 0);
  Engine.selectAdditional(flow, 'rundown');
  const targets = Engine.rundownTargets(flow);
  const blocked = targets.find(runner => runner.currentBase === 2);
  assert.ok(blocked, 'a runner may be caught between bases even when the next base is occupied');
  Engine.selectRundownRunner(flow, blocked.id);
  Engine.selectRundownInterval(flow, Engine.rundownIntervals(flow)[0].code);
  const codes = Engine.rundownResultOptions(flow).map(option => option.code);
  assert.ok(codes.includes('return'));
  assert.ok(codes.includes('out'));
  assert.ok(!codes.includes('advance'), 'advance into an occupied base must be hidden');
  assert.ok(!codes.includes('throwing-advance'));
  assert.ok(!codes.includes('passed-advance'));
}

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const confirmStart = indexSource.indexOf('function confirm(){');
const confirmEnd = indexSource.indexOf('return{start,normal', confirmStart);
const confirmSource = indexSource.slice(confirmStart, confirmEnd);
assert.ok(confirmStart >= 0 && confirmEnd > confirmStart);
assert.equal((confirmSource.match(/\bsnap\(\)/g) || []).length, 1, 'a completed hit must create exactly one undo snapshot');
assert.ok(confirmSource.indexOf('snap()') < confirmSource.indexOf('st.hits'), 'snapshot must precede scorebook mutations');
assert.match(indexSource, /c\.__commentaryHistoryLength=Commentary\.historyLength\(\)/);
assert.match(indexSource, /Commentary\.restoreHistoryLength\(historyLength\)/);
assert.match(indexSource, /if\(\/\^hit\[123\]:\/\.test\(c\)&&!\/FC\/\.test\(c\)\)return HitFlow\.start\(c\)/);
assert.match(indexSource, /<div class="field-actions">[\s\S]*?<div id="fieldMenuBox"><\/div>/);
assert.doesNotMatch(indexSource, /id="opbox"/);
assert.match(indexSource, /\$\('fieldMenuBox'\)\.innerHTML=/);
assert.match(indexSource, /function closeOperationMenu\(\)\{closeSheets\(\)\}/);
assert.match(indexSource, /const anchor=\$\('fieldMenuBox'\)\|\|host/);
assert.match(indexSource, /const APP_BUILD='v132-field-menu-location'/);

console.log(`hit-play-engine: ${scenarioCount} matrix scenarios + focused regressions passed`);
