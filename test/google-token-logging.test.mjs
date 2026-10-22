import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const match = source.match(/function saveGCalToken\(token, email\) \{[\s\S]*?\n\}/);
assert.ok(match, 'production credential writer must be discoverable');

for (const email of [undefined, 'fixture@example.invalid']) {
  test(`credential persistence never logs values (${email ? 'user' : 'legacy'})`, () => {
    const writes = [];
    const logs = [];
    const token = {
      access_token: 'ACCESS_SENTINEL_NOT_A_REAL_TOKEN',
      refresh_token: 'REFRESH_SENTINEL_NOT_A_REAL_TOKEN',
      expires_at: 1,
      scope: 'SCOPE_SENTINEL',
    };
    const save = vm.runInNewContext(`(${match[0]})`, {
      fs: { writeFileSync: (...args) => writes.push(args) },
      userGCalTokenFile: address => `/fixture/${address}/token.json`,
      GCAL_TOKEN_FILE: '/fixture/legacy.json',
      console: { log: (...args) => logs.push(args) },
    });
    save(token, email);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], email ? `/fixture/${email}/token.json` : '/fixture/legacy.json');
    assert.deepEqual(JSON.parse(writes[0][1]), token);
    assert.equal(writes[0].length, 2);
    const logged = JSON.stringify(logs);
    for (const value of Object.values(token)) assert.equal(logged.includes(String(value)), false);
    assert.equal(logged.includes('TOKEN_FOR_ENV'), false);
  });
}
