// A pretend DeskHog: it answers the same web API the firmware serves, from
// memory. The page's tests (portal.test.js) and the development server
// (serve.js) both use it.


const crypto = require('crypto');
const login = require('../../html/login.js');

function field(key, label, extra) {
    return Object.assign({ key, label, type: 'string', default: '' }, extra || {});
}

/** The fingerprint of a plugin's source, as the firmware computes it (FNV-1a, 32 bits). */
function sourceHash(data) {
    let hash = 2166136261;
    for (const byte of Buffer.from(data)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return ('0000000' + hash.toString(16)).slice(-8);
}

const sourceOf = (title, version, extra) => '-- ' + title + '\nplugin = { name = "' + title + '", version = "' + version + '" }\n' + (extra || '');

/**
 * A pretend plugin directory, as it would sit on GitHub: an index and the files
 * it lists. Against makeDevice() it has one plugin that is the same as on the
 * device (hello), a newer one (weather 1.1), one that was changed on the device
 * (webhook) and one that is not installed (clock).
 */
function makeDirectory() {
    const files = {
        'hello.lua': 'plugin = { name = "Hello" }\n',
        'weather.lua': sourceOf('Weather', '1.1'),
        'webhook.lua': sourceOf('Webhook', '1.0', '-- as published\n'),
        'clock.lua': sourceOf('Clock', '1.0'),
    };
    const entry = (name, title, version, description) => ({
        name, title, version, description, author: 'DeskHog', file: name + '.lua',
        screenshot: name === 'hello' ? undefined : 'screenshots/' + name + '.png',   // not every plugin has a picture
        size: files[name + '.lua'].length, hash: sourceHash(files[name + '.lua']),
    });
    const index = {
        format: 1,
        plugins: [
            entry('clock', 'Clock', '1.0', 'The time in large digits'),
            entry('hello', 'Hello', '1.0', 'The smallest useful plugin'),
            entry('weather', 'Weather', '1.1', 'The temperature now, for any number of cities'),
            entry('webhook', 'Webhook', '1.0', 'A button that calls a web address'),
        ],
    };
    return { files, index };
}

/**
 * Give a pretend device a plugin that uses the newer parts of the API: settings
 * whose choices the plugin lists (`choices`), and messages pushed to it. It has
 * one connection ("homey") with one card ("homey:1").
 */
function addHomey(device) {
    device.plugins.push({
        name: 'homey', title: 'Homey', multiCard: true, message: true,
        config: [field('url', 'Address'), field('home', 'Home', { choices: true })],
        kinds: [
            { key: 'device', name: 'Device', message: true, config: [field('device', 'Device', { choices: true }), field('label', 'Label')] },
            { key: 'flow', name: 'Flow', config: [field('flow', 'Flow', { choices: true })] },
        ],
        source: 'plugin = { name = "Homey" }\n', version: '1.0', hash: sourceHash('plugin = { name = "Homey" }\n'),
    });
    device.connections.push({ id: 'homey', plugin: 'homey', name: 'Homey', settings: { url: 'http://homey.local' }, secretsSet: [], state: 'running', memory: 20000 });
    device.cards.push({ type: 'PLUGIN', config: 'homey:1', name: 'Device', plugin: 'homey', connection: 'homey', card: '1', kind: 'device', settings: { device: 'lamp' }, frames: 1, onScreen: false });
    // What the plugin answers, by "<connection>/<kind>/<field>". A string is an error it reports.
    device.choices['homey/device/device'] = [{ value: 'lamp', label: 'Kitchen lamp' }, { value: 'plug', label: 'Coffee machine' }];
    device.choices['homey/flow/flow'] = 'log in to Homey first';
    device.choices['homey//home'] = [{ value: 'h1', label: 'Home' }];
    return device;
}

function makeDevice() {
    const device = {
        requests: [],
        notifications: [],   // what plugins said with notify() that nobody has seen yet: {card, text, count, age}
        messages: [],        // what was pushed to plugins: {card | connection, body}
        choices: {},         // lists plugins offer for settings, see addHomey()
        choiceForms: [],     // what each list was asked with: {key, form}, the form being the page's &settings=
        choicePolls: {},     // how often each was asked for: the first answer is "pending", as on the device
        directory: { source: 'TimBroddin/DeskHog', default: 'TimBroddin/DeskHog' },
        timezone: { posix: 'UTC0', name: '' },   // as on a new device
        restarts: 0,         // how often the page asked for a restart
        // The firmware and its updater. `inUpdater` is the device after POST /api/update/start;
        // `failUploads` makes that many uploads fail, as a broken connection would.
        firmware: { version: '0.4.0', layout: 2, repo: 'TimBroddin/DeskHog', inUpdater: false, failUploads: 0, installed: [] },
        release: { version: '0.5.0', layout: 2, size: 12, sha256: 'abc123', file: 'deskhog-update.bin', notes: 'https://example.com/notes' },
        device: {            // the device's own settings, as a new one has them; see POST /api/device
            name: 'deskhog',
            screen: { day: 80, night: 10 },
            led: { day: 100, night: 0 },
            night: { enabled: false, from: '22:00', until: '07:00' },
            rotate: { seconds: 0 },
            battery: false,
            status: { night: false, manual: false, battery: null, gauge: { percent: 100, volts: 4.2, charging: false } },
        },
        internet: makeDirectory(),   // what the browser finds at the directory's address; null for "no internet"
        wifiConnected: true,
        // Who may call what: see "The access part" below. Times are in milliseconds on `now`, which tests move.
        now: 0,
        access: { password: null, logins: [], messages: [], nonces: [], updater: 2 },
        plugins: [
            { name: 'friend', title: 'Max', multiCard: false, config: [field('messages', 'Your own messages, separated by |')], kinds: [{ key: 'main', name: 'Max', config: [] }] },
            { name: 'hello', title: 'Hello', multiCard: false, config: [], kinds: [{ key: 'main', name: 'Hello', config: [] }] },
            {
                name: 'webhook', title: 'Webhook', multiCard: false,
                config: [field('url', 'Webhook URL'), field('token', 'Token', { secret: true }), field('label', 'Button label', { default: 'Send' })],
                kinds: [{ key: 'main', name: 'Webhook', config: [] }],
            },
            {
                name: 'weather', title: 'Weather', multiCard: true,
                config: [field('unit', 'Unit', { default: 'C', options: ['C', 'F'] })],
                kinds: [{ key: 'city', name: 'City', config: [field('city', 'City', { default: 'Antwerp' })] }],
            },
            {
                name: 'posthog', title: 'PostHog', multiCard: true,
                config: [field('host', 'Host', { default: 'https://eu.posthog.com' }), field('key', 'API key', { secret: true })],
                kinds: [
                    { key: 'funnel', name: 'Funnel', config: [field('id', 'Funnel ID')] },
                    { key: 'insight', name: 'Insight', config: [field('id', 'Insight ID'), field('compact', 'Compact', { type: 'boolean', default: 'false' })] },
                ],
            },
            { name: 'broken', title: 'broken', multiCard: false, error: 'broken:3: unexpected symbol', config: [], kinds: [] },
        ],
        connections: [
            { id: 'hello', plugin: 'hello', name: 'Hello', settings: {}, secretsSet: [], state: 'running', memory: 12000 },
            { id: 'webhook', plugin: 'webhook', name: 'Webhook', settings: { url: 'http://example.com/hook', label: 'Deploy' }, secretsSet: ['token'], state: 'running', memory: 14000 },
            { id: 'weather', plugin: 'weather', name: 'Weather', settings: { unit: 'C' }, secretsSet: [], state: 'running', memory: 30000 },
            { id: 'posthog', plugin: 'posthog', name: 'Work', settings: { host: 'https://eu.posthog.com' }, secretsSet: ['key'], state: 'failed', error: 'posthog:12: 401 unauthorized' },
        ],
        cards: [
            { type: 'PLUGIN', config: 'weather:1', name: 'City', plugin: 'weather', connection: 'weather', card: '1', kind: 'city', settings: { city: 'Lisbon' }, title: 'Lisbon', frames: 3, onScreen: true },
            { type: 'PLUGIN', config: 'weather:2', name: 'Home', plugin: 'weather', connection: 'weather', card: '2', kind: 'city', settings: { city: 'Antwerp' }, title: 'Antwerp', frames: 1, onScreen: false },
            { type: 'PLUGIN', config: 'hello:1', name: 'Hello', plugin: 'hello', connection: 'hello', card: '1', kind: 'main', settings: {}, frames: 2, onScreen: false },
            { type: 'PLUGIN', config: 'webhook:1', name: 'Webhook', plugin: 'webhook', connection: 'webhook', card: '1', kind: 'main', settings: {}, frames: 2, onScreen: false },
            { type: 'PLUGIN', config: 'posthog:1', name: 'Insight', plugin: 'posthog', connection: 'posthog', card: '1', kind: 'insight', settings: { id: '42' }, frames: 1, onScreen: false },
        ],
    };

    const json = (data, status) => ({ status: status || 200, body: JSON.stringify(data), type: 'application/json' });

    // What each plugin's file says, and what the firmware reads from it.
    const sources = { hello: 'plugin = { name = "Hello" }\n', weather: sourceOf('Weather', '1.0'), webhook: sourceOf('Webhook', '1.0', '-- edited on the device\n') };
    for (const plugin of device.plugins) {
        plugin.source = sources[plugin.name] || sourceOf(plugin.title, '1.0');
        plugin.version = '1.0';
        plugin.hash = sourceHash(plugin.source);
    }

    device.state = () => ({
        directory: device.directory,
        timezone: device.timezone,
        device: deviceNow(),
        plugins: device.plugins.map(plugin => { const { source, ...rest } = plugin; return rest; }),
        connections: device.connections.map(c => Object.assign({ cards: device.cards.filter(card => card.connection === c.id).length }, c)),
        cards: device.cards.map(c => Object.assign({ key: c.type + '|' + c.config, front: true, rotate: true }, c)),
        notifications: device.notifications,
        storage: { used: 45056, total: 1048576 },
        system: { plugin_cards: 5, heap_free: 80000, psram_free: 1400000 },
    });

    // As the firmware does: the object as it is now, with the battery as the gauge reports it when there is one.
    const deviceNow = () => {
        const now = JSON.parse(JSON.stringify(device.device));
        now.status.battery = now.battery && now.status.gauge ? now.status.gauge : null;
        now.status.password = !!device.access.password;
        now.status.updater = device.access.updater;
        if (device.firmware) {
            Object.assign(now.status, { firmware: device.firmware.version, layout: device.firmware.layout, update_repo: device.firmware.repo, firmware_room: 2228224 });
        }
        return now;
    };
    // As the firmware does: kinds are checked strictly, nothing is changed unless everything is right.
    const wholeNumber = (value, low, high) => typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;
    const clock = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    const checks = {
        name: value => typeof value === 'string' && /^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$/.test(value),
        screen: { day: value => wholeNumber(value, 5, 100), night: value => wholeNumber(value, 0, 100) },
        led: { day: value => wholeNumber(value, 0, 100), night: value => wholeNumber(value, 0, 100) },
        night: { enabled: value => typeof value === 'boolean', from: clock, until: clock },
        rotate: { seconds: value => value === 0 || wholeNumber(value, 10, 600) },
        battery: value => typeof value === 'boolean',
        preview: value => value === 'night' || value === 'day',
    };
    const postDevice = body => {
        const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
        if (!isObject(body)) return json({ ok: false, error: 'send a JSON object' }, 400);
        const changes = [];
        for (const [key, value] of Object.entries(body)) {
            const rule = checks[key];
            if (!rule) return json({ ok: false, error: 'unknown setting: ' + key }, 400);
            if (typeof rule === 'function') {
                if (!rule(value)) return json({ ok: false, error: key + ' is not valid' }, 400);
                if (key !== 'preview') changes.push([device.device, key, value]);
                continue;
            }
            if (!isObject(value)) return json({ ok: false, error: key + ' must be an object' }, 400);
            for (const [inner, innerValue] of Object.entries(value)) {
                if (!rule[inner]) return json({ ok: false, error: 'unknown setting: ' + key + '.' + inner }, 400);
                if (!rule[inner](innerValue)) return json({ ok: false, error: key + '.' + inner + ' is not valid' }, 400);
                changes.push([device.device[key], inner, innerValue]);
            }
        }
        for (const [where, key, value] of changes) where[key] = value;
        return json(deviceNow());
    };

    device.id = 'a1b2c3d4e5f6';   // 12 hex digits, the same in the firmware and the updater

    /** Sets a password (100 rounds, so tests stay quick) as the page would: the device keeps only the verifier. */
    device.lock = password => {
        const salt = random(16);
        device.access.password = { salt, rounds: 100, verifier: login.passwordVerifier(password, salt, 100) };
    };
    /** Adds a login key, as a login would, and gives it. */
    device.loginKey = () => {
        const key = random(16);
        addLogin(key);
        return key;
    };

    // ---------------------------------------------------- the access part
    //
    // A copy of the firmware's rules: decideAccess() in lib/access/src/Access.cpp
    // (the rule numbers below are its) and the handlers in src/plugins/AccessApi.cpp,
    // with the same statuses, texts and order of checks. Change one, change the other.
    // The pretend device has no "device itself" caller, so rule 4 is not here.

    const state = {
        issued: {},        // nonce -> when it was handed out
        wrongInARow: 0, locked: false, lockedAt: 0,   // LoginGuard
        ids: {},           // login key -> its id; message keys carry theirs
        updaterLogins: [], // keys from a login made in the updater, forgotten when it is left
    };
    const NONCE_MS = 60000, WAIT_MS = 60000, WRONG_TRIES = 5, MAX_NONCES = 16, MAX_KEYS = 8, MAX_NAME = 24, MAX_ROUNDS = 10000000;
    const random = bytes => crypto.randomBytes(bytes).toString('hex');
    const sameText = (a, b) => a.toLowerCase() === b.toLowerCase();
    const isHex = (value, bytes) => typeof value === 'string' && new RegExp('^[0-9a-fA-F]{' + bytes * 2 + '}$').test(value);
    const refuse = (status, error) => json(status === 401 ? { ok: false, locked: true, error } : { ok: false, error }, status);
    const LOCKED = 'This DeskHog has a password. Log in first.';
    const NO_PASSWORD = 'This DeskHog has no password.';

    // The keys. Login and message keys share one list of ids, as in AccessTable.
    const nextId = () => Math.max(0, ...device.access.messages.map(m => m.id), ...device.access.logins.map(k => state.ids[k] || 0)) + 1;
    const loginsNow = () => (device.firmware && device.firmware.inUpdater ? device.access.logins.concat(state.updaterLogins) : device.access.logins);
    /** The key as AccessTable::find has it: {kind, key, id, name}, or null. Messages are not known in the updater. */
    const findKey = key => {
        if (!isHex(key, 16)) return null;
        const wanted = key.toLowerCase();
        if (loginsNow().includes(wanted)) return { kind: 'login', key: wanted, id: state.ids[wanted] || 0 };
        const message = device.firmware && device.firmware.inUpdater ? null : device.access.messages.find(m => m.key === wanted);
        return message ? { kind: 'message', key: wanted, id: message.id, name: message.name } : null;
    };
    const addLogin = key => {
        const logins = device.access.logins;
        if (logins.length >= MAX_KEYS) delete state.ids[logins.shift()];   // the oldest goes
        state.ids[key] = nextId();
        logins.push(key);
    };
    const removeLoginsExcept = key => {
        const keep = findKey(key);
        device.access.logins = device.access.logins.filter(k => keep && keep.kind === 'login' && k === keep.key);
        for (const k of Object.keys(state.ids)) if (!device.access.logins.includes(k)) delete state.ids[k];
    };

    // The login guard: nonces that work once for a minute, and the wait after five wrong proofs.
    const dropOld = () => {
        device.access.nonces = device.access.nonces.filter(n => device.now - state.issued[n] < NONCE_MS);
    };
    const issueNonce = () => {
        dropOld();
        if (device.access.nonces.length >= MAX_NONCES) device.access.nonces.shift();
        const nonce = random(16);
        state.issued[nonce] = device.now;
        device.access.nonces.push(nonce);
        return nonce;
    };
    const takeNonce = nonce => {
        dropOld();
        const at = device.access.nonces.indexOf(nonce);   // exactly as given, as in the firmware
        if (at < 0) return false;
        device.access.nonces.splice(at, 1);
        return true;
    };
    const waiting = () => {
        if (state.locked && device.now - state.lockedAt >= WAIT_MS) state.locked = false;
        return state.locked;
    };
    const wrongProof = () => {
        if (waiting()) return;
        if (++state.wrongInARow >= WRONG_TRIES) { state.locked = true; state.lockedAt = device.now; state.wrongInARow = 0; }
    };
    const hmac = (verifier, message) => crypto.createHmac('sha256', Buffer.from(verifier, 'hex')).update(message).digest();
    const proofIsRight = (nonce, proof) => hmac(device.access.password.verifier, Buffer.from(nonce, 'hex')).toString('hex') === proof.toLowerCase();

    /** The body as readJson() makes it: an answer to give instead when there is none. */
    const readJson = body => {
        if (Buffer.isBuffer(body)) body = body.toString('utf8');
        if (body === undefined || body === null || body === '') return { answer: refuse(400, 'send a JSON body, labelled application/json') };
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (error) { return { answer: refuse(400, 'the body is not valid JSON') }; }
        }
        return { body };
    };
    const fail = (status, error) => ({ answer: refuse(status, error) });
    const fieldOf = (body, name) => (body && typeof body === 'object' && !Array.isArray(body) ? body[name] : undefined);
    const readProof = body => {
        if (!isHex(fieldOf(body, 'nonce'), 16)) return fail(400, 'nonce is the 32 hex digits GET /api/login gave');
        if (!isHex(fieldOf(body, 'proof'), 32)) return fail(400, 'proof is 64 hex digits');
        return { nonce: body.nonce, proof: body.proof };
    };
    const readPassword = body => {
        if (!isHex(fieldOf(body, 'salt'), 16)) return fail(400, 'salt is 32 hex digits');
        const rounds = fieldOf(body, 'rounds');
        if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) return fail(400, 'rounds is a whole number from 1 to 10000000');
        if (!isHex(fieldOf(body, 'verifier'), 32)) return fail(400, 'verifier is 64 hex digits');
        return { salt: body.salt.toLowerCase(), rounds, verifier: body.verifier.toLowerCase() };
    };
    /** Every use of a proof, in this order: waiting, the nonce used up, then the proof. An answer when it is refused. */
    const useProof = (nonce, proof) => {
        if (waiting()) return refuse(429, 'Too many wrong tries. Wait a minute.');
        if (!takeNonce(nonce)) return refuse(403, 'That took too long. Try again.');
        if (!proofIsRight(nonce, proof)) { wrongProof(); return refuse(403, 'That is not the password.'); }
        state.wrongInARow = 0;
        state.locked = false;
        return null;
    };

    // GET: what a client needs to log in, and a fresh nonce. POST: a proof for a login key.
    const handleLogin = (method, body) => {
        if (method !== 'GET' && method !== 'POST') return refuse(405, 'GET or POST /api/login');
        const password = device.access.password;
        if (method === 'GET') {
            const nonce = issueNonce();
            return json({ locked: !!password, name: device.device.name, id: device.id, salt: password ? password.salt : '', rounds: password ? password.rounds : 0, nonce });
        }
        const read = readJson(body);
        if (read.answer) return read.answer;
        if (!password) return refuse(409, NO_PASSWORD);
        const proof = readProof(read.body);
        if (proof.answer) return proof.answer;
        const refused = useProof(proof.nonce, proof.proof);
        if (refused) return refused;
        const key = random(16);
        if (device.firmware && device.firmware.inUpdater) state.updaterLogins.push(key);   // not saved: gone when the updater is left
        else addLogin(key);
        return json({ ok: true, key });
    };

    // Setting the first password, changing it with a proof of the old one, or removing it.
    const handlePassword = (method, body, found) => {
        if (method !== 'POST') return refuse(405, 'POST /api/password');
        const read = readJson(body);
        if (read.answer) return read.answer;
        body = read.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(400, 'send a JSON object');
        const given = name => body[name] !== undefined && body[name] !== null;
        if (!device.access.password) {
            if (given('remove') || given('nonce') || given('proof')) return refuse(409, NO_PASSWORD);
            const password = readPassword(body);
            if (password.answer) return password.answer;
            device.access.password = { salt: password.salt, rounds: password.rounds, verifier: password.verifier };
            const key = random(16);
            addLogin(key);
            return json({ ok: true, key });
        }
        if (!found || found.kind !== 'login') return refuse(401, LOCKED);
        const proof = readProof(body);
        if (proof.answer) return proof.answer;
        const remove = given('remove');
        if (remove && body.remove !== true) return refuse(400, 'remove is true, or left out');
        // Checked before the proof, so a malformed change does not use up the nonce.
        const password = remove ? null : readPassword(body);
        if (password && password.answer) return password.answer;
        const refused = useProof(proof.nonce, proof.proof);
        if (refused) return refused;
        if (remove) {
            device.access.password = null;
            device.access.logins = [];
            device.access.messages = [];
            state.ids = {};
            return json({ ok: true });
        }
        const pad = hmac(device.access.password.verifier, Buffer.concat([Buffer.from(proof.nonce, 'hex'), Buffer.from('new')]));
        const verifier = Buffer.from(password.verifier, 'hex').map((byte, i) => byte ^ pad[i]).toString('hex');
        device.access.password = { salt: password.salt, rounds: password.rounds, verifier };
        removeLoginsExcept(found.key);
        return json({ ok: true });
    };

    // The message keys, and how many login keys there are.
    const handleKeys = (method, body, params) => {
        if (!['GET', 'POST', 'DELETE'].includes(method)) return refuse(405, 'GET, POST or DELETE /api/keys');
        if (method === 'GET') return json({ logins: device.access.logins.length, messages: device.access.messages.map(({ id, name, key }) => ({ id, name, key })) });
        if (method === 'DELETE') {
            const text = params.get('id') || '';
            const id = /^\s*[+-]?\d+$/.test(text) ? parseInt(text, 10) : 0;
            if (id < 1) return refuse(400, 'id is the number of a message key');
            const at = device.access.messages.findIndex(m => m.id === id);
            if (at < 0) return refuse(404, 'no such key');
            device.access.messages.splice(at, 1);
            return json({ ok: true });
        }
        const read = readJson(body);
        if (read.answer) return read.answer;
        const name = fieldOf(read.body, 'name');
        if (!device.access.password) return refuse(409, 'Set a password first.');
        if (device.access.messages.length >= MAX_KEYS) return refuse(409, 'There are 8 message keys. Remove one first.');
        if (typeof name !== 'string' || !Buffer.byteLength(name) || Buffer.byteLength(name) > MAX_NAME || [...Buffer.from(name)].some(byte => byte < 0x20)) {
            return refuse(400, 'name is 1 to 24 bytes, without control characters');
        }
        const added = { id: nextId(), name, key: random(16) };
        device.access.messages.push(added);
        return json({ ok: true, id: added.id, name: added.name, key: added.key });
    };

    // Removes the key the request came with, or with ?others=1 every other login key.
    const handleLogout = (method, params, found) => {
        if (method !== 'POST') return refuse(405, 'POST /api/logout');
        if (!found) return json({ ok: true });
        const others = params.get('others');
        if (others !== null && others !== '0') removeLoginsExcept(found.key);
        else if (found.kind === 'login') {
            device.access.logins = device.access.logins.filter(k => k !== found.key);
            state.updaterLogins = state.updaterLogins.filter(k => k !== found.key);
            delete state.ids[found.key];
        } else device.access.messages = device.access.messages.filter(m => m.key !== found.key);
        return json({ ok: true });
    };

    // The only calls the updater has.
    const UPDATER_CALLS = ['/api/status', '/api/login', '/api/firmware', '/api/restart'];
    const READS = ['/api/status', '/api/login', '/api/state', '/api/device', '/api/keys', '/api/cards/screen', '/api/connections/choices'];
    const onlyReads = pathname => READS.includes(pathname) || pathname.startsWith('/api/plugins');
    // A body over 1 KB on the four access calls (and below them), or over 64 KB anywhere.
    const ACCESS_CALLS = ['/api/login', '/api/password', '/api/keys', '/api/logout'];
    const tooLarge = (pathname, body) => {
        const size = body === undefined || body === null ? 0
            : typeof body === 'string' || Buffer.isBuffer(body) ? Buffer.byteLength(body) : Buffer.byteLength(JSON.stringify(body));
        return size > 65536 || (size > 1024 && ACCESS_CALLS.some(route => pathname === route || pathname.startsWith(route + '/')));
    };

    // The firmware and its updater share this; `inUpdater` says which one is asked.
    device.handle = (method, url, body, headers) => {
        headers = headers || {};
        const [pathname, query] = url.split('?');
        const params = new URLSearchParams(query || '');
        const inUpdater = !!(device.firmware && device.firmware.inUpdater);
        if (!inUpdater) state.updaterLogins = [];
        const locked = !!device.access.password;

        // 1. Only the API is protected.
        if (!sameText(pathname.slice(0, 5), '/api/')) return serve(method, url, body);
        // 2. Another website.
        if (headers.origin && !sameText(headers.origin, 'http://' + (headers.host || 'deskhog.local'))) return refuse(403, 'This request came from another website.');
        // 3. Nothing answers a preflight.
        if (method === 'OPTIONS') return refuse(405, 'This call is not answered.');
        // (4. The device calling itself is not pretended.)
        if (inUpdater && !UPDATER_CALLS.includes(pathname)) return { status: 404, body: 'The updater has no such page.' };

        // 5. The key it came with: the bearer, or a message key in the address.
        const authorization = headers.authorization || '';
        const bearer = /^bearer /i.test(authorization) && authorization.length > 7 ? authorization.slice(7) : '';
        let found = bearer ? findKey(bearer) : null;
        if (!found && params.get('auth')) {
            const address = findKey(params.get('auth'));
            if (address && address.kind === 'message') found = address;
        }
        const loginKey = !!found && found.kind === 'login';
        const full = !locked || loginKey;

        // 6. Open without a key: logging in, and the status the page asks for before it can log in.
        const open = pathname === '/api/login' && (method === 'GET' || method === 'POST');
        const openStatus = pathname === '/api/status' && method === 'GET';
        // 7. With a password, the message calls want any key and everything else a login key.
        if (locked && !open && !openStatus) {
            const messageCall = pathname === '/api/cards/message' || pathname === '/api/connections/message';
            if (!(messageCall ? found : loginKey)) return refuse(401, LOCKED);
        }
        // 8. Reads. Only POST, PUT and DELETE may change something.
        if (!['POST', 'PUT', 'DELETE'].includes(method) && !onlyReads(pathname)) return refuse(405, 'This call changes something. Use POST.');
        // What the rules let through may still be too large: EarlyHandler in AccessApi.cpp. Not in the updater.
        if (!inUpdater && tooLarge(pathname, body)) return json({ ok: false, error: 'That is too large.' }, 413);

        // The updater has the login only; the rest of these are the firmware's.
        if (pathname === '/api/login') return handleLogin(method, body);
        if (!inUpdater) {
            if (pathname === '/api/password') return handlePassword(method, body, found);
            if (pathname === '/api/keys') return handleKeys(method, body, params);
            if (pathname === '/api/logout') return handleLogout(method, params, found);
        }
        // The status without a key says only that there is a password (and which of the two firmwares answers).
        if (openStatus && locked && !full) return json({ locked: true, updater: inUpdater });
        return serve(method, url, body);
    };

    // A card's pixels (RGB565). The real thing is a picture; this is a stand-in
    // with one colour per card, so the page has something to show.
    device.picture = key => {
        const picture = Buffer.alloc(233 * 135 * 2);
        const card = device.cards.find(c => c.config === key);
        let hash = 7;
        for (const character of String(key)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
        const color = (((hash >> 3) & 0x1f) << 11) | (((hash >> 9) & 0x3f) << 5) | ((hash >> 16) & 0x1f) | 0x0841;
        const bar = 30 + ((card && card.frames) || 0) * 17 % 150;
        for (let y = 0; y < 135; y++) {
            for (let x = 0; x < 233; x++) {
                const lit = (y > 18 && y < 30 && x > 16 && x < 110) || (y > 48 && y < 96 && x > 16 && x < 16 + bar);
                if (lit) picture.writeUInt16LE(y < 30 ? 0x8410 : color, (y * 233 + x) * 2);
            }
        }
        return picture;
    };

    // What the device does once the access part has let a request through.
    const serve = (method, url, body) => {
        const [pathname, query] = url.split('?');
        const params = new URLSearchParams(query || '');
        if (device.firmware && device.firmware.inUpdater) {
            // The updater answers only this much.
            const updater = { updater: true, version: '1', main_intact: true, slot_size: 2228224, error: '' };
            if (method === 'GET' && pathname === '/api/status') return json(updater);
            if (method === 'POST' && pathname === '/api/firmware') {
                if (device.firmware.failUploads > 0) {
                    device.firmware.failUploads--;
                    return json(Object.assign(updater, { main_intact: false, error: 'The connection was lost.' }), 400);
                }
                device.firmware.installed.push({ size: params.get('size'), sha256: params.get('sha256') });
                device.firmware.version = params.get('sha256') === device.release.sha256 ? device.release.version : 'custom';
                device.firmware.inUpdater = false;
                return json(updater);
            }
            if (method === 'POST' && pathname === '/api/restart') { device.restarts++; device.firmware.inUpdater = false; return json({ ok: true }); }
            return { status: 404, body: 'The updater has no such page.' };
        }
        if (method === 'POST' && pathname === '/api/update/start') {
            if (device.firmware.layout !== 2) return json({ ok: false, error: 'This device has the old flash layout' }, 409);
            device.firmware.inUpdater = true;
            return json({ ok: true });
        }
        if (method === 'GET' && pathname === '/api/state') return json(device.state());
        if (method === 'GET' && pathname === '/api/device') return json(deviceNow());
        if (method === 'POST' && pathname === '/api/device') return postDevice(body);
        if (method === 'POST' && pathname === '/api/restart') { device.restarts++; return json({ ok: true }); }
        if (method === 'GET' && pathname === '/api/status') {
            return json({
                firmware_version: '0.3.0',
                wifi: {
                    is_connected: device.wifiConnected, connected_ssid: 'Home WiFi', ip_address: '192.168.1.50',
                    networks: [{ ssid: 'Home WiFi', rssi: -50, encrypted: true }, { ssid: 'Home WiFi', rssi: -70, encrypted: true },
                        { ssid: '', rssi: -40, encrypted: true }, { ssid: 'Cafe', rssi: -60, encrypted: false }],
                },
            });
        }
        if (method === 'GET' && pathname === '/api/cards/screen') {
            const card = device.cards.find(c => c.config === params.get('key'));
            const frames = String((card && card.frames) || 0);
            // The page says which picture it has; one it already has is not sent again.
            if (params.get('since') === frames) return { status: 204, body: '', headers: { 'X-Frames': frames } };
            const headers = { 'X-Width': '233', 'X-Height': '135', 'X-Frames': frames };
            let picture = device.picture(params.get('key'));
            if (params.get('packed')) {
                // As the firmware does: runs of equal pixels, (how many, pixel).
                const runs = [];
                for (let at = 0; at < picture.length; ) {
                    let run = 1;
                    while (run < 255 && at + run * 2 < picture.length && picture.readUInt16LE(at + run * 2) === picture.readUInt16LE(at)) run++;
                    runs.push(run, picture[at], picture[at + 1]);
                    at += run * 2;
                }
                picture = Buffer.from(runs);
                headers['X-Packed'] = 'runs';
            }
            return { status: 200, body: picture, type: 'application/octet-stream', headers };
        }
        if (method === 'GET' && pathname === '/api/plugins/hello/status') return json({ name: 'hello', state: 'running', memory: 12288, error: '', log: ['hi', 'there'] });

        if (method === 'POST' && pathname === '/api/cards/add') {
            const plugin = device.plugins.find(p => p.name === body.plugin);
            if (!plugin) return json({ ok: false, error: 'no plugin named ' + body.plugin }, 400);
            let connection = body.connection && device.connections.find(c => c.id === body.connection);
            if (!connection) {
                connection = { id: plugin.name + '-' + (device.connections.length + 1), plugin: plugin.name, name: body.connectionName || plugin.title, settings: body.connectionSettings || {}, secretsSet: [], state: 'running' };
                device.connections.push(connection);
            }
            const id = String(device.cards.filter(c => c.connection === connection.id).length + 1);
            device.cards.push({ type: 'PLUGIN', config: connection.id + ':' + id, name: body.name || (plugin.multiCard ? plugin.kinds.find(k => k.key === body.kind).name : plugin.title), plugin: plugin.name, connection: connection.id, card: id, kind: body.kind, settings: body.settings || {}, front: body.front !== false, rotate: body.rotate !== false, frames: 0, onScreen: false });
            return json({ ok: true, key: connection.id + ':' + id });
        }
        if (method === 'POST' && pathname === '/api/cards/update') {
            const card = device.cards.find(c => c.config === params.get('key'));
            if (!card) return json({ ok: false, error: 'no such card' }, 404);
            if (body.name) card.name = body.name;
            if (typeof body.front === 'boolean') card.front = body.front;
            if (typeof body.rotate === 'boolean') card.rotate = body.rotate;
            Object.assign(card.settings, body.settings || {});
            return json({ ok: true });
        }
        if (pathname === '/api/cards/message' || pathname === '/api/connections/message') {
            // As the firmware does: the plugin's message() gets the body, if it has one.
            if (method !== 'POST') return json({ ok: false, error: 'POST the message as the request body' }, 405);
            const toCard = pathname === '/api/cards/message';
            const card = toCard ? device.cards.find(c => c.config === params.get('key')) : null;
            const connection = device.connections.find(c => c.id === (toCard ? card && card.connection : params.get('id')));
            if (!connection) return json({ ok: false, error: toCard ? 'no such card' : 'no such connection' }, 404);
            const plugin = device.plugins.find(p => p.name === connection.plugin);
            const kind = card && plugin ? plugin.kinds.find(k => k.key === card.kind) : null;
            const takes = plugin && (toCard ? (plugin.multiCard ? kind && kind.message : plugin.message) : plugin.message);
            if (!takes) return json({ ok: false, error: 'this plugin has no message() function' }, 404);
            const text = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : JSON.stringify(body === undefined ? '' : body);
            if (Buffer.byteLength(text) > 4096) return json({ ok: false, error: 'the message is larger than 4 KB' }, 413);
            if (device.messages.length >= 8) return json({ ok: false, error: 'too many messages are waiting for this plugin. Try again in a moment' }, 429);
            device.messages.push(toCard ? { card: card.config, body: text } : { connection: connection.id, body: text });
            return json({ ok: true });
        }
        if (method === 'GET' && pathname === '/api/connections/choices') {
            const connection = device.connections.find(c => c.id === params.get('id'));
            if (!connection) return json({ ok: false, error: 'no such connection' }, 404);
            const plugin = device.plugins.find(p => p.name === connection.plugin);
            const kind = params.get('kind') || '';
            const fields = !plugin ? [] : kind ? ((plugin.kinds.find(k => k.key === kind) || {}).config || []) : plugin.config;
            if (!fields.some(f => f.key === params.get('field') && f.choices)) return json({ ok: false, error: 'that setting has no list of choices' }, 404);
            const key = connection.id + '/' + kind + '/' + params.get('field');
            // As the firmware does: the first request starts the plugin on it, a later one gets the list.
            // &settings= is what the form holds, as a JSON object: the plugin's function gets it.
            let form = {};
            if (params.get('settings')) {
                try { form = JSON.parse(params.get('settings')); } catch (error) { form = null; }
                if (!form || typeof form !== 'object' || Array.isArray(form) || params.get('settings').length > 1024) {
                    return json({ ok: false, error: 'settings is a JSON object of at most 1 KB' }, 400);
                }
            }
            device.choicePolls[key] = (device.choicePolls[key] || 0) + 1;
            if (device.choicePolls[key] % 2 === 1) return json({ ok: true, pending: true }, 202);
            device.choiceForms.push({ key, form });
            // A function stands for a plugin whose list depends on the form.
            const answer = typeof device.choices[key] === 'function' ? device.choices[key](form) : device.choices[key];
            if (typeof answer === 'string') return json({ ok: false, error: answer }, 502);
            return json({ ok: true, choices: answer || [] });
        }
        if (method === 'POST' && pathname === '/api/cards/layout') {
            device.cards = body.map(key => device.cards.find(c => c.type + '|' + c.config === key)).filter(Boolean);
            return json({ ok: true });
        }
        if (method === 'POST' && pathname === '/api/connections/update') {
            const connection = device.connections.find(c => c.id === params.get('id'));
            if (!connection) return json({ ok: false, error: 'no such connection' }, 404);
            if (body.name) connection.name = body.name;
            Object.assign(connection.settings, body.settings || {});
            return json({ ok: true });
        }
        if (method === 'POST' && pathname === '/api/connections/remove') {
            device.connections = device.connections.filter(c => c.id !== params.get('id'));
            device.cards = device.cards.filter(c => c.connection !== params.get('id'));
            return json({ ok: true });
        }
        if (method === 'POST' && pathname === '/api/cards/show') {
            for (const card of device.cards) card.onScreen = card.config === params.get('key');
            return json({ ok: true });
        }
        if (method === 'POST' && pathname === '/api/cards/press') {
            if (!['up', 'center', 'down'].includes(params.get('button'))) return json({ ok: false, error: 'button is up, center or down' }, 400);
            const card = device.cards.find(c => c.config === params.get('key'));
            if (card) card.frames = (card.frames || 0) + 1;
            return json({ ok: true });
        }
        if (method === 'DELETE' && pathname.startsWith('/api/plugins/')) {
            const name = pathname.split('/').pop();
            device.plugins = device.plugins.filter(p => p.name !== name);
            device.connections = device.connections.filter(c => c.plugin !== name);
            device.cards = device.cards.filter(c => c.plugin !== name);
            return json({ ok: true });
        }
        if (method === 'GET' && /^\/api\/plugins\/[a-z0-9_-]+$/.test(pathname)) {
            const plugin = device.plugins.find(p => p.name === pathname.split('/').pop());
            return plugin ? { status: 200, body: plugin.source, type: 'text/plain' } : json({ ok: false, error: 'no such plugin' }, 404);
        }
        if (method === 'GET' && /^\/api\/plugins\/[a-z0-9_-]+\/status$/.test(pathname)) return json({ name: pathname.split('/')[3], state: 'stopped', memory: 0, error: '', log: [] });
        if (method === 'POST' && pathname === '/api/actions/start-wifi-scan') return json({ status: 'queued' }, 202);
        if (method === 'PUT' && pathname.startsWith('/api/plugins/')) {
            const name = pathname.split('/').pop();
            const source = Buffer.from(body).toString('utf8');
            let plugin = device.plugins.find(p => p.name === name);
            if (!plugin) {
                plugin = { name, multiCard: false, config: [], kinds: [{ key: 'main', name, config: [] }] };
                device.plugins.push(plugin);
                // As the firmware does: a plugin nothing shows yet gets a first card, unless asked not to.
                if (params.get('card') !== 'no') {
                    device.connections.push({ id: name, plugin: name, name, settings: {}, secretsSet: [], state: 'running' });
                    device.cards.push({ type: 'PLUGIN', config: name + ':1', name, plugin: name, connection: name, card: '1', kind: 'main', settings: {}, frames: 0, onScreen: false });
                }
            }
            // As the firmware does: read the plugin's own description of itself.
            const title = /name\s*=\s*"([^"]*)"/.exec(source);
            const version = /version\s*=\s*"([^"]*)"/.exec(source);
            plugin.title = title ? title[1] : name;
            if (!plugin.multiCard) plugin.kinds[0].name = plugin.title;
            plugin.version = version ? version[1] : undefined;
            plugin.source = source;
            plugin.hash = sourceHash(source);
            return json({ ok: true, name });
        }
        if (method === 'POST' && pathname === '/api/directory') {
            device.directory.source = body.source || device.directory.default;
            return json({ ok: true, source: device.directory.source });
        }
        if (method === 'POST' && pathname === '/api/timezone') {
            // As the firmware does: a POSIX string, or nothing for UTC.
            if (body.posix && !/^(<[^>]+>|[A-Za-z]{3,})[-+]?\d/.test(body.posix)) return json({ ok: false, error: 'that is not a POSIX time zone' }, 400);
            device.timezone = body.posix ? { posix: body.posix, name: body.name || '' } : { posix: 'UTC0', name: '' };
            return json({ ok: true, posix: device.timezone.posix });
        }
        if (method === 'POST' && pathname === '/api/actions/save-wifi') return json({ status: 'queued' }, 202);
        return json({ ok: false, error: 'not found: ' + method + ' ' + pathname }, 404);
    };
    // The browser's own requests to the plugin directory (not to the device).
    device.fetchOutside = url => {
        device.outside.push(url);
        if (!device.internet) return null; // no connection
        const firmwareBase = 'https://raw.githubusercontent.com/TimBroddin/DeskHog/firmware/';
        if (url === firmwareBase + 'latest.json') return device.release ? { status: 200, body: JSON.stringify(device.release) } : { status: 404, body: 'Not found' };
        if (url === firmwareBase + 'deskhog-update.bin') return { status: 200, body: 'the firmware' };
        const base = 'https://raw.githubusercontent.com/TimBroddin/DeskHog/HEAD/plugins/';
        const path = url.startsWith(base) ? url.slice(base.length) : url.startsWith('https://plugins.example/') ? url.slice('https://plugins.example/'.length) : null;
        if (path === 'index.json') return { status: 200, body: JSON.stringify(device.internet.index) };
        if (path !== null && device.internet.files[path] !== undefined) return { status: 200, body: device.internet.files[path] };
        return { status: 404, body: 'Not found' };
    };
    device.outside = [];

    return device;
}

module.exports = { makeDevice, makeDirectory, addHomey, sourceHash };
