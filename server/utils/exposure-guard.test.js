import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExposure } from './exposure-guard.js';

test('loopback binds are always ok, with or without users', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
        for (const hasUsers of [true, false]) {
            const r = evaluateExposure({ host, hasUsers });
            assert.equal(r.level, 'ok', `${host} hasUsers=${hasUsers}`);
            assert.equal(r.reason, 'loopback');
        }
    }
});

test('non-loopback bind with no users is blocked (fail-closed)', () => {
    for (const host of ['0.0.0.0', '::', '192.168.0.10', '100.123.228.51']) {
        const r = evaluateExposure({ host, hasUsers: false });
        assert.equal(r.level, 'block', host);
        assert.equal(r.reason, 'unconfigured-remote');
        assert.match(r.message, /Refusing to listen/);
        assert.match(r.message, /ALLOW_REMOTE_SETUP=1/);
    }
});

test('ALLOW_REMOTE_SETUP=1 downgrades the unconfigured block to a warning', () => {
    const r = evaluateExposure({ host: '0.0.0.0', hasUsers: false, allowRemoteSetup: true });
    assert.equal(r.level, 'warn');
    assert.equal(r.reason, 'remote-setup-override');
    assert.match(r.message, /NO account configured/);
});

test('non-loopback bind with an existing user warns but is allowed', () => {
    const r = evaluateExposure({ host: '0.0.0.0', hasUsers: true });
    assert.equal(r.level, 'warn');
    assert.equal(r.reason, 'network-exposed');
    assert.match(r.message, /Authentication is enforced/);
});

test('wildcard vs specific address is reflected in the message scope', () => {
    const wildcard = evaluateExposure({ host: '0.0.0.0', hasUsers: true });
    assert.match(wildcard.message, /ALL network interfaces/);
    const specific = evaluateExposure({ host: '192.168.0.10', hasUsers: true });
    assert.match(specific.message, /network address 192\.168\.0\.10/);
});

test('allowRemoteSetup does not silence the exposure warning when users exist', () => {
    const r = evaluateExposure({ host: '0.0.0.0', hasUsers: true, allowRemoteSetup: true });
    assert.equal(r.level, 'warn');
    assert.equal(r.reason, 'network-exposed');
});

test('auth mode none: loopback binds stay ok', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
        const r = evaluateExposure({ host, hasUsers: true, authMode: 'none' });
        assert.equal(r.level, 'ok', host);
        assert.equal(r.reason, 'loopback');
    }
});

test('auth mode none: any non-loopback bind is blocked regardless of users', () => {
    for (const host of ['0.0.0.0', '::', '192.168.0.10', '100.123.228.51']) {
        for (const hasUsers of [true, false]) {
            const r = evaluateExposure({ host, hasUsers, authMode: 'none' });
            assert.equal(r.level, 'block', `${host} hasUsers=${hasUsers}`);
            assert.equal(r.reason, 'unauthenticated-remote');
            assert.match(r.message, /CHATMUX_AUTH=none/);
            assert.match(r.message, /CHATMUX_ALLOW_UNAUTH_REMOTE=1/);
        }
    }
});

test('auth mode none: CHATMUX_ALLOW_UNAUTH_REMOTE=1 downgrades the block to a loud warning', () => {
    const r = evaluateExposure({ host: '100.123.228.51', hasUsers: true, authMode: 'none', allowUnauthRemote: true });
    assert.equal(r.level, 'warn');
    assert.equal(r.reason, 'unauthenticated-remote-override');
    assert.match(r.message, /NO authentication/);
});

test('auth mode none: allowRemoteSetup does not bypass the unauthenticated block', () => {
    const r = evaluateExposure({ host: '0.0.0.0', hasUsers: false, authMode: 'none', allowRemoteSetup: true });
    assert.equal(r.level, 'block');
    assert.equal(r.reason, 'unauthenticated-remote');
});
