import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { captureErrorCode } from './audio-capture';

const domError = (name: string) => Object.assign(new Error(name), { name });

test('a refused microphone is not-allowed, anything else audio-capture', () => {
  assert.equal(captureErrorCode(domError('NotAllowedError')), 'not-allowed');
  assert.equal(captureErrorCode(domError('SecurityError')), 'not-allowed');
  assert.equal(captureErrorCode(domError('NotFoundError')), 'audio-capture');
  assert.equal(captureErrorCode(domError('NotReadableError')), 'audio-capture');
  assert.equal(captureErrorCode({ name: 'NotAllowedError' }), 'not-allowed');
  assert.equal(captureErrorCode('weird'), 'audio-capture');
});
