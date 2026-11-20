// Tests for the web page, run by test/portal/run.sh.
//
// The page is loaded into jsdom and talks to a pretend device (below) that
// answers the same API the firmware serves.

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = process.argv[2];
const html = fs.readFileSync(path.join(root, 'html/portal.html'), 'utf8').replace('<script src="login.js"></script>', '').replace('<script src="portal.js"></script>', '');
// The page's scripts, in this order, each its own <script> as htmlconvert.py puts them in the page.
// Kept apart so that portal.js's 'use strict' opens its script, as it does on the device.
const scripts = ['login.js', 'portal.js'].map(name => fs.readFileSync(path.join(root, 'html', name), 'utf8'));
const login = require(path.join(root, 'html/login.js'));
const { makeDevice, addHomey, sourceHash } = require('./pretend-device.js');

// --------------------------------------------------------------- harness

let failures = 0;
let checks = 0;
function check(condition, what) {
    checks++;
    if (!condition) {
        failures++;
        console.log('  FAIL ' + what);
    }
}
function equal(actual, expected, what) {
    checks++;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log('  FAIL ' + what + '\n    got:      ' + JSON.stringify(actual) + '\n    expected: ' + JSON.stringify(expected));
    }
}

async function openPage(device, options) {
    // jsdom has no canvas; the page copes, so its "not implemented" notes are just noise.
    const quiet = new VirtualConsole();
    options = options || {};
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: (options.origin || 'http://deskhog.local/') + (options.hash || ''), virtualConsole: quiet });
    const window = dom.window;
    // jsdom has no idea how wide it is. Tests say whether the page is on a desktop.
    window.matchMedia = () => ({ matches: !!options.wide });
    // `storage` is what the page's localStorage keeps, so that two pages can share it; `refuseStorage` is a browser that throws.
    if (options.storage || options.refuseStorage) {
        const store = options.storage || {};
        const refuse = () => { throw new window.Error('storage is not allowed'); };
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            value: options.refuseStorage
                ? { getItem: refuse, setItem: refuse, removeItem: refuse }
                : { getItem: name => (name in store ? store[name] : null), setItem: (name, value) => { store[name] = String(value); }, removeItem: name => { delete store[name]; } },
        });
    }
    // `hold` is a promise the first GET /api/login waits for (it may reject: a device that is away).
    const hold = options.hold;
    let held = false;
    // jsdom has no crypto.getRandomValues; the browser has.
    if (!window.crypto || !window.crypto.getRandomValues) Object.defineProperty(window, 'crypto', { configurable: true, value: require('crypto').webcrypto });
    window.fetch = async (url, options) => {
        options = options || {};
        const method = options.method || 'GET';
        if (hold && !held && url === '/api/login' && method === 'GET') { held = true; await hold; }
        let body = options.body;
        const type = options.headers && options.headers['Content-Type'];
        // A browser sends header names in any case; the device is given them in lower case.
        const headers = {};
        for (const [name, value] of Object.entries(options.headers || {})) headers[name.toLowerCase()] = value;
        if (typeof body === 'string' && type === 'application/json') body = JSON.parse(body);
        if (body instanceof window.FormData) body = Object.fromEntries(body.entries());
        if (body instanceof window.Uint8Array) body = Buffer.from(body).toString('utf8');
        let answer;
        if (/^https?:/.test(url)) {
            // Not the device: the plugin directory, somewhere on the internet.
            (device.outsideSeen = device.outsideSeen || []).push({ url, headers });
            answer = device.fetchOutside(url);
            if (!answer) throw new TypeError('Failed to fetch');
        } else {
            device.requests.push({ method, url, body, type, headers });
            answer = device.handle(method, url, body, headers);
        }
        return {
            ok: answer.status >= 200 && answer.status < 300,
            status: answer.status,
            headers: { get: name => (answer.headers || {})[name] || null },
            text: async () => String(answer.body),
            arrayBuffer: async () => new window.Uint8Array(Buffer.from(answer.body)).buffer,
        };
    };
    window.confirm = () => true;
    window.Element.prototype.scrollIntoView = () => {};
    const errors = [];
    window.addEventListener('error', event => errors.push(event.message));
    // As a real <script>, so the page's functions are global like in a browser.
    for (const script of scripts) {
        const tag = window.document.createElement('script');
        tag.textContent = script;
        window.document.body.appendChild(tag);
    }
    // New passwords take 20,000 rounds; the tests do not wait for that.
    window.eval('passwordRounds = 100');
    await settle(window);
    return { window, document: window.document, errors };
}

/** Let pending fetches and their follow-ups finish. */
async function settle(window) {
    for (let i = 0; i < 12; i++) await new Promise(resolve => window.setTimeout(resolve, 0));
}

const text = node => (node ? node.textContent : null);
const titles = document => [...document.querySelectorAll('#cards-list .item-title')].map(text);
const tile = (document, key) => document.querySelector('#cards-list .item[data-key="' + key + '"] .item-open');
const visiblePage = document => [...document.querySelectorAll('.page')].filter(page => !page.hidden).map(page => page.id);
const click = async (window, node) => { node.click(); await settle(window); };
const buttonNamed = (scope, label) => [...scope.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(label));
const lastRequest = (device, url) => [...device.requests].reverse().find(r => r.url.startsWith(url));
const fieldNamed = (scope, label) => {
    const wrap = [...scope.querySelectorAll('label.field')].find(l => l.querySelector('span').textContent === label);
    return wrap ? wrap.querySelector('input, select, textarea') : null;
};

const tests = [];
const test = (name, body) => tests.push({ name, body });

// ------------------------------------------------------------------ tests

test('shows the cards with sensible names', async () => {
    const device = makeDevice();
    const { document, errors } = await openPage(device);
    // "City" is the default name, so the plugin's own title wins; "Home" was typed by someone.
    equal(titles(document), ['Lisbon', 'Home', 'Hello', 'Webhook', 'Insight'], 'card titles');
    const subs = [...document.querySelectorAll('#cards-list .item-sub')].map(text);
    equal(subs[0], 'Weather, on screen now', 'subtitle of the visible weather card');
    equal(subs[1], 'Weather', 'subtitle of a named card');
    equal(subs[2], '', 'a single-card plugin needs no subtitle');
    check(subs[4].startsWith('Crashed: posthog:12: 401'), 'a crashed connection says why on its card');
    check(document.querySelector('#cards-list .item').classList.contains('live'), 'the card on screen is marked');
    equal(text(document.getElementById('wifi-pill')), 'Home WiFi, 192.168.1.50', 'wifi pill');
    check(document.getElementById('wifi-setup').hidden, 'no wifi setup panel while connected');
    check(document.querySelectorAll('#cards-list canvas').length === 5, 'one picture per card');
    check(device.requests.some(r => r.url.startsWith('/api/cards/screen?packed=1&key=weather%3A1')), 'fetches card pictures, packed');
    check(document.getElementById('card-pane').hidden, 'on a phone nothing is open until you pick a card');
    equal(errors, [], 'no script errors');
});

// The tests must run the page the way the device does: portal.js is its own script and runs strict,
// so a slip such as writing to an undeclared variable throws here as it would there.
test('runs portal.js in strict mode, as the device does', async () => {
    const { window } = await openPage(makeDevice());
    let strict = false;
    // Reading .caller of a strict function throws; of a sloppy one it does not.
    try { void window.unpackRuns.caller; } catch (error) { strict = error instanceof window.TypeError; }
    check(strict, 'portal.js is strict');
});

test('unpacks the pictures the device sends', async () => {
    const { window } = await openPage(makeDevice());
    const packed = new window.Uint8Array([2, 0x34, 0x12, 1, 0xff, 0xff, 200, 0x01, 0x00]);
    const pixels = new window.Uint16Array(window.unpackRuns(packed.buffer, 5));
    equal([...pixels], [0x1234, 0x1234, 0xffff, 1, 1], 'runs become pixels, and never more than the picture holds');
});

test('has four pages and remembers which one in the address', async () => {
    const { window, document } = await openPage(makeDevice());
    equal(visiblePage(document), ['page-cards'], 'starts on the cards');
    await click(window, document.querySelector('.tabs a[data-page="plugins"]'));
    equal(visiblePage(document), ['page-plugins'], 'a tab switches page');
    equal(window.location.hash, '#plugins', 'the address follows');
    equal(document.querySelector('.tabs a[aria-current="page"]').textContent, 'Plugins', 'the tab is marked');
    await click(window, document.getElementById('wifi-pill'));
    equal(visiblePage(document), ['page-device'], 'the wifi pill leads to the device page');

    const reopened = await openPage(makeDevice(), { hash: '#connections' });
    equal(visiblePage(reopened.document), ['page-connections'], 'opening with an address goes straight there');
    const odd = await openPage(makeDevice(), { hash: '#nonsense' });
    equal(visiblePage(odd.document), ['page-cards'], 'an unknown address falls back to the cards');
});

test('on a wide screen the pane starts with the card that is on the device', async () => {
    const device = makeDevice();
    device.cards[0].onScreen = false;
    device.cards[3].onScreen = true;
    const { window, document } = await openPage(device, { wide: true });
    const pane = document.getElementById('card-pane');
    check(!pane.hidden, 'the pane is open');
    equal(text(pane.querySelector('.pane-head h2')), 'Webhook', 'with the card on screen');
    check(tile(document, 'PLUGIN|webhook:1').parentNode.classList.contains('selected'), 'its tile is marked');
    check(pane.querySelector('.device canvas') !== null, 'it shows the device');

    await click(window, pane.querySelector('.pane-head .close'));
    check(pane.hidden, 'closing it works');
    await window.refresh();
    check(pane.hidden, 'and it stays closed');
});

test('the buttons of the device work from the page', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, tile(document, 'PLUGIN|hello:1'));
    const pane = document.getElementById('card-pane');
    check(text(pane.querySelector('.pane-status')).startsWith('Not on screen'), 'says the card is not showing');
    equal([...pane.querySelectorAll('.hw')].map(b => b.getAttribute('aria-label')), ['Up button', 'Centre button', 'Down button'], 'three buttons');

    device.requests.length = 0;
    await click(window, pane.querySelector('.hw[aria-label="Centre button"]'));
    const calls = device.requests.filter(r => r.method === 'POST').map(r => r.url);
    equal(calls, ['/api/cards/show?key=hello%3A1', '/api/cards/press?key=hello%3A1&button=center'], 'brings the card up, then presses');
    check(document.getElementById('notice').hidden, 'and the device accepts it');
    await window.refresh();
    check(text(pane.querySelector('.pane-status')).startsWith('On the device'), 'now it is on screen');

    // The open card is watched, but its picture is only sent again once it has changed.
    await settle(window); // the new picture has arrived
    await window.watchOpenCard();
    await settle(window);
    equal(lastRequest(device, '/api/cards/screen').url, '/api/cards/screen?packed=1&key=hello%3A1&since=' + device.cards[2].frames, 'asks only for a newer picture');

    device.requests.length = 0;
    await click(window, pane.querySelector('.hw[aria-label="Up button"]'));
    equal(device.requests.filter(r => r.method === 'POST').map(r => r.url), ['/api/cards/press?key=hello%3A1&button=up'], 'a card on screen is just pressed');
});

test('lists only connections that have shared settings', async () => {
    const { document } = await openPage(makeDevice());
    equal([...document.querySelectorAll('#connections-list .item-title')].map(text), ['Weather', 'Work'], 'connection names');
    const subs = [...document.querySelectorAll('#connections-list .item-sub')].map(text);
    equal(subs[0], 'Weather, 2 cards', 'card count');
    check(subs[1].startsWith('Crashed:'), 'crashed connection');
    check(document.getElementById('connections-empty').hidden, 'no empty note');

    const device = makeDevice();
    device.plugins = device.plugins.filter(p => !p.multiCard);
    device.connections = device.connections.filter(c => c.plugin === 'hello' || c.plugin === 'webhook');
    device.cards = device.cards.filter(c => c.plugin === 'hello' || c.plugin === 'webhook');
    const simple = await openPage(device);
    equal(simple.document.querySelectorAll('#connections-list .item').length, 0, 'none listed when nothing is shared');
    check(!simple.document.getElementById('connections-empty').hidden, 'and the page says why');
});

test('adds a card to an existing connection', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, document.getElementById('add-card-btn'));
    const pane = document.getElementById('card-pane');
    check(!pane.hidden, 'the steps open in the pane');
    const choices = [...pane.querySelectorAll('.choices:not(.more) .choice')].map(c => c.querySelector('b').textContent);
    equal(choices, ['Max', 'Hello', 'Webhook', 'City', 'Funnel', 'Insight'], 'choices offered: a card of anything that is installed');
    check(!choices.includes('broken'), 'a plugin that does not load is not offered');
    check(!pane.textContent.includes('null') && !pane.textContent.includes('undefined'), 'nothing stray in the pane');

    await click(window, buttonNamed(pane, 'City'));
    equal(fieldNamed(pane, 'Connection').value, 'weather', 'the existing connection is preselected');
    check(fieldNamed(pane, 'Unit').closest('div[hidden]') !== null, 'shared fields stay hidden for an existing connection');
    fieldNamed(pane, 'City').value = 'Oslo';
    await click(window, buttonNamed(pane, 'Add card'));
    equal(lastRequest(device, '/api/cards/add').body, { plugin: 'weather', kind: 'city', name: '', settings: { city: 'Oslo' }, connection: 'weather' }, 'request');
    check(pane.hidden, 'on a phone the pane closes');
    equal(titles(document).length, 6, 'the new card is listed');
});

test('on a wide screen a new card goes straight into the pane', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { wide: true });
    await click(window, document.getElementById('add-card-btn'));
    const pane = document.getElementById('card-pane');
    await click(window, buttonNamed(pane, 'Max'));
    await click(window, buttonNamed(pane, 'Back'));
    check(buttonNamed(pane, 'Webhook') !== undefined, 'back returns to the choices');
    await click(window, buttonNamed(pane, 'Max'));
    await click(window, buttonNamed(pane, 'Add card'));
    check(!pane.hidden, 'the pane stays');
    equal(text(pane.querySelector('.pane-head h2')), 'Max', 'and shows the new card');
    check(fieldNamed(pane, 'Your own messages, separated by |') !== null, 'with its settings');
});

test('adds a card with a new connection', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, document.getElementById('add-card-btn'));
    const pane = document.getElementById('card-pane');
    await click(window, buttonNamed(pane, 'Insight'));
    const select = fieldNamed(pane, 'Connection');
    equal([...select.options].map(o => o.textContent), ['Work', 'A new connection…'], 'connection choices');
    select.value = '';
    select.dispatchEvent(new window.Event('change'));
    fieldNamed(pane, 'Name for this connection').value = 'Client X';
    fieldNamed(pane, 'API key').value = 'phx_123';
    fieldNamed(pane, 'Insight ID').value = '777';
    pane.querySelector('input[data-key="compact"]').checked = true;
    fieldNamed(pane, 'Name (optional)').value = 'Signups';
    await click(window, buttonNamed(pane, 'Add card'));
    equal(lastRequest(device, '/api/cards/add').body, {
        plugin: 'posthog', kind: 'insight', name: 'Signups', settings: { id: '777', compact: 'true' },
        connection: '', connectionName: 'Client X', connectionSettings: { host: 'https://eu.posthog.com', key: 'phx_123' },
    }, 'request');
});

test('adds a single-card plugin: its settings are the card\'s settings', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, document.getElementById('add-card-btn'));
    const pane = document.getElementById('card-pane');
    await click(window, buttonNamed(pane, 'Webhook'));
    check(fieldNamed(pane, 'Connection') === null, 'no talk of connections');
    fieldNamed(pane, 'Webhook URL').value = 'http://example.com/2';
    await click(window, buttonNamed(pane, 'Add card'));
    equal(lastRequest(device, '/api/cards/add').body, { plugin: 'webhook', kind: 'main', name: '', connectionSettings: { url: 'http://example.com/2', label: 'Send' } }, 'request');
});

test('edits a card of a multi-card plugin', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, tile(document, 'PLUGIN|weather:1'));
    const pane = document.getElementById('card-pane');
    equal(fieldNamed(pane, 'Name').value, '', 'a default name shows as empty');
    equal(fieldNamed(pane, 'City').value, 'Lisbon', 'saved setting shown');
    check(fieldNamed(pane, 'Unit') === null, 'shared settings are not on the card');
    check(pane.textContent.includes('Shares the settings of "Weather"'), 'says which connection it uses');
    fieldNamed(pane, 'City').value = 'Porto';
    fieldNamed(pane, 'Name').value = 'Holiday';
    await click(window, buttonNamed(pane, 'Save'));
    equal(lastRequest(device, '/api/cards/update').url, '/api/cards/update?key=weather%3A1', 'url');
    equal(lastRequest(device, '/api/cards/update').body, { name: 'Holiday', settings: { city: 'Porto' }, front: true, rotate: true }, 'body');
    check(!device.requests.some(r => r.url.startsWith('/api/connections/update')), 'the connection is left alone');
    equal(titles(document)[0], 'Holiday', 'new name shown');
    check(pane.hidden, 'on a phone saving goes back to the list');
});

test('a card leads to its connection, and a connection to its cards', async () => {
    const { window, document } = await openPage(makeDevice());
    await click(window, tile(document, 'PLUGIN|weather:2'));
    await click(window, document.querySelector('#card-pane .hint a'));
    equal(visiblePage(document), ['page-connections'], 'the link opens the connections page');
    const pane = document.getElementById('connection-pane');
    check(!pane.hidden, 'with that connection open');
    equal([...pane.querySelectorAll('.used-by button')].map(text), ['Lisbon', 'Home'], 'which lists its cards');
    await click(window, buttonNamed(pane, 'Lisbon'));
    equal(visiblePage(document), ['page-cards'], 'a card name goes back to the cards');
    equal(text(document.querySelector('#card-pane .pane-head h2')), 'Lisbon', 'with that card open');
});

test('edits a single-card plugin: secrets stay unless retyped', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, tile(document, 'PLUGIN|webhook:1'));
    const pane = document.getElementById('card-pane');
    equal(fieldNamed(pane, 'Webhook URL').value, 'http://example.com/hook', 'saved value');
    equal(fieldNamed(pane, 'Token').value, '', 'a secret is never shown');
    equal(fieldNamed(pane, 'Token').placeholder, 'Saved. Leave empty to keep it.', 'but it says one is saved');
    fieldNamed(pane, 'Button label').value = 'Ship';
    await click(window, buttonNamed(pane, 'Save'));
    equal(lastRequest(device, '/api/connections/update').body, { settings: { url: 'http://example.com/hook', label: 'Ship' } }, 'the untouched secret is not sent');
    equal(lastRequest(device, '/api/cards/update').body, { name: 'Webhook', settings: {}, front: true, rotate: true }, 'card request');
});

test('keeps what you typed while the page refreshes', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, tile(document, 'PLUGIN|weather:1'));
    const pane = document.getElementById('card-pane');
    fieldNamed(pane, 'City').value = 'Half typed';
    device.cards[0].title = 'Lisboa';
    await window.refresh();
    equal(fieldNamed(pane, 'City').value, 'Half typed', 'input survives');
    equal(titles(document)[0], 'Lisboa', 'while live parts still update');
    equal(text(pane.querySelector('.pane-head h2')), 'Lisboa', 'in the pane too');
});

test('moves a card earlier and later', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, tile(document, 'PLUGIN|weather:1'));
    const pane = document.getElementById('card-pane');
    check(buttonNamed(pane, 'Move earlier').disabled, 'the first card cannot move earlier');
    fieldNamed(pane, 'City').value = 'Typed';
    await click(window, buttonNamed(pane, 'Move later'));
    equal(lastRequest(device, '/api/cards/layout').body, ['PLUGIN|weather:2', 'PLUGIN|weather:1', 'PLUGIN|hello:1', 'PLUGIN|webhook:1', 'PLUGIN|posthog:1'], 'new order sent');
    equal(titles(document).slice(0, 2), ['Home', 'Lisbon'], 'and shown');
    equal(fieldNamed(pane, 'City').value, 'Typed', 'without losing what was typed');
    check(!buttonNamed(pane, 'Move earlier').disabled, 'now it can move back');
});

test('removes a card', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, tile(document, 'PLUGIN|hello:1'));
    await click(window, buttonNamed(document.getElementById('card-pane'), 'Remove card'));
    equal(lastRequest(device, '/api/cards/layout').body, ['PLUGIN|weather:1', 'PLUGIN|weather:2', 'PLUGIN|webhook:1', 'PLUGIN|posthog:1'], 'layout without the card');
    check(!titles(document).includes('Hello'), 'gone from the list');
    check(document.getElementById('card-pane').hidden, 'and the pane closes');
});

test('a card of a kind that no longer exists can only be removed', async () => {
    const device = makeDevice();
    device.cards.push({ type: 'INSIGHT', config: '99', name: 'Old insight' });
    const { window, document } = await openPage(device);
    equal(text(document.querySelector('#cards-list .item:last-child .item-sub')), 'No longer supported', 'it says so');
    await click(window, tile(document, 'INSIGHT|99'));
    const pane = document.getElementById('card-pane');
    check(pane.querySelector('.device') === null && buttonNamed(pane, 'Save') === undefined, 'nothing to set');
    await click(window, buttonNamed(pane, 'Remove card'));
    equal(lastRequest(device, '/api/cards/layout').body.length, 5, 'removed');
});

test('edits and deletes a connection', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#connections' });
    await click(window, document.querySelector('#connections-list .item[data-id="posthog"] .item-open'));
    const pane = document.getElementById('connection-pane');
    equal(fieldNamed(pane, 'Name').value, 'Work', 'name');
    fieldNamed(pane, 'API key').value = 'phx_new';
    await click(window, buttonNamed(pane, 'Save'));
    equal(lastRequest(device, '/api/connections/update').body, { name: 'Work', settings: { host: 'https://eu.posthog.com', key: 'phx_new' } }, 'update');

    await click(window, document.querySelector('#connections-list .item[data-id="weather"] .item-open'));
    equal(fieldNamed(pane, 'Unit').tagName, 'SELECT', 'options become a dropdown');
    await click(window, buttonNamed(pane, 'Delete connection'));
    equal(lastRequest(device, '/api/connections/remove').url, '/api/connections/remove?id=weather', 'remove');
    equal(titles(document), ['Hello', 'Webhook', 'Insight'], 'its cards are gone');
    check(pane.hidden, 'and the pane closes');
});

test('plugins page: lists plugins, edits and saves source', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#plugins' });
    const rows = [...document.querySelectorAll('#plugins-list .item')];
    equal(rows.length, 6, 'all plugins listed');
    check(rows[5].textContent.includes('Does not load: broken:3'), 'load errors are shown');
    check(rows[3].textContent.includes('Cards: City'), 'card kinds are shown');
    check(document.getElementById('plugin-editor').hidden, 'no editor until a plugin is picked');

    await click(window, rows[1].querySelector('.item-open'));
    check(!document.getElementById('plugin-editor').hidden, 'the editor opens');
    equal(text(document.getElementById('plugin-heading')), 'hello.lua', 'named after the file');
    check(document.getElementById('plugin-name-field').hidden, 'an existing plugin keeps its name');
    equal(document.getElementById('plugin-source').value, 'plugin = { name = "Hello" }\n', 'source loaded');
    equal(document.getElementById('plugin-gutter').textContent, '1\n2\n', 'line numbers');
    equal(document.getElementById('plugin-result').textContent, 'Running (12 KB of memory).', 'status');
    equal(document.getElementById('plugin-log').textContent, 'hi\nthere', 'log');
    check(rows[1].classList.contains('selected'), 'the open plugin is marked in the list');

    const source = document.getElementById('plugin-source');
    source.value = 'plugin = {}\n\nfunction draw() end\n';
    source.dispatchEvent(new window.Event('input'));
    equal(document.getElementById('plugin-gutter').textContent, '1\n2\n3\n4\n', 'line numbers follow the code');
    // Ctrl+S saves, like the button.
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));
    await settle(window);
    const put = lastRequest(device, '/api/plugins/hello');
    equal([put.method, put.type, put.body], ['PUT', 'application/octet-stream', 'plugin = {}\n\nfunction draw() end\n'], 'upload is not sent as text/plain');
});

test('plugins page: starts a new plugin and deletes one', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#plugins' });
    await click(window, document.getElementById('new-plugin-btn'));
    check(!document.getElementById('plugin-name-field').hidden, 'a new plugin asks for a name');
    check(document.getElementById('delete-plugin-btn').hidden, 'and has nothing to delete yet');
    await click(window, document.getElementById('save-plugin-btn'));
    check(document.getElementById('plugin-result').textContent.startsWith('Names are'), 'a name is required');
    document.getElementById('plugin-name').value = 'counter';
    await click(window, document.getElementById('save-plugin-btn'));
    equal(lastRequest(device, '/api/plugins/counter').method, 'PUT', 'saved under its name');
    check(device.cards.some(card => card.plugin === 'counter'), 'a plugin you write gets a first card, to see it run');
    equal(text(document.getElementById('plugin-heading')), 'counter.lua', 'the editor now shows the file');

    await click(window, document.querySelector('#plugins-list .item[data-name="weather"] .item-open'));
    await click(window, document.getElementById('delete-plugin-btn'));
    equal(lastRequest(device, '/api/plugins/weather').method, 'DELETE', 'deleted');
    check(document.getElementById('plugin-editor').hidden, 'the editor closes');
    equal(titles(document), ['Hello', 'Webhook', 'Insight', 'My plugin'], 'its cards are gone');
});

// ------------------------------------------------------ plugin directory

const offers = document => [...document.querySelectorAll('#directory-pane .offer')].map(row => ({
    name: row.dataset.name,
    title: text(row.querySelector('.item-title')),
    note: text(row.querySelector('.actions small')),
    buttons: [...row.querySelectorAll('.actions button')].map(text),
}));
const offer = (document, name) => document.querySelector('#directory-pane .offer[data-name="' + name + '"]');
/** Installing waits a moment for the device to look at the new file. */
const afterInstall = async window => { await new Promise(resolve => window.setTimeout(resolve, 750)); await settle(window); };

test('directory: shows what there is and how it relates to the device', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    equal(device.outside, [], 'nothing is fetched from the internet while nobody looks');
    await click(window, document.getElementById('cards-get-plugins-btn'));
    equal(visiblePage(document), ['page-plugins'], 'the button beside "Add card" goes to the plugins page');
    check(!document.getElementById('directory-pane').hidden, 'where the directory is in plain sight');
    equal(device.outside, ['https://raw.githubusercontent.com/TimBroddin/DeskHog/HEAD/plugins/index.json'], 'the browser fetches the index from GitHub');
    check(!device.requests.some(r => r.url.includes('github')), 'the device is not asked to');
    equal(offers(document), [
        { name: 'clock', title: 'Clock', note: null, buttons: ['Install'] },
        { name: 'hello', title: 'Hello', note: 'Installed', buttons: ['Add a card'] },
        { name: 'weather', title: 'Weather', note: 'You have 1.0', buttons: ['Update to 1.1', 'Add a card'] },
        { name: 'webhook', title: 'Webhook', note: 'Changed on this device', buttons: ['Replace with this one', 'Add a card'] },
    ], 'each plugin says what can be done with it');
    equal(offer(document, 'clock').querySelector('a').href, 'https://github.com/TimBroddin/DeskHog/blob/HEAD/plugins/clock.lua', 'and links to its code');
    check(text(offer(document, 'clock')).includes('By DeskHog, version 1.0'), 'with who wrote it');
    equal(offer(document, 'clock').querySelector('img.shot').src, 'https://raw.githubusercontent.com/TimBroddin/DeskHog/HEAD/plugins/screenshots/clock.png', 'and a picture of its card, from the directory');
    check(!offer(document, 'hello').querySelector('img'), 'a plugin without a picture has none');
    offer(document, 'weather').querySelector('img.shot').dispatchEvent(new window.Event('error'));
    check(!offer(document, 'weather').querySelector('img'), 'a picture that does not load goes away');
    equal(window.shotAddress({ screenshot: 'https://elsewhere.example/x.png' }), null, 'a picture has to be a file in the directory');
    equal(window.shotAddress({ screenshot: '../x.png' }), null, 'and not outside it');
    equal(window.location.hash, '#plugins', 'the address remembers the page');

    await click(window, document.querySelector('#plugins-list .item .item-open'));
    check(document.getElementById('directory-pane').hidden && !document.getElementById('plugin-editor').hidden, 'opening a plugin\'s code replaces it');
    await click(window, document.getElementById('close-plugin-btn'));
    check(!document.getElementById('directory-pane').hidden && offers(document).length === 4, 'and closing the code brings it back');

    const straight = await openPage(makeDevice(), { hash: '#plugins' });
    equal(offers(straight.document).length, 4, 'opening the plugins page shows it without asking');
});

test('directory: installs a plugin, then offers a card of it', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#plugins/~directory' });
    await click(window, buttonNamed(offer(document, 'clock'), 'Install'));
    await afterInstall(window);
    const put = lastRequest(device, '/api/plugins/clock');
    equal([put.method, put.type, put.body], ['PUT', 'application/octet-stream', device.internet.files['clock.lua']], 'the file goes to the device as it is');
    equal(put.url, '/api/plugins/clock?card=no', 'without the first card a developer\'s upload gets');
    check(!device.cards.some(card => card.plugin === 'clock'), 'so installing adds no card');
    equal(text(document.getElementById('notice')), 'Clock is on your DeskHog.', 'says so');
    equal(offers(document)[0], { name: 'clock', title: 'Clock', note: 'Installed', buttons: ['Add a card'] }, 'now it is installed');
    check([...document.querySelectorAll('#plugins-list .item-title')].map(text).includes('Clock'), 'and in the list of plugins');

    await click(window, buttonNamed(offer(document, 'clock'), 'Add a card'));
    equal(visiblePage(document), ['page-cards'], 'goes to the cards');
    equal(text(document.querySelector('#card-pane .pane-head h2')), 'New card: Clock', 'with the new card ready to add');
});

test('adding a card offers what the directory has, and installs it on the way', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, document.getElementById('add-card-btn'));
    const pane = document.getElementById('card-pane');
    const more = () => [...pane.querySelectorAll('.choices.more .choice')];
    equal(more().map(choice => choice.dataset.name), ['clock'], 'the one plugin this device does not have yet');
    check(text(more()[0]).includes('The time in large digits'), 'with what it is');
    equal(more()[0].querySelector('img.shot').src, 'https://raw.githubusercontent.com/TimBroddin/DeskHog/HEAD/plugins/screenshots/clock.png', 'and its picture');
    const webhook = [...pane.querySelectorAll('.choices:not(.more) .choice')].find(choice => text(choice).startsWith('Webhook'));
    check(webhook.querySelector('img.shot') !== null, 'installed ones show their picture too');

    await click(window, more()[0]);
    await afterInstall(window);
    equal(lastRequest(device, '/api/plugins/clock').url, '/api/plugins/clock?card=no', 'choosing it installs the plugin');
    equal(text(pane.querySelector('.pane-head h2')), 'New card: Clock', 'and carries on with the new card');
    await click(window, buttonNamed(pane, 'Add card'));
    check(titles(document).includes('Clock'), 'which is added');

    const offline = makeDevice();
    offline.internet = null;
    const second = await openPage(offline);
    await click(second.window, second.document.getElementById('add-card-btn'));
    const choices = [...second.document.querySelectorAll('#card-pane .choice b')].map(text);
    equal(choices, ['Max', 'Hello', 'Webhook', 'City', 'Funnel', 'Insight'], 'without internet the installed ones are still offered');
    check(text(second.document.getElementById('card-pane')).includes('needs internet'), 'and it says why there are no more');
});

test('directory: updates a plugin and replaces a changed one', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#plugins/~directory' });
    await click(window, buttonNamed(offer(document, 'weather'), 'Update to 1.1'));
    await afterInstall(window);
    equal(lastRequest(device, '/api/plugins/weather').body, device.internet.files['weather.lua'], 'new source sent');
    equal(offers(document)[2].note, 'Installed', 'up to date now');
    await click(window, buttonNamed(offer(document, 'webhook'), 'Replace with this one'));
    await afterInstall(window);
    equal(offers(document)[3].note, 'Installed', 'the changed one is back to the published text');
});

test('directory: can come from another repository or address', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#plugins/~directory' });
    const pane = document.getElementById('directory-pane');
    check(text(pane.querySelector('.source-line')).includes('TimBroddin/DeskHog'), 'says where it comes from');
    await click(window, buttonNamed(pane, 'Change'));
    check(buttonNamed(pane, 'Back to') === undefined, 'nothing to go back to while it is the default');
    fieldNamed(pane, 'Plugin directory').value = 'not a directory';
    await click(window, buttonNamed(pane, 'Use this directory'));
    check(!device.requests.some(r => r.url === '/api/directory'), 'nonsense is not saved');
    check(document.getElementById('notice').className.includes('error'), 'and is explained');

    fieldNamed(pane, 'Plugin directory').value = 'https://plugins.example/';
    await click(window, buttonNamed(pane, 'Use this directory'));
    equal(lastRequest(device, '/api/directory').body, { source: 'https://plugins.example/' }, 'the device remembers it');
    equal(device.outside[device.outside.length - 1], 'https://plugins.example/index.json', 'and the list comes from there');
    equal(offers(document).length, 4, 'listed');
    equal(offer(document, 'clock').querySelector('a').href, 'https://plugins.example/clock.lua', 'code links go to the file itself');
    await click(window, buttonNamed(pane, 'Change'));
    await click(window, buttonNamed(pane, 'Back to TimBroddin/DeskHog'));
    equal(lastRequest(device, '/api/directory').body, { source: '' }, 'and can go back to the default');

    equal(window.directoryAddress('acme/hogs@dev').index, 'https://raw.githubusercontent.com/acme/hogs/dev/plugins/index.json', 'a branch can be named');
    equal(window.directoryAddress('just-a-word'), null, 'one word is not a repository');
    equal(window.sourceHash(new window.Uint8Array(Buffer.from('plugin = {}\n'))), sourceHash('plugin = {}\n'), 'fingerprints match the device\'s');
});

test('directory: says what is wrong when it cannot be used', async () => {
    const device = makeDevice();
    device.internet = null;
    const { window, document } = await openPage(device, { hash: '#plugins/~directory' });
    const pane = document.getElementById('directory-pane');
    check(text(pane.querySelector('.result.error')).includes('needs internet on the computer or phone'), 'no connection');
    device.internet = { index: { plugins: 'oops' }, files: {} };
    await click(window, buttonNamed(pane, 'Try again'));
    check(text(pane.querySelector('.result.error')).includes('is not a plugin directory'), 'not a directory');

    const good = makeDevice();
    good.internet.files['clock.lua'] += '-- changed after the index was written\n';
    const second = await openPage(good, { hash: '#plugins/~directory' });
    await click(second.window, buttonNamed(offer(second.document, 'clock'), 'Install'));
    check(text(second.document.getElementById('notice')).includes('is not the file the directory describes'), 'a file that does not match its index is refused');
    check(!good.requests.some(r => r.method === 'PUT'), 'and not sent to the device');
});

test('a card whose plugin is not on the device offers to install it', async () => {
    const device = makeDevice();
    device.connections.push({ id: 'clock', plugin: 'clock', name: 'clock', settings: {}, secretsSet: [], state: 'failed', error: 'the plugin "clock" is not installed' });
    device.cards.push({ type: 'PLUGIN', config: 'clock:1', name: 'clock', plugin: 'clock', connection: 'clock', card: '1', kind: '', settings: {}, frames: 1, onScreen: false });
    const { window, document } = await openPage(device);
    equal(text(document.querySelector('#cards-list .item:last-child .item-sub')), 'Its plugin is missing', 'the card says so');
    await click(window, tile(document, 'PLUGIN|clock:1'));
    const pane = document.getElementById('card-pane');
    check(text(pane).includes('needs the plugin "clock"'), 'and which one');
    await click(window, buttonNamed(pane, 'Install clock'));
    await afterInstall(window);
    equal(lastRequest(device, '/api/plugins/clock').method, 'PUT', 'installed from the directory');
    check(fieldNamed(pane, 'Name') !== null, 'and the card can be set up now');
});

test('a new device with nothing on it leads to the directory', async () => {
    const device = makeDevice();
    device.plugins = [];
    device.connections = [];
    device.cards = [];
    const { window, document } = await openPage(device);
    await click(window, buttonNamed(document.getElementById('cards-list'), 'Get plugins'));
    equal(visiblePage(document), ['page-plugins'], 'the plugins page');
    equal(offers(document).map(o => o.buttons[0]), ['Install', 'Install', 'Install', 'Install'], 'with everything on offer');
    await click(window, buttonNamed(offer(document, 'hello'), 'Install'));
    await afterInstall(window);
    await click(window, buttonNamed(offer(document, 'hello'), 'Add a card'));
    await click(window, buttonNamed(document.getElementById('card-pane'), 'Add card'));
    equal(titles(document), ['Hello'], 'first card added');
});

test('offline: wifi setup comes first and connects', async () => {
    const device = makeDevice();
    device.wifiConnected = false;
    const { window, document } = await openPage(device);
    check(!document.getElementById('wifi-setup').hidden, 'setup panel shown');
    check(document.getElementById('wifi-panel').hidden, 'and not a second time on the device page');
    equal(text(document.getElementById('wifi-pill')), 'No WiFi', 'pill');
    const networks = [...document.querySelectorAll('#wifi-form .network span')].map(text);
    equal(networks, ['Home WiFi', 'Cafe'], 'one row per name, strongest first, unnamed ones dropped');
    await click(window, document.querySelector('#wifi-form .network'));
    document.querySelector('#wifi-form input[type="password"]').value = 'hunter2';
    await click(window, buttonNamed(document.getElementById('wifi-form'), 'Connect'));
    equal(lastRequest(device, '/api/actions/save-wifi').body, { ssid: 'Home WiFi', password: 'hunter2' }, 'credentials sent');
    check(document.getElementById('notice').textContent.includes('is joining "Home WiFi"'), 'says what happens next');
});

test('the device page sets the time zone', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    const select = document.getElementById('timezone-select');
    check(select !== null, 'there is a dropdown');
    equal(select.value, 'UTC', 'a new device is on UTC');
    check(select.querySelectorAll('option').length > 300, 'with the places of the world in it');
    equal([...select.querySelectorAll('optgroup')].map(group => group.label).slice(0, 3), ['Universal', 'Africa', 'America'], 'by continent');
    equal(text(select.querySelector('option[value="America/Argentina/Buenos_Aires"]')), 'Argentina, Buenos Aires', 'names read like places');

    select.value = 'Europe/Brussels';
    select.dispatchEvent(new window.Event('change'));
    await settle(window);
    equal(lastRequest(device, '/api/timezone').body, { posix: 'CET-1CEST,M3.5.0,M10.5.0/3', name: 'Europe/Brussels' }, 'the device gets the POSIX string and the name');
    equal(document.getElementById('timezone-select').value, 'Europe/Brussels', 'and the page shows what was picked');
    check(document.getElementById('notice').textContent.includes('Time zone saved'), 'and says so');

    // Amsterdam has the same rules as Brussels: the name that was picked is the one shown.
    device.timezone = { posix: 'CET-1CEST,M3.5.0,M10.5.0/3', name: 'Europe/Amsterdam' };
    await window.refresh();
    equal(document.getElementById('timezone-select').value, 'Europe/Amsterdam', 'the picked name wins over other places with the same rules');

    // A zone set through the API, which the list has no place for.
    device.timezone = { posix: '<+0123>-1:23', name: '' };
    await window.refresh();
    const custom = document.getElementById('timezone-select');
    equal(custom.value, '=<+0123>-1:23', 'an unknown zone is shown as it is');
    equal(window.zoneValue(custom), { posix: '<+0123>-1:23', name: '' }, 'and kept as it is');

    // The page offers the zone of the computer it is shown on.
    const here = window.browserZone();
    if (here) {
        await click(window, buttonNamed(document.getElementById('timezone-form'), 'Use '));
        equal(lastRequest(device, '/api/timezone').body.name, here, 'one click sets it');
    }
});

test('a time zone setting of a card is a dropdown that saves a POSIX string', async () => {
    const device = makeDevice();
    // What the firmware reports for a plugin setting written as { label = "Time zone", type = "timezone" }.
    device.plugins.find(p => p.name === 'weather').kinds[0].config.push({ key: 'zone', label: 'Time zone', type: 'timezone', default: '' });
    const { window, document } = await openPage(device);
    await click(window, tile(document, 'PLUGIN|weather:1'));
    const pane = document.getElementById('card-pane');
    const zone = fieldNamed(pane, 'Time zone');
    equal(zone.tagName, 'SELECT', 'a dropdown, not a text field');
    equal(zone.value, '', 'nothing saved: the device\'s own zone');
    equal(text(zone.querySelector('option')), 'Same as the DeskHog', 'which is the first choice');
    zone.value = 'Asia/Tokyo';
    await click(window, buttonNamed(pane, 'Save'));
    equal(lastRequest(device, '/api/cards/update').body.settings.zone, 'JST-9', 'the plugin gets the POSIX string');

    await click(window, tile(document, 'PLUGIN|weather:1'));
    const again = fieldNamed(document.getElementById('card-pane'), 'Time zone');
    equal(window.zoneValue(again).posix, 'JST-9', 'reopened, it shows a place with those rules');
    again.value = '';
    await click(window, buttonNamed(document.getElementById('card-pane'), 'Save'));
    equal(lastRequest(device, '/api/cards/update').body.settings.zone, '', 'back to the device\'s zone');
});

test('every plugin card can be told not to come to the front', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, tile(document, 'PLUGIN|hello:1'));
    const pane = document.getElementById('card-pane');
    const front = [...pane.querySelectorAll('label.field.check')].find(l => l.textContent.startsWith('May come to the front'));
    check(!!front, 'a card of a plugin without any settings still has the setting');
    const box = front.querySelector('input[type="checkbox"]');
    check(box.checked, 'on unless someone switched it off');
    box.checked = false;
    await click(window, buttonNamed(pane, 'Save'));
    equal(lastRequest(device, '/api/cards/update?key=hello%3A1').body.front, false, 'saved with the card');
    equal(device.cards.find(c => c.config === 'hello:1').front, false, 'the device has it');

    // It is the device's own setting, so it shows what the device says.
    const again = await openPage(device);
    await click(again.window, tile(again.document, 'PLUGIN|hello:1'));
    const shown = [...again.document.querySelectorAll('#card-pane label.field.check')].find(l => l.textContent.startsWith('May come to the front'));
    check(!shown.querySelector('input').checked, 'and it is shown as saved');
    await click(again.window, tile(again.document, 'PLUGIN|weather:2'));
    const other = [...again.document.querySelectorAll('#card-pane label.field.check')].find(l => l.textContent.startsWith('May come to the front'));
    check(other.querySelector('input').checked, 'other cards keep theirs');
    await click(again.window, buttonNamed(again.document.getElementById('card-pane'), 'Save'));
    equal(lastRequest(device, '/api/cards/update?key=weather%3A2').body.front, true, 'a card that may is saved as such');
});

test('a card with something to tell says so in the list', async () => {
    const device = makeDevice();
    device.notifications = [{ card: 'weather:2', text: 'Rain in 10 minutes', count: 2, age: 40 }, { card: 'hello:1', text: '', count: 1, age: 3 }];
    const { document } = await openPage(device);
    const subs = [...document.querySelectorAll('#cards-list .item-sub')].map(text);
    equal(subs[1], 'Weather, has news: Rain in 10 minutes', 'the waiting text is in the subtitle');
    equal(subs[2], 'has news', 'a notify() without text still counts');
    equal(subs[0], 'Weather, on screen now', 'cards with nothing waiting are as before');
});

/** The parts of a field whose choices the plugin lists. */
const pickOf = (scope, label) => {
    const wrap = [...scope.querySelectorAll('label.field')].find(l => l.querySelector('span').textContent === label);
    return wrap && {
        wrap, text: wrap.querySelector('input[type="text"]'), select: wrap.querySelector('select'),
        refresh: buttonNamed(wrap, 'Refresh'), note: wrap.querySelector('small').textContent,
    };
};

test('a setting the plugin lists the choices for is a dropdown with a refresh button', async () => {
    const device = addHomey(makeDevice());
    const { window, document, errors } = await openPage(device);
    window.choicePollDelay = () => 0;
    await click(window, tile(document, 'PLUGIN|homey:1'));
    await settle(window);
    const pane = document.getElementById('card-pane');
    let pick = pickOf(pane, 'Device');
    check(!pick.select.hidden && pick.text.hidden, 'the list arrived: a dropdown, not a text box');
    equal([...pick.select.options].map(o => o.value + '=' + o.textContent), ['=—', 'lamp=Kitchen lamp', 'plug=Coffee machine'],
        'what the plugin offers, by label, and a way to empty a setting that may be empty');
    equal(pick.select.value, 'lamp', 'the saved value is selected');
    equal(pick.note, '', 'nothing to explain');
    const asked = device.requests.filter(r => r.url.startsWith('/api/connections/choices'));
    const address = '/api/connections/choices?id=homey&field=device&kind=device&settings=' + encodeURIComponent('{"device":"lamp","label":""}');
    equal(asked.map(r => r.url), [address, address], 'asks the device, with what the form holds, and again while the plugin is still working on it');

    // Picking one saves its value, not its label.
    pick.select.value = 'plug';
    await click(window, buttonNamed(pane, 'Save'));
    equal(lastRequest(device, '/api/cards/update?key=homey%3A1').body.settings, { device: 'plug', label: '' }, 'the value is what is saved');

    // Refresh asks the plugin again.
    await click(window, tile(document, 'PLUGIN|homey:1'));
    await settle(window);
    pick = pickOf(document.getElementById('card-pane'), 'Device');
    device.choices['homey/device/device'] = [{ value: 'lamp', label: 'Kitchen lamp' }, { value: 'tv', label: 'Television' }];
    await click(window, pick.refresh);
    await settle(window);
    equal([...pick.select.options].map(o => o.textContent), ['—', 'plug (not in the list)', 'Kitchen lamp', 'Television'], 'a fresh list; what is saved stays even if the plugin dropped it');
    equal(pick.select.value, 'plug', 'and stays selected');
    equal(errors, [], 'no script errors');
});

test('without a list a setting with choices is plain text', async () => {
    const device = addHomey(makeDevice());
    device.cards.push({ type: 'PLUGIN', config: 'homey:2', name: 'Flow', plugin: 'homey', connection: 'homey', card: '2', kind: 'flow', settings: { flow: 'f-17' }, frames: 1, onScreen: false });
    const { window, document } = await openPage(device);
    window.choicePollDelay = () => 0;
    await click(window, tile(document, 'PLUGIN|homey:2'));
    await settle(window);
    const pane = document.getElementById('card-pane');
    const pick = pickOf(pane, 'Flow');
    check(pick.select.hidden && !pick.text.hidden, 'the plugin could not say: a text box');
    equal(pick.text.value, 'f-17', 'with the saved value in it');
    check(pick.note.includes('log in to Homey first') && pick.note.includes('type the value'), 'and why, in the plugin\'s words');
    pick.text.value = 'f-18';
    await click(window, buttonNamed(pane, 'Save'));
    equal(lastRequest(device, '/api/cards/update?key=homey%3A2').body.settings, { flow: 'f-18' }, 'what was typed is saved');

    // Once the plugin can say, Refresh turns it into a dropdown.
    await click(window, tile(document, 'PLUGIN|homey:2'));
    await settle(window);
    const later = pickOf(document.getElementById('card-pane'), 'Flow');
    device.choices['homey/flow/flow'] = [{ value: 'f-18', label: 'Good morning' }];
    await click(window, later.refresh);
    await settle(window);
    check(!later.select.hidden && later.text.hidden, 'a dropdown after all');
    equal(later.select.value, 'f-18', 'with what was typed selected');
});

test('choices when adding a card: from the connection it joins, typed for a new one', async () => {
    const device = addHomey(makeDevice());
    const { window, document } = await openPage(device);
    window.choicePollDelay = () => 0;
    await click(window, document.getElementById('add-card-btn'));
    const pane = document.getElementById('card-pane');
    await click(window, [...pane.querySelectorAll('.choice')].find(c => c.textContent.startsWith('Device')));
    await settle(window);
    let pick = pickOf(pane, 'Device');
    check(!pick.select.hidden, 'a card for an existing connection gets that connection\'s list');
    equal([...pick.select.options].map(o => o.textContent), ['—', 'Kitchen lamp', 'Coffee machine'], 'with nothing picked yet');
    pick.select.value = 'plug';
    await click(window, buttonNamed(pane, 'Add card'));
    const added = lastRequest(device, '/api/cards/add').body;
    equal([added.connection, added.kind, added.settings.device], ['homey', 'device', 'plug'], 'the card is added with the value that was picked');

    // A new connection does not exist on the device yet, so there is nobody to ask.
    await click(window, document.getElementById('add-card-btn'));
    await click(window, [...pane.querySelectorAll('.choice')].find(c => c.textContent.startsWith('Device')));
    await settle(window);
    const connection = fieldNamed(pane, 'Connection');
    connection.value = '';
    connection.dispatchEvent(new window.Event('change'));
    await settle(window);
    pick = pickOf(pane, 'Device');
    check(pick.select.hidden && !pick.text.hidden && pick.refresh.hidden, 'a text box, and nothing to refresh');
    check(pick.note.startsWith('Type it for now'), 'that says the list comes later');
    const home = pickOf(pane, 'Home');
    check(home.select.hidden && home.note.startsWith('Type it for now'), 'the same for the new connection\'s own settings');

    // On the connections page the connection exists, so its own setting has a list.
    await click(window, document.querySelector('.tabs a[data-page="connections"]'));
    await click(window, [...document.querySelectorAll('#connections-list .item-open')].find(b => b.textContent.startsWith('Homey')));
    await settle(window);
    const own = pickOf(document.getElementById('connection-pane'), 'Home');
    check(!own.select.hidden, 'a connection\'s own setting gets its list');
    check(device.requests.some(r => r.url.startsWith('/api/connections/choices?id=homey&field=home&settings=')), 'asked for without a card kind');
});

test('a list of choices is asked for with what the form holds, saved or not', async () => {
    const device = addHomey(makeDevice());
    const flowKind = device.plugins.find(p => p.name === 'homey').kinds.find(k => k.key === 'flow');
    const field = (key, label, extra) => Object.assign({ key, label, type: 'string', default: '' }, extra);
    flowKind.config.push(field('advanced', 'Advanced flows', { type: 'boolean', default: 'false' }), field('token', 'Token', { secret: true }),
        field('room', 'Room', { choices: true, default: 'hall' }));
    device.cards.push({ type: 'PLUGIN', config: 'homey:2', name: 'Flow', plugin: 'homey', connection: 'homey', card: '2', kind: 'flow', settings: { flow: 'a-1' }, frames: 1, onScreen: false });
    // A plugin that lists one kind of flow or the other, going by the checkbox next to the list.
    device.choices['homey/flow/flow'] = form => form.advanced === 'true' ? [{ value: 'a-1', label: 'Party mode' }] : [{ value: 'f-1', label: 'Good morning' }];
    device.choices['homey/flow/room'] = [{ value: 'hall', label: 'Hall' }];
    const { window, document, errors } = await openPage(device);
    window.choicePollDelay = () => 0;
    await click(window, tile(document, 'PLUGIN|homey:2'));
    await settle(window);
    const pane = document.getElementById('card-pane');
    const pick = pickOf(pane, 'Flow');
    equal(device.choiceForms.find(asked => asked.key === 'homey/flow/flow').form, { flow: 'a-1', advanced: 'false', room: 'hall' },
        'the first list is asked for with the saved values and the defaults');
    equal([...pick.select.options].map(o => o.textContent), ['—', 'a-1 (not in the list)', 'Good morning'], 'and is the one that goes with them');
    equal([...pickOf(pane, 'Room').select.options].map(o => o.textContent), ['Hall'], 'a setting with a default has no empty entry');

    // Tick the box, type a secret, Refresh: the plugin hears about the box, not about the secret.
    fieldNamed(pane, 'Advanced flows').checked = true;
    fieldNamed(pane, 'Token').value = 'hunter2';
    await click(window, pick.refresh);
    await settle(window);
    equal(device.choiceForms[device.choiceForms.length - 1].form, { flow: 'a-1', advanced: 'true', room: 'hall' }, 'what is in the form now, unsaved, without secrets');
    equal([...pick.select.options].map(o => o.textContent), ['—', 'Party mode'], 'so the list follows the other setting');
    equal(pick.select.value, 'a-1', 'and the saved flow is found in it');
    check(!device.requests.some(r => r.url.includes('hunter2')), 'a secret is never put in an address');

    // Picking the empty entry saves an empty setting.
    pick.select.value = '';
    await click(window, buttonNamed(pane, 'Save'));
    equal(lastRequest(device, '/api/cards/update?key=homey%3A2').body.settings.flow, '', 'the setting can be emptied');
    equal(device.handle('GET', '/api/connections/choices?id=homey&field=home&settings=nope').status, 400, 'settings has to be JSON');
    equal(errors, [], 'no script errors');
});

test('the pretend device takes pushed messages like the firmware', async () => {
    const device = addHomey(makeDevice());
    equal(device.handle('POST', '/api/cards/message?key=homey:1', 'Pizza is here').status, 200, 'a card whose kind has message() takes one');
    equal(device.handle('POST', '/api/connections/message?id=homey', { door: 'open' }).status, 200, 'and so does the plugin itself');
    equal(device.messages, [{ card: 'homey:1', body: 'Pizza is here' }, { connection: 'homey', body: '{"door":"open"}' }], 'text and JSON arrive as sent');
    equal(device.handle('POST', '/api/cards/message?key=hello:1', 'x').status, 404, 'a plugin without message() answers 404');
    equal(device.handle('POST', '/api/cards/message?key=nope:1', 'x').status, 404, 'so does a card that is not there');
    equal(device.handle('POST', '/api/cards/message?key=homey:1', 'x'.repeat(5000)).status, 413, 'more than 4 KB is refused');
    equal(device.handle('GET', '/api/cards/message?key=homey:1').status, 405, 'only POST');
    for (let i = 0; i < 6; i++) device.handle('POST', '/api/connections/message?id=homey', 'again');
    equal(device.handle('POST', '/api/connections/message?id=homey', 'one too many').status, 429, 'at most 8 wait at a time');
    equal(device.handle('GET', '/api/connections/choices?id=homey&field=url').status, 404, 'a setting without choices has no list');
    equal(device.handle('GET', '/api/connections/choices?id=nope&field=home').status, 404, 'nor does a connection that is not there');
});

// ---- the device's own settings

const slidersOf = document => [...document.querySelectorAll('#display-form input[type="range"]')];
const move = async (window, input, value, type) => { input.value = String(value); input.dispatchEvent(new window.Event(type, { bubbles: true })); await settle(window); };
const rowOf = (document, label) => [...document.querySelectorAll('#about-list dt')].find(dt => dt.textContent === label);

test('shows the device\'s settings', async () => {
    const device = makeDevice();
    const { document } = await openPage(device, { hash: '#device' });
    equal(slidersOf(document).map(s => s.value), ['80', '10', '100', '0'], 'screen and LED, by day and at night');
    equal([...document.querySelectorAll('#display-form output')].map(text), ['80%', '10%', '100%', 'off'], 'with their values beside them');
    const [enabled, from, until] = document.querySelectorAll('#display-form .times input');
    check(!enabled.checked, 'night hours are off');
    equal([from.value, until.value], ['22:00', '07:00'], 'from 22:00 until 07:00');
    equal(document.querySelector('#display-form select').selectedOptions[0].textContent, 'Off', 'the rotation is off');
    equal(document.title, 'DeskHog', 'the title is as before at the default name');
    equal(document.querySelector('[data-brand]').textContent, 'DeskHog', 'and so is the header');
});

test('an older device without settings has no such panels', async () => {
    const device = makeDevice();
    const original = device.state;
    device.state = () => { const { device: gone, ...rest } = original(); return rest; };
    const { document, errors } = await openPage(device, { hash: '#device' });
    equal(errors, [], 'nothing breaks');
    for (const id of ['display-panel', 'name-panel', 'battery-panel', 'restart-btn']) check(document.getElementById(id).hidden, id + ' is left out');
    const { window } = await openPage(device);
    await click(window, tile(window.document, 'PLUGIN|hello:1'));
    check(!window.document.getElementById('card-pane').textContent.includes('Skip in rotation'), 'and cards have no rotation setting');
    await click(window, buttonNamed(window.document.getElementById('card-pane'), 'Save'));
    check(!('rotate' in lastRequest(device, '/api/cards/update').body), 'which is not sent');
});

test('a slider saves its level', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    await move(window, slidersOf(document)[0], 60, 'change');
    equal(lastRequest(device, '/api/device').body, { screen: { day: 60 } }, 'only that level is sent');
    equal(device.device.screen.day, 60, 'the device has it');
    equal(document.querySelector('#display-form output').textContent, '60%', 'and the page shows it');
});

test('dragging a night slider previews it', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    await move(window, slidersOf(document)[1], 20, 'input');
    equal(lastRequest(device, '/api/device').body, { screen: { night: 20 }, preview: 'night' }, 'the night level is shown');
    await move(window, slidersOf(document)[3], 30, 'input');
    equal(lastRequest(device, '/api/device').body, { led: { night: 30 }, preview: 'night' }, 'the LED too');
    const count = device.requests.length;
    await move(window, slidersOf(document)[2], 50, 'input');
    equal(device.requests.length, count + 1, 'a day slider is applied while it is dragged');
    equal(lastRequest(device, '/api/device').body, { led: { day: 50 } }, 'without a preview');
    // Faster than every 150 ms, only the last value follows.
    const before = device.requests.length;
    for (const value of [51, 52, 53]) await move(window, slidersOf(document)[2], value, 'input');
    equal(device.requests.length, before, 'a burst of moves is held back');
    await new Promise(resolve => window.setTimeout(resolve, 200));
    equal(lastRequest(device, '/api/device').body, { led: { day: 53 } }, 'and the last one is sent');
});

test('letting go of a night slider cancels its pending preview', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    const night = slidersOf(document)[1];
    await move(window, night, 20, 'input');
    await move(window, night, 25, 'input');
    await move(window, night, 25, 'change');
    await new Promise(resolve => window.setTimeout(resolve, 250));
    const posts = device.requests.filter(r => r.url.startsWith('/api/device'));
    equal(posts[posts.length - 1].body, { screen: { night: 25 } }, 'the last word is the save, not a preview');
    equal(posts.filter(r => r.body.preview).length, 1, 'and no preview follows it');
});

test('a poll does not undo a slider or a name that someone is working on', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    const slide = slidersOf(document)[0];
    slide.focus();
    await move(window, slide, 33, 'input');
    await move(window, slide, 34, 'input'); // held back for the next 150 ms
    await window.refresh();
    equal(slide.value, '34', 'a slider being dragged stays where it is, though the device has 33');
    slide.blur();
    await window.refresh();
    equal(slide.value, '34', 'and so does one let go before the device has caught up');
    await new Promise(resolve => window.setTimeout(resolve, 200));
    device.device.screen.day = 90;
    await window.refresh();
    equal(slide.value, '90', 'once the device has it, the page follows the device again');
    const name = document.querySelector('#name-form input');
    name.value = 'kitch';
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
    await window.refresh();
    equal(name.value, 'kitch', 'a half-typed name stays');
    equal(document.querySelector('#name-form small').textContent, 'http://deskhog.local', 'and the address stays that of the saved name');
    const other = slidersOf(document)[3];
    device.device.led.night = 40;
    await window.refresh();
    equal(other.value, '40', 'what nobody touches follows the device');
});

test('night hours are saved', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    const [enabled, from] = document.querySelectorAll('#display-form .times input');
    enabled.checked = true;
    enabled.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle(window);
    equal(lastRequest(device, '/api/device').body, { night: { enabled: true } }, 'switched on');
    await move(window, from, '23:15', 'change');
    equal(lastRequest(device, '/api/device').body, { night: { from: '23:15' } }, 'a new start');
    equal(device.device.night, { enabled: true, from: '23:15', until: '07:00' }, 'the device has both');
});

test('rotate offers fixed steps', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    const select = document.querySelector('#display-form select');
    equal([...select.options].map(text), ['Off', '15 s', '30 s', '1 min', '2 min', '5 min'], 'the steps');
    await move(window, select, 60, 'change');
    equal(lastRequest(device, '/api/device').body, { rotate: { seconds: 60 } }, 'one minute');
    device.device.rotate.seconds = 45;
    await window.refresh();
    equal([...select.options].map(text), ['Off', '15 s', '30 s', '45 s', '1 min', '2 min', '5 min'], 'a value set through the API gets its own step');
    equal(select.selectedOptions[0].textContent, '45 s', 'and shows');
});

test('renaming sends you to the new address', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    const name = document.querySelector('#name-form input');
    equal(document.querySelector('#name-form small').textContent, 'http://deskhog.local', 'the address is shown');
    name.value = 'kitchen';
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
    await click(window, buttonNamed(document.getElementById('name-form'), 'Save'));
    equal(lastRequest(device, '/api/device').body, { name: 'kitchen' }, 'the name is sent');
    check(document.getElementById('notice').textContent.includes('http://kitchen.local'), 'and the notice gives the address');
    equal(document.title, 'DeskHog · kitchen', 'the title shows the new name');
    equal(document.querySelector('[data-brand]').textContent, 'DeskHog · kitchen', 'and so does the header');
});

test('after a rename the page goes to the new .local address, not when opened by IP address', async () => {
    const to = (await openPage(makeDevice())).window.renamedAddress;
    const where = (hostname, hash) => ({ hostname, hash });
    equal(to('kitchen', where('deskhog.local', '#device')), 'http://kitchen.local/#device', 'from a .local address');
    equal(to('kitchen', where('deskhog.local', '')), 'http://kitchen.local/', 'without a hash');
    equal(to('kitchen', where('192.168.1.20', '#device')), null, 'from an IP address');
    equal(to('kitchen', where('localhost', '')), null, 'from anything else');

    for (const [origin, expected] of [['http://deskhog.local/', ['http://kitchen.local/#device']], ['http://192.168.1.20/', []]]) {
        const device = makeDevice();
        const { window, document } = await openPage(device, { hash: '#device', origin });
        const went = [];
        window.goTo = address => went.push(address);
        const name = document.querySelector('#name-form input');
        name.value = 'kitchen';
        name.dispatchEvent(new window.Event('input', { bubbles: true }));
        await click(window, buttonNamed(document.getElementById('name-form'), 'Save'));
        check(document.getElementById('notice').textContent.includes('http://kitchen.local'), origin + ': the notice shows first');
        equal(went, [], origin + ': nothing happens at once');
        await new Promise(resolve => window.setTimeout(resolve, 2100));
        equal(went, expected, origin + ': two seconds later');
    }
});

test('a bad name shows the device\'s reason', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    const name = document.querySelector('#name-form input');
    name.value = '-Kitchen';
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
    await click(window, buttonNamed(document.getElementById('name-form'), 'Save'));
    equal(document.getElementById('notice').textContent, 'name is not valid', 'the device\'s words');
    check(document.getElementById('notice').className.includes('error'), 'as an error');
    await window.refresh();
    equal(name.value, '-Kitchen', 'the field keeps what was typed, also through a refresh');
    equal(device.device.name, 'deskhog', 'the device is unchanged');
});

test('battery line only with a battery', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    equal(rowOf(document, 'Battery'), undefined, 'no row without a battery');
    check(document.querySelector('#battery-form small').textContent.includes('A battery gauge was found'), 'the panel says a gauge was found');
    device.device.status.gauge = { percent: 82, volts: 3.98, charging: true };
    const box = document.querySelector('#battery-form input');
    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle(window);
    equal(lastRequest(device, '/api/device').body, { battery: true }, 'ticked');
    equal(text(rowOf(document, 'Battery').nextSibling), '82%, charging', 'About shows the reading');
});

test('no battery panel hint without a gauge', async () => {
    const device = makeDevice();
    device.device.status.gauge = null;
    const { document } = await openPage(device, { hash: '#device' });
    check(document.querySelector('#battery-form input[type="checkbox"]') !== null, 'the tick box is there');
    check(document.querySelector('#battery-form small').textContent.includes('No battery gauge was found'), 'the hint says no gauge was found');
});

test('restart asks first', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    window.confirm = () => false;
    await click(window, document.getElementById('restart-btn'));
    check(!lastRequest(device, '/api/restart'), 'cancelled: nothing is sent');
    window.confirm = () => true;
    await click(window, document.getElementById('restart-btn'));
    equal(lastRequest(device, '/api/restart').method, 'POST', 'confirmed: the device is asked');
    equal(device.restarts, 1, 'once');
});

test('a newer firmware is offered and installed through the updater', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device' });
    window.firmwarePause = 0;
    check(device.outside.includes('https://raw.githubusercontent.com/TimBroddin/DeskHog/firmware/latest.json'), 'the browser asks GitHub for the newest release');
    check(text(document.getElementById('firmware-box')).includes('Firmware 0.5.0 is available'), 'the newer version is offered');
    equal(document.querySelector('#firmware-box a').href, 'https://example.com/notes', 'with a link to what is new');

    window.confirm = () => false;
    await click(window, document.getElementById('firmware-update'));
    check(!lastRequest(device, '/api/update/start'), 'cancelled: nothing happens');

    window.confirm = () => true;
    await click(window, document.getElementById('firmware-update'));
    for (let i = 0; i < 6; i++) await settle(window);
    equal(lastRequest(device, '/api/update/start').method, 'POST', 'the device is asked to restart into its updater');
    equal(device.firmware.installed, [{ size: '12', sha256: 'abc123' }], 'the updater gets the file, with its size and hash');
    equal(device.firmware.version, '0.5.0', 'the device runs the new firmware');
    check(text(document.getElementById('notice')).includes('now runs firmware 0.5.0'), 'the page says so');
    check(text(document.getElementById('firmware-box')).includes('This is the newest firmware'), 'and no longer offers it');
    check(!document.getElementById('firmware-update'), 'the button is gone');
});

test('the newest firmware can be installed again', async () => {
    const device = makeDevice();
    device.release.version = '0.4.0';
    const { window, document } = await openPage(device, { hash: '#device' });
    window.firmwarePause = 0;
    const button = document.getElementById('firmware-reinstall');
    equal(text(button), 'Reinstall firmware', 'up to date: the release can be installed again');
    let asked = '';
    window.confirm = question => { asked = question; return false; };
    await click(window, button);
    check(asked.includes('Install firmware 0.4.0 again?'), 'after a question that names the version');
    check(!lastRequest(device, '/api/update/start'), 'cancelled: nothing happens');

    window.confirm = () => true;
    await click(window, document.getElementById('firmware-reinstall'));
    for (let i = 0; i < 6; i++) await settle(window);
    equal(device.firmware.installed, [{ size: '12', sha256: 'abc123' }], 'the updater gets the release, with its size and hash');
    equal(device.firmware.version, '0.4.0', 'and the device runs it');
    check(document.getElementById('firmware-reinstall') !== null, 'the button stays');

    const own = makeDevice();
    own.release.version = '0.3.0';
    const second = await openPage(own, { hash: '#device' });
    equal(text(second.document.getElementById('firmware-reinstall')), 'Install release 0.3.0', 'a build newer than the release: the button names what it installs');
    check(text(second.document.getElementById('firmware-box')).includes('newer than the latest release'), 'and the page says which is newer');

    const offline = makeDevice();
    offline.release = null;
    const third = await openPage(offline, { hash: '#device' });
    check(!third.document.getElementById('firmware-reinstall'), 'no release found: no button');
});

test('no firmware offer when the device is up to date, offline, or on another layout', async () => {
    const current = makeDevice();
    current.release.version = '0.4.0';
    const first = await openPage(current, { hash: '#device' });
    check(!first.document.getElementById('firmware-update'), 'up to date: no button');
    check(first.document.getElementById('firmware-choose') !== null, 'a file can still be installed');

    const offline = makeDevice();
    offline.internet = null;
    const second = await openPage(offline, { hash: '#device' });
    check(!second.document.getElementById('firmware-update'), 'no internet: no button');
    check(!text(second.document.getElementById('firmware-box')).includes('newest'), 'and no claim about being the newest');

    const other = makeDevice();
    other.release.layout = 3;
    const third = await openPage(other, { hash: '#device' });
    check(!third.document.getElementById('firmware-update'), 'a release for another flash layout is not offered');
});

test('a device on the old flash layout is told about the one-time move', async () => {
    const device = makeDevice();
    device.firmware.layout = 1;
    const { document } = await openPage(device, { hash: '#device' });
    check(text(document.getElementById('firmware-box')).includes('tools/deskhog migrate'), 'the move is explained');
    check(!document.getElementById('firmware-update') && !document.getElementById('firmware-choose'), 'and nothing is offered');
    check(!device.outside.some(url => url.includes('/firmware/')), 'nor looked up');

    const older = makeDevice();
    older.firmware = null;
    const second = await openPage(older, { hash: '#device' });
    check(text(second.document.getElementById('firmware-box')).includes('installed over USB'), 'older firmware keeps the note about USB');
});

test('a failed firmware upload can be tried again', async () => {
    const device = makeDevice();
    device.firmware.failUploads = 1;
    const { window, document } = await openPage(device, { hash: '#device' });
    window.firmwarePause = 0;
    await click(window, document.getElementById('firmware-update'));
    for (let i = 0; i < 6; i++) await settle(window);
    check(text(document.getElementById('firmware-error')).includes('The connection was lost'), 'the page says what went wrong');
    check(device.firmware.inUpdater, 'the device is still in its updater');

    await click(window, document.getElementById('firmware-retry'));
    for (let i = 0; i < 6; i++) await settle(window);
    equal(device.requests.filter(r => r.url === '/api/update/start').length, 1, 'the retry does not restart it again');
    equal(device.firmware.version, '0.5.0', 'and the second attempt installs it');
    check(!document.getElementById('firmware-error'), 'the error is gone');
});

test('a card can be kept out of the rotation', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, tile(document, 'PLUGIN|hello:1'));
    const pane = document.getElementById('card-pane');
    const skip = [...pane.querySelectorAll('label.field.check')].find(l => l.textContent.startsWith('Skip in rotation'));
    check(!!skip && !skip.querySelector('input').checked, 'unticked to begin with');
    check(skip.textContent.includes('stays on it when you go there yourself'), 'with its hint');
    skip.querySelector('input').checked = true;
    await click(window, buttonNamed(pane, 'Save'));
    equal(lastRequest(device, '/api/cards/update?key=hello%3A1').body.rotate, false, 'saved with the card');
    equal(device.cards.find(c => c.config === 'hello:1').rotate, false, 'the device has it');
    await click(window, tile(document, 'PLUGIN|hello:1'));
    const again = [...document.querySelectorAll('#card-pane label.field.check')].find(l => l.textContent.startsWith('Skip in rotation'));
    check(again.querySelector('input').checked, 'and shows it as saved');
});

test('the pretend device is as strict as the firmware', async () => {
    const device = makeDevice();
    const post = body => device.handle('POST', '/api/device', body);
    for (const bad of [{ screen: { day: 4 } }, { screen: { day: 60.5 } }, { screen: { day: '60' } }, { led: { night: 101 } }, { name: '-a' }, { name: 'a-' },
        { name: 'A' }, { name: 5 }, { rotate: { seconds: 5 } }, { rotate: { seconds: 601 } }, { battery: 1 }, { night: { enabled: 'yes' } },
        { night: { from: '25:00' } }, { night: { until: 2200 } }, { colour: 1 }, { screen: { dusk: 1 } }, { preview: 'dusk' }, { screen: 3 }]) {
        const answer = post(bad);
        equal([answer.status, JSON.parse(answer.body).ok], [400, false], 'refuses ' + JSON.stringify(bad));
    }
    equal(post({ screen: { day: 60 }, name: 'A' }).status, 400, 'one bad value refuses the lot');
    equal(device.device.screen.day, 80, 'and nothing changed');
    const good = post({ screen: { day: 5 }, rotate: { seconds: 0 }, preview: 'night', night: { from: '22:30' } });
    equal(good.status, 200, 'a good body');
    equal([JSON.parse(good.body).screen.day, JSON.parse(good.body).night.from], [5, '22:30'], 'answers with the whole object');
    equal(JSON.parse(device.handle('GET', '/api/device').body), JSON.parse(good.body), 'which GET gives too');
});

test('errors from the device are shown', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device);
    await click(window, document.getElementById('add-card-btn'));
    const pane = document.getElementById('card-pane');
    const original = device.handle;
    device.handle = (method, url, body) => (url === '/api/cards/add' ? { status: 400, body: JSON.stringify({ ok: false, error: 'the device shows at most 12 plugin cards' }) } : original(method, url, body));
    await click(window, buttonNamed(pane, 'Hello'));
    await click(window, buttonNamed(pane, 'Add card'));
    equal(document.getElementById('notice').textContent, 'the device shows at most 12 plugin cards', 'message');
    check(document.getElementById('notice').className.includes('error'), 'styled as an error');
    check(buttonNamed(pane, 'Add card') !== undefined && !pane.hidden, 'the form stays open so nothing typed is lost');
});

// ------------------------------------------------- the login and the keys

/** test/access/vectors.txt as an object; the firmware's tests read the same file. */
const vectors = () => Object.fromEntries(fs.readFileSync(path.join(root, 'test/access/vectors.txt'), 'utf8').split('\n')
    .filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

/** One call to a pretend device, its answer's body read as JSON. */
function call(device, method, url, body, headers) {
    const answer = device.handle(method, url, body, headers);
    let json = null;
    try { json = JSON.parse(answer.body); } catch (error) { /* not JSON */ }
    return { status: answer.status, json };
}
const bearer = key => ({ authorization: 'Bearer ' + key });
const LOCKED = { ok: false, locked: true, error: 'This DeskHog has a password. Log in first.' };
const hex = digits => new RegExp('^[0-9a-f]{' + digits + '}$');

/** Logs in the way the page does: ask what a login needs, prove the password. Gives the answer to the POST. */
function logIn(device, password, headers) {
    const asked = call(device, 'GET', '/api/login').json;
    const verifier = login.passwordVerifier(password, asked.salt, asked.rounds);
    return call(device, 'POST', '/api/login', { nonce: asked.nonce, proof: login.loginProof(verifier, asked.nonce) }, headers);
}
/** A body for POST /api/password that proves `old` and sets `next`, as the page builds it. */
function changeBody(device, old, next, extra) {
    const asked = call(device, 'GET', '/api/login').json;
    const oldVerifier = login.passwordVerifier(old, asked.salt, asked.rounds);
    const salt = '00112233445566778899aabbccddeeff';
    const newVerifier = login.passwordVerifier(next, salt, 100);
    return Object.assign({
        nonce: asked.nonce, proof: login.loginProof(oldVerifier, asked.nonce),
        salt, rounds: 100, verifier: login.maskedVerifier(oldVerifier, asked.nonce, newVerifier),
    }, extra || {});
}
const wrongProof = device => ({ nonce: call(device, 'GET', '/api/login').json.nonce, proof: '00'.repeat(32) });

test('the login maths match the vectors', async () => {
    const v = vectors();
    equal(login.passwordVerifier(v.password, v.salt, 1000), v.verifier, 'the verifier');
    equal(login.loginProof(v.verifier, v.nonce), v.proof, 'the proof');
    equal(login.maskedVerifier(v.verifier, v.nonce, v.new_verifier), v.masked, 'the masked verifier');
    const odd = JSON.parse(v.utf8_password);
    equal(login.passwordVerifier(odd, v.salt, 1000), v.utf8_verifier, 'spaces, an umlaut and an emoji');
    equal(login.passwordVerifier(odd.normalize('NFD'), v.salt, 1000), v.utf8_verifier, 'typed as NFD');
});

test('twenty thousand rounds take well under a second here', async () => {
    const started = Date.now();
    equal(login.passwordVerifier('correct horse battery', '000102030405060708090a0b0c0d0e0f', 20000).length, 64, 'a verifier');
    const took = Date.now() - started;
    check(took < 1000, '20,000 rounds took ' + took + ' ms');
});

test('a locked pretend device answers like the firmware', async () => {
    const device = makeDevice();
    addHomey(device);
    device.lock('correct horse battery');
    equal(call(device, 'GET', '/api/state'), { status: 401, json: LOCKED }, 'no key: 401');
    equal(call(device, 'GET', '/api/status').json, { locked: true, updater: false }, 'the status without a key');
    const asked = call(device, 'GET', '/api/login').json;
    equal([asked.locked, asked.rounds, asked.salt === device.access.password.salt, hex(32).test(asked.nonce)], [true, 100, true, true], 'what a login needs');

    const answer = logIn(device, 'correct horse battery');
    equal([answer.status, answer.json.ok, hex(32).test(answer.json.key)], [200, true, true], 'a login gives a key');
    const key = answer.json.key;
    const proof = login.loginProof(login.passwordVerifier('correct horse battery', asked.salt, asked.rounds), asked.nonce);
    equal(call(device, 'POST', '/api/login', { nonce: asked.nonce, proof }).status, 200, 'a nonce is good once...');
    equal(call(device, 'POST', '/api/login', { nonce: asked.nonce, proof }).status, 403, '...and then it is gone');

    equal(call(device, 'GET', '/api/state', undefined, bearer(key)).status, 200, 'the key opens the state');
    const message = call(device, 'POST', '/api/keys', { name: 'doorbell' }, bearer(key)).json;
    equal(call(device, 'POST', '/api/cards/message?key=homey:1&auth=' + message.key, 'ding').status, 200, 'a message key sends a message');
    equal(call(device, 'GET', '/api/state?auth=' + message.key).status, 401, 'and opens nothing else');
    equal(call(device, 'GET', '/api/state', undefined, Object.assign(bearer(key), { origin: 'http://evil.example' })).status, 403, 'another website is refused, key or not');
    equal(call(makeDevice(), 'GET', '/api/cards/show').status, 405, 'a call that changes something is refused as a GET, with no password too');

    for (let i = 0; i < 5; i++) equal(call(device, 'POST', '/api/login', wrongProof(device)).status, 403, 'wrong proof ' + (i + 1));
    equal(call(device, 'POST', '/api/login', wrongProof(device)).status, 429, 'the sixth is told to wait');

    const updater = makeDevice();
    updater.lock('correct horse battery');
    updater.firmware.inUpdater = true;
    equal(call(updater, 'POST', '/api/firmware?size=1&sha256=x', 'x').status, 401, 'the updater wants a key to take firmware');
    equal(call(updater, 'GET', '/api/status').json, { locked: true, updater: true }, 'and says so');
});

test('with no password the login calls say so and the keys are not for sale', async () => {
    const device = makeDevice();
    const first = call(device, 'GET', '/api/login').json;
    equal(Object.keys(first), ['locked', 'name', 'id', 'salt', 'rounds', 'nonce'], 'the shape');
    equal([first.locked, first.name, first.salt, first.rounds, hex(12).test(first.id), hex(32).test(first.nonce)], [false, 'deskhog', '', 0, true, true], 'the values');
    check(call(device, 'GET', '/api/login').json.nonce !== first.nonce, 'every call gives a new nonce');
    const proof = { nonce: first.nonce, proof: '00'.repeat(32) };
    equal(call(device, 'POST', '/api/login', proof), { status: 409, json: { ok: false, error: 'This DeskHog has no password.' } }, 'nothing to log in to');
    equal(call(device, 'POST', '/api/keys', { name: 'a' }), { status: 409, json: { ok: false, error: 'Set a password first.' } }, 'no message keys');
    equal(call(device, 'POST', '/api/password', Object.assign({ remove: true }, proof)).status, 409, 'nothing to remove');
    equal(call(device, 'POST', '/api/password', proof).status, 409, 'nothing to change');
    equal(call(device, 'GET', '/api/keys').json, { logins: 0, messages: [] }, 'no keys');
    equal(call(device, 'POST', '/api/logout').json, { ok: true }, 'logging out is nothing');
    equal(call(device, 'GET', '/api/device').json.status.password, false, 'the status says no password');
    equal(call(device, 'GET', '/api/device').json.status.updater, 2, 'and which updater');
});

test('the first password: checks, a login key, then the device is locked', async () => {
    const device = makeDevice();
    const good = { salt: '000102030405060708090a0b0c0d0e0f', rounds: 100, verifier: '11'.repeat(32) };
    const set = body => call(device, 'POST', '/api/password', body);
    equal(set({ salt: 'zz', rounds: 100, verifier: good.verifier }), { status: 400, json: { ok: false, error: 'salt is 32 hex digits' } }, 'a bad salt');
    for (const rounds of [0, 10000001, 1.5, '100', undefined]) {
        equal(set(Object.assign({}, good, { rounds })), { status: 400, json: { ok: false, error: 'rounds is a whole number from 1 to 10000000' } }, 'rounds ' + rounds);
    }
    equal(set(Object.assign({}, good, { verifier: '11'.repeat(31) })), { status: 400, json: { ok: false, error: 'verifier is 64 hex digits' } }, 'a short verifier');
    equal(call(device, 'POST', '/api/password').status, 400, 'no body');
    check(!device.access.password, 'nothing was set by any of those');
    const answer = set(Object.assign({}, good, { salt: good.salt.toUpperCase() }));
    equal([answer.status, answer.json.ok, hex(32).test(answer.json.key)], [200, true, true], 'a good one gives a key');
    equal(device.access.logins, [answer.json.key], 'which is a login key');
    equal(device.access.password, { salt: good.salt, rounds: 100, verifier: good.verifier }, 'stored in lower case');
    equal(call(device, 'GET', '/api/state').status, 401, 'the device is locked');
    equal(call(device, 'GET', '/api/device', undefined, bearer(answer.json.key)).json.status.password, true, 'the status says so');
});

test('logging in: the wrong password, and nonces that are unknown, used or old', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const post = body => call(device, 'POST', '/api/login', body);
    const TOO_LONG = { status: 403, json: { ok: false, error: 'That took too long. Try again.' } };
    equal(post(wrongProof(device)), { status: 403, json: { ok: false, error: 'That is not the password.' } }, 'a wrong proof is 403');
    equal(post({ nonce: 'ab'.repeat(16), proof: '00'.repeat(32) }), TOO_LONG, 'a nonce the device never gave');
    const asked = call(device, 'GET', '/api/login').json;
    const proof = login.loginProof(login.passwordVerifier('correct horse battery', asked.salt, 100), asked.nonce);
    equal(post({ nonce: asked.nonce, proof }).status, 200, 'the right proof logs in');
    equal(post({ nonce: asked.nonce, proof }), TOO_LONG, 'the same nonce twice');
    const old = call(device, 'GET', '/api/login').json;
    device.now += 60000;
    equal(post({ nonce: old.nonce, proof: login.loginProof(login.passwordVerifier('correct horse battery', old.salt, 100), old.nonce) }), TOO_LONG, 'a nonce a minute old');
    const young = call(device, 'GET', '/api/login').json;
    device.now += 59999;
    equal(post({ nonce: young.nonce, proof: login.loginProof(login.passwordVerifier('correct horse battery', young.salt, 100), young.nonce) }).status, 200, 'one a millisecond short of a minute is good');
    equal(post({ nonce: 'xyz', proof }).json.error, 'nonce is the 32 hex digits GET /api/login gave', 'a malformed nonce');
    equal(post({ nonce: asked.nonce, proof: 'abc' }).json.error, 'proof is 64 hex digits', 'a malformed proof');
    equal(post().status, 400, 'no body');
    equal(post('not json').json.error, 'the body is not valid JSON', 'a body that is not JSON');
    const nonces = [];
    for (let i = 0; i < 6; i++) nonces.push(call(device, 'GET', '/api/login').json.nonce);
    equal(device.access.nonces, nonces.slice(2), 'the device remembers four nonces, the newest');
});

test('five wrong proofs in a row stop logins for a minute', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    for (let i = 0; i < 4; i++) call(device, 'POST', '/api/login', wrongProof(device));
    equal(logIn(device, 'correct horse battery').status, 200, 'a right one before the fifth clears the count');
    for (let i = 0; i < 5; i++) equal(call(device, 'POST', '/api/login', wrongProof(device)).status, 403, 'wrong ' + (i + 1));
    const TOO_MANY = { status: 429, json: { ok: false, error: 'Too many wrong tries. Wait a minute.' } };
    equal(call(device, 'POST', '/api/login', wrongProof(device)), TOO_MANY, 'the sixth is turned away');
    equal(logIn(device, 'correct horse battery'), TOO_MANY, 'so is the right password');
    equal(call(device, 'GET', '/api/login').json.locked, true, 'asking what a login needs still works');
    const key = device.loginKey();
    equal(call(device, 'GET', '/api/state', undefined, bearer(key)).status, 200, 'keys that exist keep working');
    device.now += 59999;
    equal(logIn(device, 'correct horse battery').status, 429, 'still waiting a millisecond before the minute is up');
    device.now += 1;
    equal(logIn(device, 'correct horse battery').status, 200, 'a minute later logins work again');
    for (let i = 0; i < 5; i++) call(device, 'POST', '/api/login', wrongProof(device));
    equal(call(device, 'POST', '/api/login', wrongProof(device)).status, 429, 'and five more wrong ones stop them again');
});

test('changing the password: the others are logged out, message keys stay', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const mine = logIn(device, 'correct horse battery').json.key;
    const other = logIn(device, 'correct horse battery').json.key;
    const doorbell = call(device, 'POST', '/api/keys', { name: 'doorbell' }, bearer(mine)).json;
    const change = body => call(device, 'POST', '/api/password', body, bearer(mine));

    const before = device.access.nonces.length;
    equal(change(changeBody(device, 'correct horse battery', 'new password', { salt: 'nope' })).json.error, 'salt is 32 hex digits', 'a bad new salt');
    equal(change(changeBody(device, 'correct horse battery', 'new password', { rounds: 0 })).status, 400, 'bad new rounds');
    equal(change(changeBody(device, 'correct horse battery', 'new password', { verifier: 'ab' })).status, 400, 'a bad new verifier');
    equal(device.access.nonces.length, before + 3, 'a malformed change does not use up the nonce');
    equal(change(changeBody(device, 'wrong password', 'new password')).status, 403, 'a wrong old password is 403');
    equal(change(Object.assign(changeBody(device, 'correct horse battery', 'new password'), { nonce: 'ab'.repeat(16) })).status, 403, 'an unknown nonce is 403');
    equal(change(Object.assign(wrongProof(device), { remove: 'yes' })).json.error, 'remove is true, or left out', 'remove must be true');
    equal(call(device, 'POST', '/api/password', changeBody(device, 'correct horse battery', 'new password')), { status: 401, json: LOCKED }, 'no key, no change');
    equal(call(device, 'POST', '/api/password', changeBody(device, 'correct horse battery', 'new password'), bearer(doorbell.key)).status, 401, 'a message key cannot change it');

    const answer = change(changeBody(device, 'correct horse battery', 'new password'));
    equal([answer.status, answer.json], [200, { ok: true }], 'a good change');
    equal(device.access.logins, [mine], 'only the key that asked is left');
    equal(call(device, 'GET', '/api/state', undefined, bearer(other)).status, 401, 'the other login is out');
    equal(call(device, 'GET', '/api/state', undefined, bearer(mine)).status, 200, 'this one stays');
    equal(device.access.messages.map(m => m.key), [doorbell.key], 'the message key stays');
    equal(logIn(device, 'correct horse battery').status, 403, 'the old password no longer works');
    equal(logIn(device, 'new password').status, 200, 'the new one does');
    equal(device.access.password.salt, '00112233445566778899aabbccddeeff', 'with the new salt');
});

test('removing the password: every key goes', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const mine = logIn(device, 'correct horse battery').json.key;
    logIn(device, 'correct horse battery');
    call(device, 'POST', '/api/keys', { name: 'doorbell' }, bearer(mine));
    const asked = call(device, 'GET', '/api/login').json;
    const proof = login.loginProof(login.passwordVerifier('wrong', asked.salt, 100), asked.nonce);
    equal(call(device, 'POST', '/api/password', { nonce: asked.nonce, proof, remove: true }, bearer(mine)).status, 403, 'a wrong password removes nothing');
    const again = call(device, 'GET', '/api/login').json;
    const right = login.loginProof(login.passwordVerifier('correct horse battery', again.salt, 100), again.nonce);
    equal(call(device, 'POST', '/api/password', { nonce: again.nonce, proof: right, remove: true }, bearer(mine)), { status: 200, json: { ok: true } }, 'the right one does');
    equal([device.access.password, device.access.logins, device.access.messages], [null, [], []], 'no password, no keys');
    equal(call(device, 'GET', '/api/state').status, 200, 'the device is open again');
    equal(call(device, 'GET', '/api/login').json.salt, '', 'and says so');
});

test('message keys: add, list, remove, and the limits', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const key = device.loginKey();
    const as = (method, url, body) => call(device, method, url, body, bearer(key));
    const added = as('POST', '/api/keys', { name: 'doorbell' }).json;
    equal([added.ok, added.name, typeof added.id, hex(32).test(added.key)], [true, 'doorbell', 'number', true], 'a new key');
    equal(Object.keys(added), ['ok', 'id', 'name', 'key'], 'in this order');
    equal(as('GET', '/api/keys').json, { logins: 1, messages: [{ id: added.id, name: 'doorbell', key: added.key }] }, 'listed');
    for (const name of ['', 'x'.repeat(25), 'tab\there', 7, undefined]) {
        equal(as('POST', '/api/keys', { name }), { status: 400, json: { ok: false, error: 'name is 1 to 24 bytes, without control characters' } }, 'a bad name: ' + JSON.stringify(name));
    }
    equal(as('POST', '/api/keys', { name: 'x'.repeat(24) }).status, 200, '24 bytes is fine');
    equal(as('POST', '/api/keys', { name: '🦔'.repeat(7) }).status, 400, 'it counts bytes, not characters');
    for (let i = 0; i < 6; i++) equal(as('POST', '/api/keys', { name: 'k' + i }).status, 200, 'key ' + (i + 3));
    equal(as('POST', '/api/keys', { name: 'ninth' }), { status: 409, json: { ok: false, error: 'There are 8 message keys. Remove one first.' } }, 'a ninth');
    equal(as('DELETE', '/api/keys?id=' + added.id).json, { ok: true }, 'remove one');
    equal(as('DELETE', '/api/keys?id=' + added.id), { status: 404, json: { ok: false, error: 'no such key' } }, 'twice');
    equal(as('DELETE', '/api/keys?id=99').status, 404, 'an id no key has');
    equal(as('DELETE', '/api/keys?id=abc').status, 400, 'an id that is not a number');
    equal(as('DELETE', '/api/keys').status, 400, 'no id');
    equal(as('POST', '/api/keys', { name: 'ninth' }).status, 200, 'room again');
    equal(as('PUT', '/api/keys', {}).status, 405, 'PUT is not an answer here');
    equal(call(device, 'GET', '/api/keys').status, 401, 'no key, no list');
});

test('login keys: eight at most, and logging out', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const keys = [];
    for (let i = 0; i < 9; i++) keys.push(logIn(device, 'correct horse battery').json.key);
    equal(device.access.logins, keys.slice(1), 'a ninth login replaces the oldest');
    equal(call(device, 'GET', '/api/state', undefined, bearer(keys[0])).status, 401, 'which no longer opens anything');
    equal(call(device, 'GET', '/api/keys', undefined, bearer(keys[8])).json.logins, 8, 'eight are counted');
    const message = call(device, 'POST', '/api/keys', { name: 'doorbell' }, bearer(keys[8])).json;
    equal(call(device, 'POST', '/api/logout?others=1', undefined, bearer(keys[8])).json, { ok: true }, 'log out the others');
    equal(device.access.logins, [keys[8]], 'this one is left');
    equal(device.access.messages.length, 1, 'message keys are not login keys');
    equal(call(device, 'POST', '/api/logout', undefined, bearer(keys[8])).json, { ok: true }, 'log out');
    equal(call(device, 'GET', '/api/state', undefined, bearer(keys[8])).status, 401, 'the key is gone');
    equal(call(device, 'POST', '/api/logout', undefined, bearer(message.key)).status, 401, 'a message key cannot log out');
    const again = device.loginKey();
    equal(call(device, 'GET', '/api/logout', undefined, bearer(again)).status, 405, 'logging out takes POST');
    equal(call(device, 'POST', '/api/logout?others=0', undefined, bearer(again)).json, { ok: true }, 'others=0 is the same as no others');
    equal(device.access.logins, [], 'and removes this key');
});

test('who may call what, rule by rule', async () => {
    const device = makeDevice();
    addHomey(device);
    const nothing = device.handle('GET', '/index.html');
    check(nothing.status === 404, 'a path outside /api/ is not the API');
    device.lock('correct horse battery');
    const key = device.loginKey();
    const message = call(device, 'POST', '/api/keys', { name: 'bell' }, bearer(key)).json.key;
    equal(device.handle('GET', '/index.html').status, 404, 'rule 1: a page outside /api/ is not locked');
    equal(call(device, 'GET', '/API/state').status, 401, 'rule 1: /api/ in any case is the API');
    equal(call(device, 'GET', '/api/state', undefined, { origin: 'http://evil.example' }).status, 403, 'rule 2: another website, before anything else');
    equal(call(device, 'GET', '/api/login', undefined, { origin: 'http://evil.example' }).json.error, 'This request came from another website.', 'rule 2: even to log in');
    equal(call(device, 'GET', '/api/state', undefined, Object.assign(bearer(key), { origin: 'HTTP://DESKHOG.LOCAL' })).status, 200, 'rule 2: its own address, in any case');
    equal(call(device, 'GET', '/api/state', undefined, Object.assign(bearer(key), { origin: 'http://192.168.1.50', host: '192.168.1.50' })).status, 200, 'rule 2: Host is what counts');
    equal(call(device, 'GET', '/api/state', undefined, Object.assign(bearer(key), { origin: 'https://deskhog.local' })).status, 403, 'rule 2: https is another origin');
    equal(call(device, 'OPTIONS', '/api/state', undefined, bearer(key)), { status: 405, json: { ok: false, error: 'This call is not answered.' } }, 'rule 3: no preflight');
    equal(call(device, 'GET', '/api/state?auth=' + key).status, 401, 'rule 5: a login key in the address is no key');
    equal(call(device, 'GET', '/api/state', undefined, { authorization: 'bearer ' + key.toUpperCase() }).status, 200, 'rule 5: the word and the key in any case');
    equal(call(device, 'GET', '/api/state', undefined, { authorization: key }).status, 401, 'rule 5: Bearer is part of it');
    equal(call(device, 'GET', '/api/state', undefined, bearer('ab'.repeat(16))).status, 401, 'rule 5: a key nobody has');
    equal(call(device, 'GET', '/api/status').json, { locked: true, updater: false }, 'rule 6: the status, trimmed');
    check(call(device, 'GET', '/api/status', undefined, bearer(key)).json.wifi, 'rule 6: the whole status with a login key');
    equal(call(device, 'GET', '/api/status', undefined, bearer(message)).json, { locked: true, updater: false }, 'rule 6: a message key gets the trimmed one');
    equal(call(device, 'GET', '/api/login').status, 200, 'rule 6: login is open');
    equal(call(device, 'DELETE', '/api/login').json.ok, false, 'rule 6/8: DELETE /api/login is not open');
    equal(call(device, 'POST', '/api/cards/message?key=homey:1', 'hi').status, 401, 'rule 7: a message call wants a key');
    equal(call(device, 'POST', '/api/cards/message?key=homey:1', 'hi', bearer(message)).status, 200, 'rule 7: any key will do');
    equal(call(device, 'POST', '/api/connections/message?id=homey&auth=' + message, 'hi').status, 200, 'rule 7: both message calls');
    equal(call(device, 'POST', '/api/cards/show?key=hello:1', undefined, bearer(message)).status, 401, 'rule 7: everything else wants a login key');
    equal(call(device, 'GET', '/api/cards/show?key=hello:1', undefined, bearer(key)), { status: 405, json: { ok: false, error: 'This call changes something. Use POST.' } }, 'rule 8: GET does not change anything');
    equal(call(device, 'HEAD', '/api/cards/show?key=hello:1', undefined, bearer(key)).status, 405, 'rule 8: nor does HEAD');
    equal(call(device, 'PATCH', '/api/cards/show?key=hello:1', undefined, bearer(key)).status, 405, 'rule 8: nor does PATCH');
    equal(call(device, 'GET', '/api/cards/message?key=homey:1', undefined, bearer(key)).status, 405, 'rule 8: a message is a POST');
    equal(call(device, 'GET', '/api/cards/show', undefined, { authorization: 'bearer nothing' }).status, 401, 'rule 7 comes before rule 8');
    equal(call(device, 'GET', '/api/plugins/hello', undefined, bearer(key)).status, 200, 'rule 8: /api/plugins is a read');
    equal(call(device, 'DELETE', '/api/plugins/hello', undefined, bearer(key)).status, 200, 'rule 8: DELETE is fine');
    const open = makeDevice();
    equal(call(open, 'GET', '/api/cards/show').status, 405, 'with no password, rule 8 still holds');
    equal(call(open, 'GET', '/api/state', undefined, { origin: 'http://evil.example' }).status, 403, 'and rule 2');
    equal(call(open, 'OPTIONS', '/api/state').status, 405, 'and rule 3');
    equal(call(open, 'GET', '/api/state').status, 200, 'but a read needs no key');
});

test('the updater: four calls, the firmware\'s login keys and its own', async () => {
    const device = makeDevice();
    device.firmware.inUpdater = true;
    equal(call(device, 'GET', '/api/status').json.updater, true, 'without a password the status is as it was');
    equal(call(device, 'POST', '/api/restart').status, 200, 'and anyone may restart it');
    device.lock('correct horse battery');
    const firmwareKey = device.loginKey();
    const message = call(device, 'POST', '/api/keys', { name: 'bell' }, bearer(firmwareKey)).json;
    device.firmware.inUpdater = true;
    equal(call(device, 'GET', '/api/status').json, { locked: true, updater: true }, 'locked: the trimmed status');
    equal(call(device, 'GET', '/api/state').status, 404, 'there is no /api/state in the updater');
    equal(call(device, 'POST', '/api/firmware?size=1&sha256=x', 'x'), { status: 401, json: LOCKED }, 'no key: no firmware');
    equal(call(device, 'POST', '/api/restart'), { status: 401, json: LOCKED }, 'no key: no restart');
    equal(call(device, 'GET', '/api/status', undefined, bearer(firmwareKey)).json.main_intact, true, 'a login key the firmware holds: the whole status');
    equal(call(device, 'POST', '/api/firmware?size=1&sha256=x', 'x', { origin: 'http://evil.example', authorization: 'Bearer ' + firmwareKey }).status, 403, 'another website is refused here too');
    equal(call(device, 'OPTIONS', '/api/status').status, 405, 'and no preflight');
    equal(call(device, 'GET', '/api/firmware', undefined, bearer(firmwareKey)).status, 405, 'a GET does not upload');
    const asked = call(device, 'GET', '/api/login').json;
    equal([asked.locked, asked.rounds, hex(32).test(asked.nonce)], [true, 100, true], 'it gives what a login needs');
    equal(logIn(device, 'wrong password').status, 403, 'a wrong password is 403 here too');
    const key = logIn(device, 'correct horse battery').json.key;
    equal(call(device, 'GET', '/api/status', undefined, bearer(key)).json.main_intact, true, 'a login made here opens it');
    equal(device.access.logins, [firmwareKey], 'and is not one of the firmware\'s keys');
    equal(call(device, 'POST', '/api/firmware?size=1&sha256=x', 'x', bearer(message.key)).status, 401, 'a message key opens nothing');
    equal(call(device, 'POST', '/api/firmware?size=12&sha256=abc123', 'x', bearer(key)).status, 200, 'with the key the firmware goes in');
    equal(device.firmware.inUpdater, false, 'and the device leaves the updater');
    equal(call(device, 'GET', '/api/state', undefined, bearer(key)).status, 401, 'the key from the updater is forgotten');
    equal(call(device, 'GET', '/api/state', undefined, bearer(firmwareKey)).status, 200, 'the firmware\'s own key is not');
});

// ------------------------------------------------------------------ the password

/** Types a password into the login screen and presses Log in; waits until the page has an answer. */
async function typePassword(window, document, password) {
    const field = document.getElementById('login-password');
    field.value = password;
    document.getElementById('login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 200 && /^Checking/.test(text(document.getElementById('login-error'))); i++) await settle(window);
    await settle(window);
    await settle(window);
}
const loginShown = document => !document.getElementById('login').hidden;
const keyOf = device => 'Bearer ' + device.access.logins[device.access.logins.length - 1];

test('a locked device shows the login screen and nothing else', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const { document, errors } = await openPage(device);
    check(loginShown(document), 'the login screen is there');
    check(document.body.classList.contains('locked'), 'the rest of the page is hidden');
    equal(text(document.getElementById('login-name')), 'deskhog', 'it names the device');
    check(!device.requests.some(r => r.url.startsWith('/api/state')), 'the page did not ask for its cards');
    equal(document.getElementById('login-password').type, 'password', 'the password is not shown');
    equal(errors, [], 'no script errors');
});

test('a device without a password starts as it always did', async () => {
    const device = makeDevice();
    const { document } = await openPage(device);
    check(!loginShown(document), 'no login screen');
    check(!document.body.classList.contains('locked'), 'nothing hidden');
    check(device.requests.every(r => !r.headers.authorization), 'and no key is sent');
    equal(titles(document).length, 5, 'the cards are there');
});

test('a wrong password says so, the right one opens the page', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const { window, document } = await openPage(device);
    await typePassword(window, document, 'wrong password');
    equal(text(document.getElementById('login-error')), 'That is not the password.', 'the device\'s words');
    check(loginShown(document), 'still locked');
    equal(document.getElementById('login-password').value, '', 'the field is emptied');
    equal(window.sessionKey(), '', 'no key was kept');
    await typePassword(window, document, 'correct horse battery');
    check(!loginShown(document), 'the login screen is gone');
    check(!document.body.classList.contains('locked'), 'the page is back');
    equal(titles(document).length, 5, 'the cards are there');
    equal(text(document.getElementById('login-error')), '', 'and no error is left');
    const from = device.requests.length;
    await window.refresh();
    await window.pollStatus();
    const later = device.requests.slice(from);
    check(later.length >= 2, 'the page keeps talking to the device');
    check(later.every(r => r.headers.authorization === keyOf(device)), 'every request carries the key');
    equal(window.sessionKey(), device.access.logins[0], 'the key is the one the device made');
});

test('too many wrong tries and an unreachable device are said in words', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const { window, document } = await openPage(device);
    for (let i = 0; i < 6; i++) await typePassword(window, document, 'wrong ' + i);
    equal(text(document.getElementById('login-error')), 'Too many wrong tries. Wait a minute.', 'the device\'s words');
    const real = window.fetch;
    window.fetch = async () => { throw new window.TypeError('Failed to fetch'); };
    await typePassword(window, document, 'correct horse battery');
    check(/reach/.test(text(document.getElementById('login-error'))), 'a plain sentence when it cannot be reached');
    window.fetch = real;
    check(loginShown(document), 'the screen stays');
});

test('the key goes to the device and nowhere else', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const { window, document } = await openPage(device, { hash: '#device' });
    await typePassword(window, document, 'correct horse battery');
    await click(window, document.getElementById('cards-get-plugins-btn'));
    window.firmwarePause = 0;
    await window.checkFirmware();
    await settle(window);
    check(device.outside.some(url => url.endsWith('/plugins/index.json')), 'the plugin directory was asked');
    check(device.outside.some(url => url.endsWith('/firmware/latest.json')), 'and GitHub for the firmware');
    check(device.outsideSeen.length >= 2 && device.outsideSeen.every(r => !r.headers.authorization), 'none of those carried a key');
    check(device.outsideSeen.every(r => !r.url.includes(window.sessionKey())), 'nor had it in the address');
    const key = 'Bearer ' + window.sessionKey();
    const sent = device.requests.filter(r => r.headers.authorization);
    check(sent.length > 0 && sent.every(r => r.headers.authorization === key), 'the device was given it');
    check(device.requests.filter(r => !r.url.startsWith('/api/login')).every(r => r.headers.authorization === key), 'on every call but the login');
    check(!window.location.href.includes(window.sessionKey()), 'it is not in the page\'s address');
});

test('a key that stopped working leads back to the login screen', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const { window, document } = await openPage(device);
    await typePassword(window, document, 'correct horse battery');
    check(!loginShown(document), 'logged in');
    device.access.logins = [];
    await window.refresh();
    check(loginShown(document), 'the login screen is back');
    check(document.body.classList.contains('locked'), 'the page is hidden');
    equal(window.sessionKey(), '', 'the key is forgotten');
    const from = device.requests.length;
    await window.refresh();
    await window.pollStatus();
    equal(device.requests.slice(from).length, 0, 'nothing is asked while the login screen is up');
    await typePassword(window, document, 'correct horse battery');
    check(!loginShown(document), 'a new login brings the page back');
    equal(titles(document).length, 5, 'with its cards');
});

test('only a 401 drops the key', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const key = device.loginKey();
    const { window, document } = await openPage(device, { storage: { 'deskhog-key': key } });
    check(!loginShown(document), 'the key opened the page');
    const real = window.fetch;
    for (const status of [403, 405, 429, 500]) {
        window.fetch = async () => ({ ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify({ ok: false, error: 'no ' + status }) });
        await window.refresh();
        check(!loginShown(document) && window.sessionKey() === key, status + ' keeps the key');
    }
    window.fetch = async () => { throw new window.TypeError('Failed to fetch'); };
    await window.refresh();
    check(!loginShown(document) && window.sessionKey() === key, 'so does a device that is away');
    window.fetch = real;
});

test('a login screen left open still logs in', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const { window, document } = await openPage(device);
    device.access.nonces = [];       // as after a restart
    device.now += 3600 * 1000;       // and an hour on
    await typePassword(window, document, 'correct horse battery');
    check(!loginShown(document), 'it worked the first time');
    equal(device.access.logins.length, 1, 'with one key made');
});

test('the page works when the browser refuses storage', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const { window, document, errors } = await openPage(device, { refuseStorage: true });
    check(loginShown(document), 'the login screen shows, not a broken page');
    await typePassword(window, document, 'correct horse battery');
    check(!loginShown(document), 'logged in');
    equal(window.sessionKey(), device.access.logins[0], 'the key is kept in memory');
    const from = device.requests.length;
    await window.refresh();
    check(device.requests.length > from && device.requests.slice(from).every(r => r.headers.authorization === keyOf(device)), 'requests carry it');
    equal(titles(document).length, 5, 'the cards are there');
    device.access.logins = [];
    await window.refresh();
    check(loginShown(document) && window.sessionKey() === '', 'a lost key leads to the login screen');
    equal(errors, [], 'no script errors');
});

test('a key that the browser lost leads to the login screen, not a broken page', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const storage = { 'deskhog-key': 'a'.repeat(32) };    // a key the device does not know
    const { window, document, errors } = await openPage(device, { storage });
    check(loginShown(document), 'the screen shows');
    equal(window.sessionKey(), '', 'the old key is gone');
    check(!('deskhog-key' in storage), 'and is not kept');
    await typePassword(window, document, 'correct horse battery');
    check(!loginShown(document), 'and logging in works');
    delete storage['deskhog-key'];   // someone clears the site's data
    await window.refresh();
    check(!loginShown(document), 'the page goes on with the key in memory');
    equal(errors, [], 'no script errors');
    const again = await openPage(device, { storage });
    check(loginShown(again.document), 'a reload then asks again');
});

test('a reload stays logged in', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const storage = {};
    const first = await openPage(device, { storage });
    await typePassword(first.window, first.document, 'correct horse battery');
    const second = await openPage(device, { storage });
    check(!loginShown(second.document), 'no login screen');
    equal(titles(second.document).length, 5, 'the cards are there');
});

test('a device that lost its password does not ask for the old key', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { storage: { 'deskhog-key': 'b'.repeat(32) } });
    check(!loginShown(document), 'no login screen');
    equal(titles(document).length, 5, 'the page works');
    equal(window.sessionKey(), '', 'the key is forgotten (the password panel tells why)');
});

test('a rename takes the key along', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const { window, document } = await openPage(device, { hash: '#device' });
    await typePassword(window, document, 'correct horse battery');
    const key = window.sessionKey();
    const went = [];
    window.goTo = address => went.push(address);
    const name = document.querySelector('#name-form input');
    name.value = 'kitchen';
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
    await click(window, buttonNamed(document.getElementById('name-form'), 'Save'));
    await new Promise(resolve => window.setTimeout(resolve, 2100));
    equal(went, ['http://kitchen.local/#device&key=' + key], 'the new address carries the key');
    const there = await openPage(device, { origin: 'http://kitchen.local/', hash: '#device&key=' + key, storage: {} });
    check(!loginShown(there.document), 'the new address opens the page');
    equal(there.window.sessionKey(), key, 'it holds the key');
    equal(there.window.location.hash, '#device', 'and the address no longer shows it');
    const bad = await openPage(device, { hash: '#device&key=nothex', storage: {} });
    equal(bad.window.location.hash, '#device', 'an address with something else there is cleaned too');
    check(loginShown(bad.document), 'and gives no key');
});

test('an update on a locked device goes through its updater', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const { window, document } = await openPage(device, { hash: '#device', storage: { 'deskhog-key': device.loginKey() } });
    window.firmwarePause = 0;
    check(text(document.getElementById('firmware-box')).includes('Firmware 0.5.0 is available'), 'the update is offered');
    await click(window, document.getElementById('firmware-update'));
    for (let i = 0; i < 6; i++) await settle(window);
    equal(device.firmware.installed.length, 1, 'the updater took the firmware');
    const upload = lastRequest(device, '/api/firmware');
    equal(upload.headers.authorization, 'Bearer ' + window.sessionKey(), 'the upload carried the key');
    check(!loginShown(document), 'and the login screen never came up');
    check(text(document.getElementById('notice')).includes('now runs firmware 0.5.0'), 'the page says so');
});

// ------------------------------------------------------------ the password panel

/** A page on the Device tab, logged in to a locked pretend device (or open, with `locked` false). */
async function devicePage(device, extra) {
    const key = device.access.password ? device.loginKey() : '';
    const page = await openPage(device, Object.assign({ hash: '#device', storage: key ? { 'deskhog-key': key } : {} }, extra));
    page.key = key;
    return page;
}
/** Clicks, then waits for the maths and what follows. */
async function work(window, node) {
    node.click();
    await new Promise(resolve => window.setTimeout(resolve, 80));
    await settle(window);
}
const fillIn = (document, id, value) => { document.getElementById(id).value = value; };
const posted = (device, url) => device.requests.filter(r => r.method === 'POST' && r.url === url);
const panelText = document => text(document.getElementById('password-panel'));
const noticeText = document => text(document.getElementById('notice'));

test('no password: the panel says so and offers to set one', async () => {
    const device = makeDevice();
    const { document, errors } = await devicePage(device);
    check(panelText(document).includes('No password. Anyone on your network can change this DeskHog.'), 'it says so');
    check(!!document.getElementById('set-password-btn'), 'and offers to set one');
    check(!document.getElementById('message-keys'), 'no keys for messages without a password');
    check(!document.getElementById('password-panel').hidden, 'the panel shows');
    equal(document.getElementById('password-panel').querySelector('h2').textContent, 'Password', 'headed Password');
    equal(errors, [], 'no script errors');
});

test('setting a password logs this browser in', async () => {
    const device = makeDevice();
    const { window, document, errors } = await devicePage(device);
    await click(window, document.getElementById('set-password-btn'));
    for (const id of ['new-password', 'new-password-again']) {
        equal([document.getElementById(id).type, document.getElementById(id).autocomplete], ['password', 'new-password'], id + ' is a password field for a new password');
    }
    fillIn(document, 'new-password', '1234567');
    fillIn(document, 'new-password-again', '1234567');
    await work(window, document.getElementById('save-password-btn'));
    check(/8 characters/.test(noticeText(document)), 'seven characters are refused, with the reason');
    equal(posted(device, '/api/password').length, 0, 'and nothing is sent');
    fillIn(document, 'new-password', 'correct horse battery');
    fillIn(document, 'new-password-again', 'correct horse batterx');
    await work(window, document.getElementById('save-password-btn'));
    check(/not the same/.test(noticeText(document)), 'two that differ are refused');
    equal(posted(device, '/api/password').length, 0, 'and nothing is sent');
    // Eight characters as the user sees them: an emoji is one.
    fillIn(document, 'new-password', '😀😀😀😀😀😀😀');
    fillIn(document, 'new-password-again', '😀😀😀😀😀😀😀');
    await work(window, document.getElementById('save-password-btn'));
    equal(posted(device, '/api/password').length, 0, 'seven emoji are seven characters');
    fillIn(document, 'new-password', 'correct horse battery');
    fillIn(document, 'new-password-again', 'correct horse battery');
    await work(window, document.getElementById('save-password-btn'));
    const sent = posted(device, '/api/password');
    equal(sent.length, 1, 'one request');
    equal(Object.keys(sent[0].body).sort(), ['rounds', 'salt', 'verifier'], 'with a salt, the rounds and a verifier, and no field for the password');
    check(hex(32).test(sent[0].body.salt) && hex(64).test(sent[0].body.verifier), 'in lower case hex');
    equal(sent[0].body.rounds, 100, 'with the rounds the page uses');
    equal(sent[0].body.verifier, login.passwordVerifier('correct horse battery', sent[0].body.salt, 100), 'the verifier is the password\'s');
    check(!JSON.stringify(sent[0]).includes('correct horse battery'), 'the password is nowhere in the request');
    equal(device.access.password.verifier, sent[0].body.verifier, 'the device keeps the verifier');
    equal(device.access.logins.length, 1, 'there is a login key');
    equal(window.sessionKey(), device.access.logins[0], 'which is this browser\'s');
    check(panelText(document).includes('On. This browser is logged in.'), 'the panel says it is on');
    check(!document.getElementById('new-password'), 'and the form is gone');
    check(!!document.getElementById('message-keys'), 'the keys for messages show');
    equal(errors, [], 'no script errors');
});

test('changing the password needs the old one and sends the new one masked', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const other = device.loginKey();
    const { window, document, key, errors } = await devicePage(device);
    await click(window, document.getElementById('change-password-btn'));
    equal([document.getElementById('current-password').type, document.getElementById('current-password').autocomplete], ['password', 'current-password'], 'the current password is asked for');
    fillIn(document, 'current-password', 'not the password');
    fillIn(document, 'new-password', 'a better horse staple');
    fillIn(document, 'new-password-again', 'a better horse staple');
    const before = device.access.password.verifier;
    await work(window, document.getElementById('save-password-btn'));
    equal(noticeText(document), 'That is not the password.', 'a wrong current password is said in the device\'s words');
    equal([device.access.password.verifier, window.sessionKey(), device.access.logins.includes(other)], [before, key, true], 'nothing changed');
    fillIn(document, 'current-password', 'correct horse battery');
    await work(window, document.getElementById('save-password-btn'));
    const sent = posted(device, '/api/password');
    const body = sent[sent.length - 1].body;
    equal(Object.keys(body).sort(), ['nonce', 'proof', 'rounds', 'salt', 'verifier'], 'a proof, the new salt and rounds, and the masked verifier');
    check(hex(32).test(body.salt) && hex(64).test(body.verifier) && hex(64).test(body.proof), 'in hex');
    const fresh = login.passwordVerifier('a better horse staple', body.salt, 100);
    check(body.verifier !== fresh, 'the verifier that goes out is not the new one');
    equal(device.access.password.verifier, fresh, 'the device ends with the new one');
    equal(logIn(device, 'a better horse staple').status, 200, 'a login with the new password works');
    equal(logIn(device, 'correct horse battery').status, 403, 'and the old one no longer does');
    check(!JSON.stringify(sent).includes('horse'), 'neither password is in a request');
    equal([window.sessionKey(), device.access.logins.includes(key), device.access.logins.includes(other)], [key, true, false], 'this browser stays logged in, the other login is gone');
    check(!loginShown(document), 'no login screen');
    check(!document.getElementById('current-password'), 'the form is gone');
    equal(errors, [], 'no script errors');
});

test('removing the password asks first and needs the password', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    device.access.messages.push({ id: 1, name: 'doorbell', key: 'c'.repeat(32) });
    const { window, document, errors } = await devicePage(device);
    const asked = [];
    let answer = false;
    window.confirm = question => { asked.push(question); return answer; };
    await click(window, document.getElementById('remove-password-btn'));
    equal(asked.length, 1, 'it asks first');
    check(!document.getElementById('current-password'), 'and on no, goes no further');
    answer = true;
    await click(window, document.getElementById('remove-password-btn'));
    check(!!document.getElementById('current-password') && !document.getElementById('new-password'), 'on yes it asks for the password, and for no new one');
    fillIn(document, 'current-password', 'wrong wrong wrong');
    await work(window, document.getElementById('save-password-btn'));
    equal(noticeText(document), 'That is not the password.', 'a wrong password does not remove it');
    check(device.access.password !== null, 'the password is still there');
    fillIn(document, 'current-password', 'correct horse battery');
    await work(window, document.getElementById('save-password-btn'));
    const sent = posted(device, '/api/password');
    equal(Object.keys(sent[sent.length - 1].body).sort(), ['nonce', 'proof', 'remove'], 'a proof and remove');
    equal(sent[sent.length - 1].body.remove, true, 'remove is true');
    equal([device.access.password, device.access.logins, device.access.messages], [null, [], []], 'the password and every key are gone');
    equal(window.sessionKey(), '', 'the browser forgot its key');
    check(panelText(document).includes('No password'), 'the panel shows the no-password state');
    await window.refresh();
    check(!noticeText(document).includes('removed at the DeskHog'), 'it does not tell its own doing as news');
    check(!loginShown(document), 'no login screen');
    equal(errors, [], 'no script errors');
});

test('log out, and log out everywhere else', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    device.loginKey();
    device.loginKey();
    const { window, document, key, errors } = await devicePage(device);
    check(panelText(document).includes('and 2 other browsers or computers'), 'two others are logged in');
    await click(window, document.getElementById('logout-others-btn'));
    equal(device.access.logins, [key], 'only this browser is left on the device');
    equal(lastRequest(device, '/api/logout').url, '/api/logout?others=1', 'by asking for the others');
    check(panelText(document).includes('On. This browser is logged in.') && !panelText(document).includes('other browser'), 'and the count is refreshed');
    check(!loginShown(document), 'this browser is still in');
    await click(window, document.getElementById('logout-btn'));
    equal(device.access.logins, [], 'the key is gone on the device');
    equal(window.sessionKey(), '', 'and in the browser');
    check(loginShown(document), 'the login screen shows');
    equal(errors, [], 'no script errors');
});

test('message keys can be added, copied and removed', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const { window, document, errors } = await devicePage(device);
    check(panelText(document).includes('Add &auth=<key> to the message address, or send the header Authorization: Bearer <key>.'), 'it says how a key is used');
    fillIn(document, 'key-name', 'doorbell');
    await click(window, document.getElementById('add-key-btn'));
    equal(posted(device, '/api/keys')[0].body, { name: 'doorbell' }, 'the name goes to the device');
    equal(device.access.messages.length, 1, 'the device has the key');
    const list = document.getElementById('message-keys');
    check(text(list).includes('doorbell') && text(list).includes(device.access.messages[0].key), 'the list shows the name and the whole key as text');
    equal(document.getElementById('key-name').value, '', 'the name field is emptied');
    // Copy: with a clipboard, it goes there.
    const copied = [];
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied.push(value); } } });
    await click(window, buttonNamed(list, 'Copy'));
    equal(copied, [device.access.messages[0].key], 'Copy puts the key on the clipboard');
    // The device's refusals are shown.
    fillIn(document, 'key-name', '');
    await click(window, document.getElementById('add-key-btn'));
    check(noticeText(document).includes('name is 1 to 24'), 'a bad name gets the device\'s reason');
    for (let i = 2; i <= 8; i++) device.access.messages.push({ id: i + 10, name: 'k' + i, key: String(i).repeat(32) });
    fillIn(document, 'key-name', 'ninth');
    await click(window, document.getElementById('add-key-btn'));
    equal(noticeText(document), 'There are 8 message keys. Remove one first.', 'a ninth key is refused with the device\'s words');
    // Names are text.
    device.access.messages[1].name = '<img src=x onerror=alert(1)>';
    await window.refresh();
    check(!document.querySelector('#message-keys img') && text(document.getElementById('message-keys')).includes('<img src=x'), 'a name is shown as text, not as HTML');
    // Remove asks first.
    const id = device.access.messages[0].id;
    let answer = false;
    window.confirm = () => answer;
    await click(window, buttonNamed(document.getElementById('message-keys'), 'Remove'));
    equal(device.requests.filter(r => r.method === 'DELETE').length, 0, 'on no nothing is removed');
    answer = true;
    await click(window, buttonNamed(document.getElementById('message-keys'), 'Remove'));
    equal(lastRequest(device, '/api/keys?id=').url, '/api/keys?id=' + id, 'on yes the key goes');
    check(!device.access.messages.some(m => m.id === id), 'the device no longer has it');
    check(!text(document.getElementById('message-keys')).includes('doorbell'), 'nor does the list');
    equal(errors, [], 'no script errors');
});

test('the panel counts the other logins', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    device.loginKey();
    const { window, document } = await devicePage(device);
    check(panelText(document).includes('On. This browser is logged in, and 1 other browser or computer.'), 'one other, in the singular');
    device.loginKey();
    device.loginKey();
    await window.refresh();
    check(panelText(document).includes('On. This browser is logged in, and 3 other browsers or computers.'), 'three others');
    device.access.logins = device.access.logins.slice(0, 1).concat(window.sessionKey());
    await window.refresh();
    check(panelText(document).includes('On. This browser is logged in, and 1 other'), 'fewer again');
});

test('an old updater is pointed out where the password is', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    device.access.updater = 1;
    const { window, document } = await devicePage(device);
    check(panelText(document).includes('from before passwords') && panelText(document).includes('pio run -e updater -t upload'), 'the panel says so and names the fix');
    const asked = [];
    window.confirm = question => { asked.push(question); return false; };
    await click(window, document.getElementById('firmware-update'));
    check(asked[0].includes('from before passwords') && asked[0].includes('pio run -e updater -t upload'), 'the update confirmation repeats it');
    device.access.updater = 2;
    await window.refresh();
    check(!panelText(document).includes('from before passwords'), 'with updater 2 the panel does not');
    await click(window, document.getElementById('firmware-update'));
    check(!asked[1].includes('from before passwords'), 'nor does the confirmation');
    device.access.updater = 1;
    device.firmware.layout = 1;
    await window.refresh();
    check(!panelText(document).includes('from before passwords'), 'on layout 1 there is no updater to warn about');
    // Without a password the warning waits for the form that sets one.
    const open = makeDevice();
    open.access.updater = 1;
    const page = await devicePage(open);
    check(!panelText(page.document).includes('from before passwords'), 'no password, no warning');
    await click(page.window, page.document.getElementById('set-password-btn'));
    check(panelText(page.document).includes('pio run -e updater -t upload'), 'but setting one shows it');
});

test('a password removed at the device is noticed', async () => {
    const device = makeDevice();
    const { window, document } = await openPage(device, { hash: '#device', storage: { 'deskhog-key': 'b'.repeat(32) } });
    check(noticeText(document).includes('removed at the DeskHog'), 'the notice says the password was removed');
    equal(window.sessionKey(), '', 'the key is forgotten');
    check(!!document.getElementById('set-password-btn'), 'and the panel offers a new one');
    // While the page is open.
    const locked = makeDevice();
    locked.lock('correct horse battery');
    const page = await devicePage(locked);
    check(!noticeText(page.document).includes('removed at'), 'not while the password is there');
    locked.access.password = null;
    locked.access.logins = [];
    await page.window.refresh();
    check(noticeText(page.document).includes('removed at the DeskHog'), 'also noticed on a refresh');
    equal(page.window.sessionKey(), '', 'and the key is forgotten');
    check(!loginShown(page.document), 'without a login screen');
});

test('a late 401 for an old key leaves the new key alone', async () => {
    const device = makeDevice();
    device.lock('correct horse battery');
    const old = device.loginKey();
    const { window, document } = await openPage(device, { storage: { 'deskhog-key': old } });
    const newer = device.loginKey();
    device.access.logins = [newer];
    const late = window.deviceFetch('/api/state');   // sent with the old key, which the device no longer knows
    window.setSessionKey(newer);                     // meanwhile the browser logged in again
    equal((await late).status, 401, 'the device refused the old key');
    equal(window.sessionKey(), newer, 'the new key is kept');
    check(!loginShown(document), 'and the login screen stays away');
    device.access.logins = [];
    await window.deviceFetch('/api/state');   // a 401 for the key in use still drops it
    check(window.sessionKey() === '' && loginShown(document), 'a 401 for the key in use leads to the login screen');
});

test('a locked device shows nothing until the first answer, and a device that is away shows the page', async () => {
    const locked = makeDevice();
    locked.lock('correct horse battery');
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const first = await openPage(locked, { hold });
    check(first.document.body.classList.contains('locked') && !loginShown(first.document), 'before the answer the page is hidden and nothing shows');
    release();
    await settle(first.window);
    check(loginShown(first.document) && first.document.body.classList.contains('locked'), 'then the login screen');
    // Not locked: the page appears with the answer.
    const open = makeDevice();
    let go;
    const wait = new Promise(resolve => { go = resolve; });
    const second = await openPage(open, { hold: wait });
    check(second.document.body.classList.contains('locked'), 'hidden while waiting');
    go();
    await settle(second.window);
    check(!second.document.body.classList.contains('locked') && !loginShown(second.document), 'and shown when the device says it has no password');
    equal(titles(second.document).length, 5, 'with its cards');
    // Away: the first call fails.
    let fail;
    const gone = new Promise((resolve, reject) => { fail = reject; });
    const third = await openPage(makeDevice(), { hold: gone });
    fail(new Error('away'));
    await settle(third.window);
    check(!third.document.body.classList.contains('locked') && !loginShown(third.document), 'when the first call fails the page shows as it did');
    equal(titles(third.document).length, 5, 'with its cards');
});

(async () => {
    for (const { name, body } of tests) {
        const before = failures;
        try {
            await body();
        } catch (error) {
            failures++;
            console.log('  FAIL threw: ' + (error.stack || error));
        }
        console.log((failures === before ? 'ok   ' : 'FAIL ') + name);
    }
    console.log('\n' + tests.length + ' tests, ' + checks + ' checks, ' + failures + ' failed');
    process.exit(failures ? 1 : 0);
})();
