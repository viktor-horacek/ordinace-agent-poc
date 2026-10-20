import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from './errors.ts';

test('describeError nepustí do logu API klíč z SDK chyby', () => {
  // napodobenina chyby z @openrouter/sdk: tělo v `error`, požadavek s hlavičkou v data$.request$
  const error = Object.assign(new Error('Provider returned error'), {
    name: 'BadRequestResponseError',
    statusCode: 400,
    headers: { 'set-cookie': 'session=tajne' },
    rawResponse: { headers: { 'set-cookie': 'session=tajne' } },
    error: { message: 'Provider returned error', code: 400, metadata: { provider_name: 'Test', raw: 'bad input' } },
    data$: { request$: { headers: { authorization: 'Bearer sk-or-v1-TEST' } } },
  });

  const described = describeError(error);
  const logged = JSON.stringify(described);

  assert.ok(!logged.includes('sk-or-v1'));
  assert.ok(!logged.includes('tajne'));
  assert.deepEqual(described, {
    name: 'BadRequestResponseError',
    message: 'Provider returned error',
    statusCode: 400,
    provider: { message: 'Provider returned error', code: 400, providerName: 'Test', raw: 'bad input' },
  });
});
