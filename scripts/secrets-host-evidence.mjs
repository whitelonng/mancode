import assert from 'node:assert/strict';

// Events come from the runner's audit delta, never the host's natural-language answer.
export function verifyHostEvidence(evidence) {
  assert.equal(evidence.exit, 0, 'Host process must exit successfully');
  assert.equal(evidence.requests, 1, 'Host must make exactly one fixture request');
  assert.equal(evidence.authorized, 1, 'The fixture request must authenticate');
  assert.equal(evidence.auditEvents.length, 1, 'Exactly one new runner audit event is required');
  const event = evidence.auditEvents[0];
  assert.deepEqual(Object.keys(event).sort(), ['action', 'event', 'runId', 'time']);
  assert.match(event.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(event.action, 'ticket-check');
  assert.equal(event.event, 'executor_succeeded');
  assert.match(event.time, /^\d{4}-\d{2}-\d{2}T\d{2}$/);
}
