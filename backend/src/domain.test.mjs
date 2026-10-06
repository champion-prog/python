import test from 'node:test';
import assert from 'node:assert/strict';
import { createToken, estimateWaitTime } from './domain.mjs';

test('estimates queue wait from active entries and average service duration', () => {
  const result = estimateWaitTime([
    { status: 'WAITING' },
    { status: 'IN_SERVICE' },
    { status: 'COMPLETED' },
    { status: 'CANCELLED' }
  ], 5);

  assert.deepEqual(result, { peopleAhead: 2, estimatedWaitMinutes: 10 });
});

test('creates deterministic, padded queue tokens', () => {
  assert.equal(createToken(1), 'A001');
  assert.equal(createToken(104), 'A104');
});

test('rejects invalid queue sequence numbers', () => {
  assert.throws(() => createToken(0), TypeError);
});
