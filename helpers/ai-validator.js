function toExpectedIdSet(expectedRows = []) {
  const ids = expectedRows
    .map((row) => (row && Number.isInteger(row.id) ? row.id : null))
    .filter((id) => id !== null);

  return new Set(ids);
}

function isMeaningfulValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function validateAIResponse(results, expectedRows = [], options = {}) {
  if (!Array.isArray(results)) {
    throw new Error('AI response must be an array of entries.');
  }

  if (results.length === 0) {
    throw new Error('AI response returned no entries.');
  }

  const expectedIds = toExpectedIdSet(expectedRows);
  const requiredFields = Array.isArray(options.requiredFields) ? options.requiredFields : [];
  const allowExtraIds = options.allowExtraIds === true;
  const seenIds = new Set();

  for (const entry of results) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('AI response contains a non-object entry.');
    }

    if (!Number.isInteger(entry.id)) {
      throw new Error('AI response entry is missing a numeric id.');
    }

    if (expectedIds.size > 0 && !expectedIds.has(entry.id)) {
      throw new Error(`AI response returned an unexpected id: ${entry.id}.`);
    }

    for (const field of requiredFields) {
      if (!isMeaningfulValue(entry[field])) {
        throw new Error(`AI response entry ${entry.id} is missing required field: ${field}.`);
      }
    }

    seenIds.add(entry.id);
  }

  if (expectedIds.size > 0 && !allowExtraIds) {
    for (const id of expectedIds) {
      if (!seenIds.has(id)) {
        throw new Error(`AI response did not include the expected id: ${id}.`);
      }
    }
  }

  return results;
}

module.exports = {
  validateAIResponse,
};