const assert = require('assert/strict');

const { classifyProviderFailure } = require('../helpers/ai-engine/ai-provider');

function runTest() {
  assert.equal(
    classifyProviderFailure(new Error('AI response entry 2 is missing required field: pelafalan.')),
    'missing-field'
  );

  assert.equal(
    classifyProviderFailure(new Error('429 Too Many Requests')),
    'rate-limit'
  );

  assert.equal(
    classifyProviderFailure(new Error('socket hang up')),
    'transient'
  );

  console.log('✅ AI provider failure classifier test passed.');
}

try {
  runTest();
} catch (err) {
  console.error('❌ AI provider failure classifier test failed:');
  console.error(err.message);
  process.exit(1);
}
