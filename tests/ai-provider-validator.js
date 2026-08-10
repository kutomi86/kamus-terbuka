const assert = require('assert/strict');

const { validateAIResponse } = require('../helpers/ai-engine/ai-validator');

function runTest() {
  const expectedRow = { id: 42 };

  const validResponse = [
    {
      id: 42,
      kata: 'makan',
      lema: 'makan',
      pelafalan: 'ma-kan',
      makna: 'memasukkan makanan ke dalam mulut',
      jenis_entri: 'kata',
    },
  ];

  const validated = validateAIResponse(validResponse, [expectedRow], {
    requiredFields: ['id', 'kata', 'lema', 'pelafalan', 'makna', 'jenis_entri'],
  });

  assert.equal(validated.length, 1);
  assert.equal(validated[0].id, 42);

  assert.throws(
    () => validateAIResponse([{ ...validResponse[0], id: 99 }], [expectedRow], {
      requiredFields: ['id', 'kata', 'lema', 'pelafalan', 'makna', 'jenis_entri'],
    }),
    /unexpected id/i
  );

  assert.throws(
    () => validateAIResponse([
      {
        id: 42,
        kata: 'makan',
        lema: 'makan',
        pelafalan: 'ma-kan',
        makna: '',
        jenis_entri: 'kata',
      },
    ], [expectedRow], {
      requiredFields: ['id', 'kata', 'lema', 'pelafalan', 'makna', 'jenis_entri'],
    }),
    /missing required field/i
  );

  console.log('✅ AI response validator test passed.');
}

try {
  runTest();
} catch (err) {
  console.error('❌ AI response validator test failed:');
  console.error(err.message);
  process.exit(1);
}