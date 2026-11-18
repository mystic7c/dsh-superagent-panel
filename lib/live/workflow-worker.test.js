import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStageResult, stageJsonMarker } from './workflow-worker.js'

test('a staged role is told which JSON keys and which shape to answer with', () => {
  assert.equal(stageJsonMarker('assess'),
    'Return only a json object with keys: workflow, reason. Shape: {"workflow":"simple|planned","reason":"string"}')
  // Key names alone let a plan answer `acceptanceCriteria` as an array of strings; the shape says it is objects.
  const plan = stageJsonMarker('plan')
  assert.match(plan, /keys: summary, steps, acceptanceCriteria, openQuestions\./)
  assert.match(plan, /"acceptanceCriteria":\[\{"id":"string","requirement":"string","verification":"string"\}\]/)
  assert.match(stageJsonMarker('review'), /"verdict":"passed|changes_requested|plan_invalid|blocked"/)
  // `implement` answers with prose: it has no schema, and asking for JSON there would break its summary.
  assert.equal(stageJsonMarker('implement'), '')
})

test('a stage answer is accepted bare, fenced or wrapped in a preamble', () => {
  assert.deepEqual(parseStageResult('{"workflow":"simple","reason":"one file"}', 'assess'),
    { workflow: 'simple', reason: 'one file' })
  assert.deepEqual(parseStageResult('```json\n{"workflow":"planned","reason":"migration"}\n```', 'assess'),
    { workflow: 'planned', reason: 'migration' })
  assert.deepEqual(parseStageResult('评估如下：\n{"workflow":"planned","reason":"cross-module"}\n以上。', 'assess'),
    { workflow: 'planned', reason: 'cross-module' })
})

test('nested objects and braces inside strings do not truncate the answer', () => {
  const answer = '{"summary":"use {n} placeholders","steps":["a"],'
    + '"acceptanceCriteria":[{"id":"AC-1","requirement":"r","verification":"v"}],"openQuestions":[]}'
  const parsed = parseStageResult(`plan:\n${answer}\n`, 'plan')
  assert.equal(parsed.summary, 'use {n} placeholders')
  assert.equal(parsed.acceptanceCriteria[0].id, 'AC-1')
})

test('prose that carries no object says so instead of raising a bare parse error', () => {
  const failure = /** @type {any} */ (() => {
    try { parseStageResult('## 评估结果：本运行只读，未改动任何文件 {not json}', 'assess') } catch (error) { return error }
    return undefined
  })()
  assert.match(failure.message, /^assess did not answer with one JSON object: ## 评估结果/)
  assert.doesNotMatch(failure.message, /position \d+ \(line/)
})

test('a wrapped object is unwrapped, a scalar is not a stage verdict', () => {
  assert.deepEqual(parseStageResult('[{"workflow":"simple","reason":"one file"}]', 'assess'),
    { workflow: 'simple', reason: 'one file' })
  assert.throws(() => parseStageResult('"simple"', 'assess'), /did not answer with one JSON object/)
  assert.throws(() => parseStageResult('', 'assess'), /did not answer with one JSON object$/)
})
