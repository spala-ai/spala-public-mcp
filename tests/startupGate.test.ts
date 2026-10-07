import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearSpalaStartGate,
  hasCompletedSpalaStart,
  isStartupGatedTool,
  markSpalaStartCompleted,
  startupGateError,
} from '../src/startupGate.js';

test('spala_start unlocks gated tools for a subject', () => {
  clearSpalaStartGate('user-1');
  assert.equal(hasCompletedSpalaStart('user-1'), false);
  assert.equal(isStartupGatedTool('account_status'), true);
  assert.equal(isStartupGatedTool('spala_start'), false);
  assert.equal(isStartupGatedTool('docs_search'), false);
  markSpalaStartCompleted('user-1');
  assert.equal(hasCompletedSpalaStart('user-1'), true);
  const err = startupGateError('project_list');
  assert.equal(err.error, 'spala_start_required');
  assert.equal(err.nextAction.tool, 'spala_start');
});
