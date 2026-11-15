import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../next.config';

test('a production build does not include the Next testing API', () => {
  // The testing API lets a request hold back or alter rendering; Next's guide restricts it to dedicated test builds.
  assert.notEqual(config.experimental?.exposeTestingApiInProductionBuild, true);
  // The settings the app relies on are still there.
  assert.equal(config.cacheComponents, true);
});
