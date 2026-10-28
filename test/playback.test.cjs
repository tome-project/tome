const { test } = require('node:test');
const assert = require('node:assert/strict');
const { playbackModeForRequest, requestOrigin } = require('../dist/routes/playback');

function fakeReq({ host, proto = 'https', forwardedHost, forwardedProto, protocol = 'https' }) {
  const headers = {};
  if (host) headers.host = host;
  if (forwardedHost) headers['x-forwarded-host'] = forwardedHost;
  if (forwardedProto) headers['x-forwarded-proto'] = forwardedProto;
  return {
    protocol,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

test('requestOrigin prefers forwarded host/proto from the tunnel hop', () => {
  assert.equal(
    requestOrigin(fakeReq({ host: '127.0.0.1:3010', forwardedHost: 'tome.example.com', forwardedProto: 'https' })),
    'https://tome.example.com',
  );
  assert.equal(requestOrigin(fakeReq({ host: '192.168.1.10:3000', protocol: 'http' })), 'http://192.168.1.10:3000');
});

test('playbackModeForRequest marks PUBLIC_URL host as tunneled', () => {
  const prev = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = 'https://tome.example.com';
  try {
    assert.equal(playbackModeForRequest(fakeReq({ host: 'tome.example.com' })), 'tunneled');
    assert.equal(playbackModeForRequest(fakeReq({ host: '192.168.1.10:3000' })), 'direct');
    assert.equal(
      playbackModeForRequest(fakeReq({ host: 'ignored', forwardedHost: 'tome.example.com' })),
      'tunneled',
    );
  } finally {
    if (prev === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = prev;
  }
});

test('without PUBLIC_URL every origin is direct', () => {
  const prev = process.env.PUBLIC_URL;
  delete process.env.PUBLIC_URL;
  try {
    assert.equal(playbackModeForRequest(fakeReq({ host: 'tome.example.com' })), 'direct');
  } finally {
    if (prev !== undefined) process.env.PUBLIC_URL = prev;
  }
});
