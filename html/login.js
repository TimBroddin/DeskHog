// The login maths: the page needs them to prove a password without sending it.
// The page is plain HTTP, so there is no crypto.subtle: SHA-256, HMAC and PBKDF2
// are written out here. Nothing else lives in this file.

/** The first `count` primes' roots, as SHA-256 wants them: the first 32 bits of each fraction. */
function constants(count, root) {
    const out = new Uint32Array(count);
    for (let n = 2, i = 0; i < count; n++) {
        let prime = true;
        for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false;
        if (prime) out[i++] = (root(n) % 1) * 4294967296;
    }
    return out;
}
const K = constants(64, Math.cbrt);

/** SHA-256 of the bytes of `data`, as a Uint8Array of 32. */
function sha256(data) {
    const h = constants(8, Math.sqrt);
    const size = (data.length + 9 + 63) & ~63;
    const block = new Uint8Array(size);
    block.set(data);
    block[data.length] = 0x80;
    const view = new DataView(block.buffer);
    view.setUint32(size - 8, Math.floor(data.length / 536870912));
    view.setUint32(size - 4, data.length * 8 >>> 0);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let at = 0; at < size; at += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4);
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15], b = w[i - 2];
            w[i] = w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
        }
        let [a, b, c, d, e, f, g, i8] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = i8 + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
            const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
            i8 = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        [a, b, c, d, e, f, g, i8].forEach((v, i) => { h[i] += v; });
    }
    const out = new Uint8Array(32);
    const result = new DataView(out.buffer);
    h.forEach((v, i) => result.setUint32(i * 4, v));
    return out;
}

const join = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

/** HMAC-SHA256 of `message` under `key`. */
function hmac(key, message) {
    if (key.length > 64) key = sha256(key);
    const inner = new Uint8Array(64).fill(0x36), outer = new Uint8Array(64).fill(0x5c);
    key.forEach((byte, i) => { inner[i] ^= byte; outer[i] ^= byte; });
    return sha256(join(outer, sha256(join(inner, message))));
}

/** PBKDF2-HMAC-SHA256 with one block of output: 32 bytes. */
function pbkdf2(password, salt, rounds) {
    let u = hmac(password, join(salt, new Uint8Array([0, 0, 0, 1])));
    const t = u.slice();
    for (let i = 1; i < rounds; i++) {
        u = hmac(password, u);
        for (let j = 0; j < 32; j++) t[j] ^= u[j];
    }
    return t;
}

const toBytes = hex => Uint8Array.from(hex.match(/../g) || [], pair => parseInt(pair, 16));
const toHex = bytes => Array.from(bytes, byte => (byte + 256).toString(16).slice(1)).join('');

/** The password the device stores a proof of: 64 hex digits. The password is UTF-8 in NFC, as typed, untrimmed. */
function passwordVerifier(password, saltHex, rounds) {
    return toHex(pbkdf2(new TextEncoder().encode(password.normalize('NFC')), toBytes(saltHex), rounds));
}

/** What the device checks: HMAC-SHA256(verifier, nonce), 64 hex digits. */
function loginProof(verifierHex, nonceHex) {
    return toHex(hmac(toBytes(verifierHex), toBytes(nonceHex)));
}

/** A new verifier hidden for the wire: new XOR HMAC-SHA256(old verifier, nonce + "new"). */
function maskedVerifier(oldVerifierHex, nonceHex, newVerifierHex) {
    const pad = hmac(toBytes(oldVerifierHex), join(toBytes(nonceHex), new TextEncoder().encode('new')));
    return toHex(toBytes(newVerifierHex).map((byte, i) => byte ^ pad[i]));
}

if (typeof module !== 'undefined') module.exports = { passwordVerifier, loginProof, maskedVerifier };
