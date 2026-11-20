#include "Access.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include "Sha256.h"

namespace deskhog {

namespace {

const size_t kKeyDigits = 32;

bool isKeyText(const std::string& text) {
    uint8_t bytes[16];
    return fromHex(text, bytes, sizeof(bytes));
}

bool goodName(const std::string& name) {
    if (name.empty() || name.size() > AccessTable::kMaxName) return false;
    for (unsigned char c : name) {
        if (c < 0x20) return false;
    }
    return true;
}

/** HMAC-SHA256(verifier, nonce + suffix), or false if the verifier or nonce is not hex. */
bool keyedHash(const std::string& verifierHex, const std::string& nonceHex, const char* suffix, uint8_t out[32]) {
    uint8_t verifier[32], nonce[16 + 3];
    if (!fromHex(verifierHex, verifier, 32) || !fromHex(nonceHex, nonce, 16)) return false;
    const size_t suffixLength = strlen(suffix);
    memcpy(nonce + 16, suffix, suffixLength);
    hmacSha256(verifier, 32, nonce, 16 + suffixLength, out);
    return true;
}

size_t countOf(const std::vector<AccessKey>& keys, KeyKind kind) {
    size_t count = 0;
    for (const AccessKey& key : keys) count += key.kind == kind;
    return count;
}

}  // namespace

bool AccessTable::hasPassword() const { return !verifier_.empty(); }
const std::string& AccessTable::salt() const { return salt_; }
int AccessTable::rounds() const { return rounds_; }
const std::string& AccessTable::verifier() const { return verifier_; }

bool AccessTable::setPassword(const std::string& salt, int rounds, const std::string& verifier) {
    uint8_t saltBytes[16], verifierBytes[32];
    if (rounds < 1 || rounds > kMaxRounds) return false;
    if (!fromHex(salt, saltBytes, 16) || !fromHex(verifier, verifierBytes, 32)) return false;
    // Stored in one spelling, whatever case the client used.
    salt_ = toHex(saltBytes, 16);
    verifier_ = toHex(verifierBytes, 32);
    rounds_ = rounds;
    return true;
}

void AccessTable::removePassword() {
    salt_.clear();
    verifier_.clear();
    rounds_ = 0;
    keys_.clear();
}

bool AccessTable::checkProof(const std::string& nonce, const std::string& proof) const {
    if (!hasPassword()) return false;
    uint8_t expected[32], given[32];
    if (!keyedHash(verifier_, nonce, "", expected)) return false;
    if (!fromHex(proof, given, 32)) return false;
    return sameBytes(expected, given, 32);
}

bool AccessTable::unmask(const std::string& nonce, const std::string& masked, std::string& newVerifier) const {
    if (!hasPassword()) return false;
    uint8_t pad[32], given[32];
    if (!keyedHash(verifier_, nonce, "new", pad)) return false;
    if (!fromHex(masked, given, 32)) return false;
    for (int i = 0; i < 32; i++) given[i] ^= pad[i];
    newVerifier = toHex(given, 32);
    return true;
}

bool AccessTable::find(const std::string& key, AccessKey& found) const {
    uint8_t wanted[16];
    if (!fromHex(key, wanted, sizeof(wanted))) return false;
    // Look at every key, so how long this takes does not say which one matched.
    const AccessKey* match = nullptr;
    for (const AccessKey& candidate : keys_) {
        uint8_t have[16];
        if (!fromHex(candidate.key, have, sizeof(have))) continue;
        if (sameBytes(wanted, have, sizeof(have))) match = &candidate;
    }
    if (!match) return false;
    found = *match;
    return true;
}

int AccessTable::nextId() const {
    int highest = 0;
    for (const AccessKey& key : keys_) {
        if (key.id > highest) highest = key.id;
    }
    return highest + 1;
}

AccessKey AccessTable::addLogin(const std::string& key) {
    AccessKey existing;
    if (find(key, existing)) return existing;
    if (countOf(keys_, KeyKind::Login) >= kMaxLogins) {
        size_t oldest = keys_.size();
        for (size_t i = 0; i < keys_.size(); i++) {
            if (keys_[i].kind != KeyKind::Login) continue;
            if (oldest == keys_.size() || keys_[i].id < keys_[oldest].id) oldest = i;
        }
        keys_.erase(keys_.begin() + oldest);
    }
    AccessKey added;
    added.id = nextId();
    added.kind = KeyKind::Login;
    added.key = key;
    keys_.push_back(added);
    return added;
}

bool AccessTable::addMessageKey(const std::string& key, const std::string& name, AccessKey& added) {
    if (!goodName(name)) return false;
    if (countOf(keys_, KeyKind::Message) >= kMaxMessageKeys) return false;
    AccessKey existing;
    if (find(key, existing)) return false;
    AccessKey fresh;
    fresh.id = nextId();
    fresh.kind = KeyKind::Message;
    fresh.key = key;
    fresh.name = name;
    keys_.push_back(fresh);
    added = fresh;
    return true;
}

bool AccessTable::removeMessageKey(int id) {
    for (size_t i = 0; i < keys_.size(); i++) {
        if (keys_[i].kind == KeyKind::Message && keys_[i].id == id) {
            keys_.erase(keys_.begin() + i);
            return true;
        }
    }
    return false;
}

bool AccessTable::removeKey(const std::string& key) {
    AccessKey found;
    if (!find(key, found)) return false;
    for (size_t i = 0; i < keys_.size(); i++) {
        if (keys_[i].id == found.id) {
            keys_.erase(keys_.begin() + i);
            return true;
        }
    }
    return false;
}

void AccessTable::removeLoginsExcept(const std::string& key) {
    AccessKey keep;
    const bool keeping = find(key, keep) && keep.kind == KeyKind::Login;
    std::vector<AccessKey> left;
    for (const AccessKey& each : keys_) {
        if (each.kind == KeyKind::Message || (keeping && each.id == keep.id)) left.push_back(each);
    }
    keys_ = left;
}

size_t AccessTable::logins() const { return countOf(keys_, KeyKind::Login); }

std::vector<AccessKey> AccessTable::messageKeys() const {
    std::vector<AccessKey> messages;
    for (const AccessKey& key : keys_) {
        if (key.kind == KeyKind::Message) messages.push_back(key);
    }
    return messages;
}

std::string AccessTable::keysText() const {
    std::string text;
    for (const AccessKey& key : keys_) {
        text += key.kind == KeyKind::Login ? "L" : "M";
        text += "\t" + std::to_string(key.id) + "\t" + key.key + "\t" + key.name + "\n";
    }
    return text;
}

void AccessTable::loadKeys(const std::string& text) {
    keys_.clear();
    size_t start = 0;
    while (start < text.size()) {
        size_t end = text.find('\n', start);
        if (end == std::string::npos) end = text.size();
        const std::string line = text.substr(start, end - start);
        start = end + 1;

        std::vector<std::string> fields;
        size_t from = 0;
        for (;;) {
            const size_t tab = line.find('\t', from);
            if (tab == std::string::npos) {
                fields.push_back(line.substr(from));
                break;
            }
            fields.push_back(line.substr(from, tab - from));
            from = tab + 1;
        }
        if (fields.size() != 4) continue;

        KeyKind kind;
        if (fields[0] == "L") kind = KeyKind::Login;
        else if (fields[0] == "M") kind = KeyKind::Message;
        else continue;

        const std::string& idText = fields[1];
        if (idText.empty() || idText.size() > 9) continue;
        bool digits = true;
        for (char c : idText) digits = digits && c >= '0' && c <= '9';
        const int id = digits ? atoi(idText.c_str()) : 0;
        if (id < 1) continue;

        if (fields[2].size() != kKeyDigits || !isKeyText(fields[2])) continue;
        if (kind == KeyKind::Message && !goodName(fields[3])) continue;
        if (kind == KeyKind::Login && !fields[3].empty()) continue;
        if (countOf(keys_, kind) >= (kind == KeyKind::Login ? kMaxLogins : kMaxMessageKeys)) continue;

        bool taken = false;
        for (const AccessKey& have : keys_) taken = taken || have.id == id || have.key == fields[2];
        if (taken) continue;

        AccessKey loaded;
        loaded.id = id;
        loaded.kind = kind;
        loaded.key = fields[2];
        loaded.name = fields[3];
        keys_.push_back(loaded);
    }
}

void LoginGuard::dropOld(uint32_t now) {
    // A nonce that is too old is dropped for good, so a wrapped counter cannot make it fresh again.
    for (size_t i = nonces_.size(); i-- > 0;) {
        if ((uint32_t)(now - nonces_[i].at) >= kNonceMs) nonces_.erase(nonces_.begin() + i);
    }
}

void LoginGuard::issue(const std::string& nonce, uint32_t now) {
    dropOld(now);
    if (nonces_.size() >= kNonces) nonces_.erase(nonces_.begin());
    nonces_.push_back({nonce, now});
}

bool LoginGuard::take(const std::string& nonce, uint32_t now) {
    dropOld(now);
    for (size_t i = 0; i < nonces_.size(); i++) {
        if (nonces_[i].nonce != nonce) continue;
        nonces_.erase(nonces_.begin() + i);    // It works once
        return true;
    }
    return false;
}

bool LoginGuard::waiting(uint32_t now) const {
    if (locked_ && (uint32_t)(now - lockedAt_) >= kWaitMs) locked_ = false;
    return locked_;
}

void LoginGuard::wrong(uint32_t now) {
    if (waiting(now)) return;
    if (++wrongInARow_ >= kWrongTries) {
        locked_ = true;
        lockedAt_ = now;
        wrongInARow_ = 0;
    }
}

void LoginGuard::right() {
    wrongInARow_ = 0;
    locked_ = false;
}

namespace {

const char kLockedError[] = "This DeskHog has a password. Log in first.";

bool sameText(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); i++) {
        if (tolower((unsigned char)a[i]) != tolower((unsigned char)b[i])) return false;
    }
    return true;
}

bool startsWith(const std::string& text, const char* prefix) {
    return text.compare(0, strlen(prefix), prefix) == 0;
}

/** The path itself, or the path followed by "/" and anything: what the web server hands to a route's handler. */
bool onOrBelow(const std::string& path, const char* route) {
    const size_t length = strlen(route);
    return path.compare(0, length, route) == 0 && (path.size() == length || path[length] == '/');
}

/**
 * The calls a plugin may not make to the device, and the ones where only reading is allowed. The web server
 * hands <route>/anything to the route's handler, so each is refused on the route and everything below it.
 */
bool refusedForDevice(const AccessRequest& r) {
    for (const char* route : {"/api/login", "/api/password", "/api/keys", "/api/logout"}) {
        if (onOrBelow(r.path, route)) return true;
    }
    if (r.method == "GET") return false;
    for (const char* route : {"/api/device", "/api/restart", "/api/update/start"}) {
        if (onOrBelow(r.path, route)) return true;
    }
    return false;
}

/**
 * The calls that only read. Every other call changes something and wants POST (or PUT, DELETE). The plugin
 * directory and the time zone are read through /api/state, so their own calls only change.
 */
bool onlyReads(const std::string& path) {
    static const char* const kReads[] = {
        "/api/status", "/api/login", "/api/state", "/api/device", "/api/keys", "/api/cards/screen",
        "/api/connections/choices",
    };
    for (const char* read : kReads) {
        if (path == read) return true;
    }
    return startsWith(path, "/api/plugins");
}

bool isMessageCall(const std::string& path) {
    return path == "/api/cards/message" || path == "/api/connections/message";
}

AccessVerdict refuse(int status, const char* error) {
    AccessVerdict verdict;
    verdict.status = status;
    verdict.error = error;
    return verdict;
}

/** Rule 8. Only POST, PUT and DELETE may change something; anything else is answered on the read list only. */
bool mayUseMethod(const AccessRequest& r) {
    if (r.method == "POST" || r.method == "PUT" || r.method == "DELETE") return true;
    return onlyReads(r.path);
}

const char kChangesError[] = "This call changes something. Use POST.";

}  // namespace

// The rules, in the order they apply; the first that applies decides. This is
// the one list to edit to open a call: a call is locked unless a rule below
// lets it through.
AccessVerdict decideAccess(const AccessRequest& r, const AccessTable& table) {
    const bool locked = table.hasPassword();

    // 1. Only the API is protected. The page, the captive portal probes and the like are not. The prefix is
    //    compared without regard to case, so a router that matched paths that way could not slip past.
    if (!sameText(r.path.substr(0, 5), "/api/")) {
        AccessVerdict verdict;
        verdict.full = !locked;
        return verdict;
    }

    // 2. Another website. Browsers send Origin on every cross-site call that can change something.
    if (!r.origin.empty() && !sameText(r.origin, "http://" + r.host)) {
        return refuse(403, "This request came from another website.");
    }

    // 3. Nothing answers a preflight, so a browser never gets leave to send a cross-site call.
    if (r.method == "OPTIONS") return refuse(405, "This call is not answered.");

    // 4. The device calling itself (a plugin) needs no key, but cannot log in or touch the password and the keys.
    if (r.fromDevice) {
        if (refusedForDevice(r)) return refuse(403, "not from the device itself");
        if (!mayUseMethod(r)) return refuse(405, kChangesError);
        AccessVerdict verdict;
        verdict.full = true;
        return verdict;
    }

    // 5. The key it came with: the bearer, or a message key in the address. A login key in the address is no key.
    AccessVerdict verdict;
    AccessKey found;
    if (!r.bearer.empty() && table.find(r.bearer, found)) {
        verdict.hasKey = true;
        verdict.key = found;
    } else if (!r.addressKey.empty() && table.find(r.addressKey, found) && found.kind == KeyKind::Message) {
        verdict.hasKey = true;
        verdict.key = found;
    }
    const bool loginKey = verdict.hasKey && verdict.key.kind == KeyKind::Login;
    verdict.full = !locked || loginKey;

    // 6. Open without a key: logging in, and the status the page asks for before it can log in.
    const bool open = r.path == "/api/login" && (r.method == "GET" || r.method == "POST");
    const bool openStatus = r.path == "/api/status" && r.method == "GET";

    // 7. With a password, the message calls want any key and everything else a login key.
    if (locked && !open && !openStatus) {
        const bool allowed = isMessageCall(r.path) ? verdict.hasKey : loginKey;
        if (!allowed) return refuse(401, kLockedError);
    }

    // 8. Reads.
    if (!mayUseMethod(r)) return refuse(405, kChangesError);

    return verdict;
}

RemoveHold::State RemoveHold::tick(bool bothHeld, uint32_t now) {
    State state;
    if (!bothHeld) {
        held_ = false;
        fired_ = false;
        return state;
    }
    if (!held_) {
        held_ = true;
        fired_ = false;
        since_ = now;
    }
    if (fired_) return state;
    const uint32_t heldMs = now - since_;
    if (heldMs >= kFireMs) {
        fired_ = true;
        state.fire = true;
    } else if (heldMs >= kShowMs) {
        state.secondsLeft = (int)((kFireMs - heldMs + 999) / 1000);
    }
    return state;
}

}  // namespace deskhog
