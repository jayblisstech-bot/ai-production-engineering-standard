'use strict';

/**
 * Executes every independently bounded review chunk with an optional, explicitly
 * approved concurrency of at most two. Default is the original serial review.
 * Any rejected or missing chunk fails closed; no partial PASS is ever emitted.
 */
async function executeReviewChunks(chunks, reviewOne, options = {}) {
  if (!Array.isArray(chunks) || !chunks.length) throw new Error('No AI review chunks to execute.');
  if (typeof reviewOne !== 'function') throw new Error('AI review callback is required.');
  const concurrency = options.concurrency === undefined ? 1 : options.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
    throw new Error('APES review concurrency must be an integer between 1 and 2.');
  }
  const results = new Array(chunks.length);
  let nextIndex = 0;
  let firstError = null;
  async function worker() {
    while (nextIndex < chunks.length && !firstError) {
      const index = nextIndex++;
      try {
        const result = await reviewOne(chunks[index], index);
        if (result === undefined || result === null) {
          throw new Error('AI review chunk produced no verified result.');
        }
        results[index] = result;
      } catch (error) {
        firstError = firstError || error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));
  if (firstError) throw firstError;
  if (results.some((result) => result === undefined || result === null)) {
    throw new Error('Incomplete AI review; refusing partial PASS.');
  }
  return results;
}

module.exports = { executeReviewChunks };
