import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivateIp, validatePublicDomain, validatePublicUrl } from '../src/lib/validate.js';
import { UserInputError } from '../src/lib/errors.js';

const noDns = { dnsCheck: false };

test('normalises bare domains and strips fragments', async () => {
  assert.equal(await validatePublicUrl('example.com', noDns), 'https://example.com/');
  assert.equal(await validatePublicUrl('  https://Shop.Example.co.uk/path?q=1#frag ', noDns), 'https://shop.example.co.uk/path?q=1');
  assert.equal(await validatePublicUrl('http://example.com:8080/', noDns), 'http://example.com:8080/');
});

const BAD_URLS = [
  'http://127.0.0.1/', 'http://localhost:3000', 'http://10.1.2.3', 'http://192.168.1.1', 'http://172.20.0.5',
  'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/',
  'http://0x7f000001/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://100.64.0.1', 'http://0.0.0.0',
  'http://metadata.google.internal/', 'http://printer.local/', 'http://intranet/', 'https://foo.internal',
  'ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com',
  'https://example.com:22/', 'https://example.test', '', 'http://224.0.0.1',
];

for (const u of BAD_URLS) {
  test(`rejects ${JSON.stringify(u)}`, async () => {
    await assert.rejects(validatePublicUrl(u, noDns), UserInputError);
  });
}

test('DNS check rejects hostnames resolving to private addresses (rebinding guard)', async () => {
  const resolver = async () => ['93.184.215.14', '10.0.0.7'];
  await assert.rejects(validatePublicUrl('https://evil.example.com', { dnsCheck: true, resolver }), /private or reserved/);
  const ok = async () => ['93.184.215.14'];
  assert.equal(await validatePublicUrl('https://good.example.com', { dnsCheck: true, resolver: ok }), 'https://good.example.com/');
  const nx = async () => {
    throw new Error('ENOTFOUND');
  };
  await assert.rejects(validatePublicUrl('https://nx.example.com', { dnsCheck: true, resolver: nx }), /does not resolve/);
});

test('domain validation accepts URLs and emails, rejects IPs/internal', async () => {
  assert.equal(await validatePublicDomain('https://www.Example.com/contact', noDns), 'www.example.com');
  assert.equal(await validatePublicDomain('ceo@example.org', noDns), 'example.org');
  assert.equal(await validatePublicDomain('bücher.de', noDns), 'xn--bcher-kva.de');
  await assert.rejects(validatePublicDomain('8.8.8.8', noDns), UserInputError);
  await assert.rejects(validatePublicDomain('db.internal', noDns), UserInputError);
  await assert.rejects(validatePublicDomain('localhost', noDns), UserInputError);
});

test('ip classifier', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1', '64:ff9b::a00:1'])
    assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111'])
    assert.equal(isPrivateIp(ip), false, ip);
});
