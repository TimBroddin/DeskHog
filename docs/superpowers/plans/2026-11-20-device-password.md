# Device Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner set a password on a DeskHog, after which every call to the firmware and the updater needs a key, and refuse other websites whether a password is set or not.

**Architecture:** The rules (what is open, checking a proof, the key table, the origin rule, the wait after wrong tries, the button hold) are plain C++ in a new library `lib/access` with no Arduino in it, used by the firmware, the updater and `test/native`. The firmware puts one check in front of every route (a web-server middleware plus an early check in the body collectors) and adds the login, password and key calls. The login maths in JavaScript lives in one file, `html/login.js`, used by the page, the updater's page and the pretend device; `tools/deskhog` does the same with Python's `hashlib`. One file of test vectors pins all three.

**Tech Stack:** C++17 (Arduino on ESP32-S3, PlatformIO, ESPAsyncWebServer 3.8.0, ArduinoJson 6, LVGL 9.2; the updater uses Arduino's `WebServer`), plain JS page tested with jsdom under node, Python 3 standard library for `tools/deskhog`.

**Spec:** `docs/superpowers/specs/2026-11-20-device-password-design.md`. Read it before any task; this plan does not repeat its behaviour rules.

## Global Constraints

- Work on the branch `device-password` (it exists, made from `main`); never commit to `main`.
- Nothing in `lib/access` may include Arduino, LVGL, FreeRTOS or mbedtls headers.
- The password, the verifier and keys never appear in a `Serial` line, in an answer to someone who is not logged in, or anywhere a plugin can read. The page sends a key only to the device, never to a plugin directory or GitHub.
- Secrets in plugin settings are still never sent by the device.
- A device without a password behaves as today, except: no `Access-Control-*` headers, a foreign `Origin` is refused, and calls that change something refuse GET.
- All binary values travel and are stored as lowercase hex: salt and nonce 16 bytes (32 digits), verifier and proof 32 bytes (64 digits), a key 16 bytes (32 digits).
- `verifier = PBKDF2-HMAC-SHA256(password as UTF-8 in NFC, salt bytes, rounds, 32 bytes)`; `proof = HMAC-SHA256(verifier bytes, nonce bytes)`; `masked = new verifier XOR HMAC-SHA256(old verifier bytes, nonce bytes + "new")`. Nothing trims a password. The page and the CLI refuse fewer than 8 characters.
- The page sets new passwords with 20,000 rounds. At most 8 login keys and 8 message keys. A nonce works once, for 60 seconds. Five wrong proofs in a row: no logins for 60 seconds.
- 401 always and only means "no key that works": `{"ok": false, "locked": true, "error": "This DeskHog has a password. Log in first."}`. A wrong password is 403.
- NVS, namespace `wifi_config`: `pw_salt`, `pw_rounds`, `pw_ver`, `pw_keys`. The updater only reads them.
- Flash: the main firmware has about 97 KB left in its slot and the updater about 59 KB. Both builds must still fit; note the sizes.
- LVGL is touched only from the UI task. The web server (core 0) never calls LVGL.
- All timers compare `uint32_t` differences, so they survive `millis()` wrapping.
- Text from plugins and directories is put on the page as text, never as HTML. No new dependencies anywhere.
- Use PlatformIO as `~/.platformio/penv/bin/pio` (the Homebrew `pio` on this machine is broken).
- Comments and docs in the project's voice: plain sentences, what and why, as in the surrounding files.
- `test/native/run.sh` and `test/portal/run.sh` pass after every task. No version bump: Tim decides when this ships.

## Review Focus

1. **The browser refuses or loses its storage** (a private window, cleared site data): the page keeps the key in memory and works until it is reloaded; a key that is gone leads to the login screen, never to a broken page. Test in Task 6.
2. **A login screen left open** (the nonce is an hour old, or the device restarted): pressing Log in fetches a fresh nonce at that moment, so it works the first time. Test in Task 6.
3. **Saved keys that are damaged or from another firmware** (unreadable lines, more than 8, the same id twice): loading skips what it cannot read, keeps at most 8 of each kind, and a device with a verifier stays locked. Test in Task 1.
4. **A password that is not plain ASCII** (`é`, an emoji, a space at either end, typed as NFD on a Mac): the page, the CLI and the vectors agree. Tests in Tasks 5 and 10.
5. **Addresses that are not `name.local`** (an IP address, a port as in `localhost:8080`, capitals, `Origin: null` from a local file): the origin rule lets the device's own page through at each and refuses `null`. Test in Task 2.

## File Structure

| File | Responsibility |
|---|---|
| `lib/access/src/Sha256.h/.cpp` (new) | SHA-256, HMAC-SHA256, hex, a constant-time compare |
| `lib/access/src/Access.h/.cpp` (new) | `AccessTable` (password and keys), `LoginGuard` (nonces, wrong tries), `decideAccess` (who may call what), `RemoveHold` (the button hold) |
| `test/access/vectors.txt` (new) | The one set of login test vectors |
| `test/native/test_plugin_core.cpp`, `run.sh` | Tests for `lib/access` |
| `src/ConfigManager.*` | Save and load the password record and the keys |
| `src/DeviceAccess.h/.cpp` (new) | The firmware's table and guard behind a lock; random values; the device id |
| `src/plugins/AccessApi.h/.cpp` (new) | The check in front of every route; `/api/login`, `/api/password`, `/api/keys`, `/api/logout` |
| `src/plugins/PluginApi.cpp`, `src/ui/CaptivePortal.*`, `src/main.cpp` | No CORS, early body refusal, trimmed `/api/status`, `status.password` and `status.updater`, wiring |
| `src/ui/RemoveOverlay.h/.cpp` (new) | The countdown drawn over any card |
| `html/login.js` (new), `htmlconvert.py` | The login maths in JavaScript, inlined into the page |
| `html/portal.html/.js/.css` | The login screen, the key on every device call, the Password panel |
| `test/portal/pretend-device.js`, `serve.js`, `portal.test.js` | A pretend device that can be locked; page tests |
| `updater/main.cpp`, `updater/login_js.py` (new), `platformio.ini` | Updater 2 |
| `tools/deskhog`, `test/cli/run.sh` (new), `.github/workflows/test.yml` | `login`, `logout`, the key on every call |
| `README.md`, `plugins/README.md`, `tech-details.md`, `src/plugins/PluginApi.h` | Docs |

---

### Task 1: The password and the keys, without hardware

**Files:**
- Create: `lib/access/library.json`, `lib/access/src/Sha256.h`, `lib/access/src/Sha256.cpp`, `lib/access/src/Access.h`, `lib/access/src/Access.cpp`, `test/access/vectors.txt`
- Modify: `test/native/run.sh` (add `-I "$root/lib/access/src"` and `"$root"/lib/access/src/*.cpp` to the compile line), `test/native/test_plugin_core.cpp` (new tests at the end, `#include "Access.h"`)

**Interfaces:**
- Produces, all in `namespace deskhog`:

```cpp
// Sha256.h
class Sha256 { public: Sha256(); void update(const uint8_t* data, size_t length); void finish(uint8_t out[32]); };
void hmacSha256(const uint8_t* key, size_t keyLength, const uint8_t* message, size_t messageLength, uint8_t out[32]);
std::string toHex(const uint8_t* bytes, size_t count);                 // lowercase
bool fromHex(const std::string& text, uint8_t* out, size_t count);     // exactly 2*count hex digits, either case
bool sameBytes(const uint8_t* a, const uint8_t* b, size_t count);      // takes the same time whatever differs

// Access.h
enum class KeyKind { Login, Message };
struct AccessKey { int id = 0; KeyKind kind = KeyKind::Login; std::string key; std::string name; };

class AccessTable {
public:
    static constexpr size_t kMaxLogins = 8, kMaxMessageKeys = 8;
    bool hasPassword() const;
    const std::string& salt() const;
    int rounds() const;
    const std::string& verifier() const;   // for saving only, never for an answer
    /** False, and nothing changed, unless salt is 32 hex digits, verifier 64 and rounds 1 to 10,000,000. */
    bool setPassword(const std::string& salt, int rounds, const std::string& verifier);
    void removePassword();                 // and every key
    bool checkProof(const std::string& nonce, const std::string& proof) const;
    bool unmask(const std::string& nonce, const std::string& masked, std::string& newVerifier) const;
    bool find(const std::string& key, AccessKey& found) const;
    AccessKey addLogin(const std::string& key);                               // a ninth replaces the lowest id
    bool addMessageKey(const std::string& key, const std::string& name, AccessKey& added);
    bool removeMessageKey(int id);
    bool removeKey(const std::string& key);
    void removeLoginsExcept(const std::string& key);
    size_t logins() const;
    std::vector<AccessKey> messageKeys() const;
    std::string keysText() const;          // one line per key: "<L|M>\t<id>\t<key>\t<name>\n"
    void loadKeys(const std::string& text);   // replaces the keys the table had; skips lines it cannot read
};

class LoginGuard {
public:
    static constexpr uint32_t kNonceMs = 60000, kWaitMs = 60000;
    static constexpr int kWrongTries = 5;
    static constexpr size_t kNonces = 4;
    void issue(const std::string& nonce, uint32_t now);   // the fifth pushes out the oldest
    bool take(const std::string& nonce, uint32_t now);    // true once per nonce, within a minute of issue
    bool waiting(uint32_t now) const;
    void wrong(uint32_t now);
    void right();
};
```

A message key's name is 1 to 24 bytes with no character below 0x20. A new key's id is one more than the highest id in the table.

- [ ] **Step 1: Write `test/access/vectors.txt`**, exactly (made with Python's `hashlib.pbkdf2_hmac` and `hmac`; `utf8_password` is a JSON string):

```
password=correct horse battery
salt=000102030405060708090a0b0c0d0e0f
rounds=1000
nonce=f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff
verifier=02169e674d80c0fc7292e8610c8f17be140df062af9aa33ea85eaabecffdf08d
proof=0ada811929a64f68e9c8f7d58f2bb491860e6cca2b2d4224a05f88eb419d39c2
new_verifier=5137fcacdc498f2f9b2f7617e5254b12a074055ad7a4b91c35e32d26b0112f11
masked=4276854d7863ea41cbffb0d6fe7c3a7f8199275cec338125936b6fecaf7ad288
utf8_password=" pässword 🦔 "
utf8_verifier=861b571f82bb4c2b4ea2dd04b8a60a2fdbfc04a13a868c76bec6c538b22278d0
```

- [ ] **Step 2: Write the failing tests** in `test/native/test_plugin_core.cpp`. Add three helpers: `std::map<std::string, std::string> accessVectors()` reads `g_pluginDir + "/../test/access/vectors.txt"` as `name=value` lines; `AccessTable lockedTable()` has the vectors' password, the login keys `std::string(32, '1')` and `std::string(32, '2')`, and the message key `std::string(32, '3')` named `doorbell`; `std::string twentyLoginLines()` gives 20 good login lines with ids 1 to 20.

```cpp
TEST(sha256_and_hex_match_known_answers) {
    uint8_t out[32];
    Sha256 sha; sha.update((const uint8_t*)"abc", 3); sha.finish(out);
    CHECK_EQ(toHex(out, 32), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    uint8_t back[2];
    CHECK(fromHex("0aFF", back, 2) && back[0] == 0x0a && back[1] == 0xff);
    CHECK(!fromHex("0a", back, 2));
    CHECK(!fromHex("zz00", back, 2));
}
TEST(a_proof_from_the_vectors_logs_in) {
    const auto v = accessVectors();
    AccessTable table;
    CHECK(!table.checkProof(v.at("nonce"), v.at("proof")));        // no password yet
    CHECK(table.setPassword(v.at("salt"), 1000, v.at("verifier")));
    CHECK(table.hasPassword());
    CHECK(table.checkProof(v.at("nonce"), v.at("proof")));
    CHECK(!table.checkProof(v.at("nonce"), v.at("verifier")));     // not the proof
    CHECK(!table.checkProof("zz", v.at("proof")));
    std::string fresh;
    CHECK(table.unmask(v.at("nonce"), v.at("masked"), fresh));
    CHECK_EQ(fresh, v.at("new_verifier"));
}
TEST(a_bad_password_record_changes_nothing)          // salt "00", rounds 0, rounds 10000001, verifier 62 digits: false, hasPassword() false
TEST(a_ninth_login_replaces_the_oldest)              // after 9 addLogin: logins()==8, find(first) false, find(ninth) true
TEST(message_keys_stop_at_eight_and_need_a_name)     // "" and 25 bytes and "a\tb" refused; the ninth refused; ids differ
TEST(changing_the_password_keeps_one_login_and_the_message_keys)  // removeLoginsExcept(key): logins()==1, messageKeys().size() unchanged
TEST(removing_the_password_removes_every_key)        // removePassword(): !hasPassword(), logins()==0, messageKeys().empty()
TEST(saved_keys_come_back_and_damage_is_skipped) {
    AccessTable saved = lockedTable();                // the vectors' password, 2 logins, a message key "doorbell"
    AccessTable loaded; loaded.loadKeys(saved.keysText());
    CHECK_EQ(loaded.keysText(), saved.keysText());
    AccessTable damaged = lockedTable();
    damaged.loadKeys("garbage\nL\tx\tnothex\t\nM\t7\t" + std::string(32, 'a') + "\tbell\nM\t7\t" + std::string(32, 'b') + "\ttwice\n");
    CHECK_EQ((int)damaged.messageKeys().size(), 1);  // the unreadable lines and the second id 7 are skipped
    CHECK_EQ((int)damaged.logins(), 0);
    CHECK(damaged.hasPassword());                     // still locked
    AccessTable many; many.loadKeys(twentyLoginLines());
    CHECK_EQ((int)many.logins(), 8);
}
TEST(a_nonce_works_once_and_for_a_minute)            // take at 59999 true, again false; another issued at 0, take at 60001 false; the fifth issue pushes out the first; survives millis wrapping
TEST(five_wrong_tries_mean_a_minute_without_logins)  // 4 wrong: !waiting; 5th at t: waiting(t+59999), !waiting(t+60000); right() resets the count
```

- [ ] **Step 3: Run** `test/native/run.sh access 2>&1 | tail -5`. Expected: it does not compile (`Access.h` not found).

- [ ] **Step 4: Implement `lib/access`.** `library.json`: name `access`, no dependencies. SHA-256 from FIPS 180-4, written out, no table tricks. `find` and `checkProof` compare with `sameBytes`.

- [ ] **Step 5: Run** `test/native/run.sh 2>&1 | tail -3`. Expected: every test passes, old and new.

- [ ] **Step 6: Commit**

```bash
git add lib/access test/access test/native
git commit -m "The password and the keys as rules without hardware, with tests"
```

---

### Task 2: Who may call what, and the button hold

**Files:**
- Modify: `lib/access/src/Access.h`, `lib/access/src/Access.cpp`, `test/native/test_plugin_core.cpp`

**Interfaces:**
- Consumes: `AccessTable`, `AccessKey` (Task 1).
- Produces:

```cpp
struct AccessRequest {
    std::string method;      // "GET", "POST", "PUT", "DELETE", "OPTIONS"
    std::string path;        // without the query
    std::string origin;      // the Origin header, "" when there is none
    std::string host;        // the Host header
    std::string bearer;      // what follows "Authorization: Bearer ", "" when there is none
    std::string addressKey;  // ?auth=, "" when there is none
    bool fromDevice = false; // the device calling itself: a plugin
};
struct AccessVerdict {
    int status = 0;          // 0: let it through. Otherwise answer this status with `error`
    const char* error = "";
    bool full = false;       // may see everything: no password, a login key, or the device itself
    bool hasKey = false;
    AccessKey key;           // the key it came with, when hasKey
};
AccessVerdict decideAccess(const AccessRequest& request, const AccessTable& table);

class RemoveHold {           // ▲ and ▼ held together
public:
    static constexpr uint32_t kShowMs = 2000, kFireMs = 10000;
    struct State { int secondsLeft = -1; bool fire = false; };   // -1: show nothing
    State tick(bool bothHeld, uint32_t now);
};
```

`decideAccess` checks in this order, and the first that applies decides:

1. A path that does not start with `/api/`: through.
2. An `origin` that is not `http://` + `host`, compared without regard to case: 403 `This request came from another website.`
3. `OPTIONS`: 405.
4. From the device: 403 `not from the device itself` for POST `/api/login`, anything on `/api/password`, `/api/keys` and `/api/logout`, and any method but GET on `/api/device`, `/api/restart` and `/api/update/start`. Otherwise the device is `full` and needs no key.
5. The key is `bearer` when it is in the table; else `addressKey` when it is a message key in the table. A login key in the address counts as no key.
6. `/api/login` (GET and POST) and GET `/api/status` go through without a key; `full` is false on a locked device unless a login key came along.
7. With a password: the two message calls (`/api/cards/message`, `/api/connections/message`) need any key, everything else a login key; otherwise the 401 from Global Constraints.
8. GET is answered only by `/api/status`, `/api/login`, `/api/state`, `/api/directory`, `/api/timezone`, `/api/device`, `/api/keys`, `/api/cards/screen`, `/api/connections/choices` and anything under `/api/plugins`. Any other GET: 405 `This call changes something. Use POST.`

`RemoveHold`: nothing before 2 s; from 2 s `secondsLeft` is the whole seconds still to go, rounded up (8 at 2000 ms, 1 at 9999 ms); `fire` is true on exactly one tick at 10 s; then nothing until the buttons were let go.

- [ ] **Step 1: Write the failing tests.** A helper `AccessRequest call(const char* method, const char* path)` sets `host = "deskhog.local"`. `kEveryCall` lists every route there is: `/api/state`, `/api/directory`, `/api/timezone`, `/api/device`, `/api/restart`, `/api/update/start`, `/api/cards/add`, `/api/cards/update`, `/api/cards/layout`, `/api/cards/screen`, `/api/cards/press`, `/api/cards/show`, `/api/cards/message`, `/api/connections/add`, `/api/connections/update`, `/api/connections/remove`, `/api/connections/message`, `/api/connections/choices`, `/api/plugins`, `/api/plugins/hello`, `/api/plugins/hello/status`, `/api/actions/start-wifi-scan`, `/api/actions/save-wifi`, `/api/password`, `/api/keys`, `/api/logout`, `/api/firmware`, and `/api/something/new`.

```cpp
TEST(every_call_is_locked_unless_listed_as_open) {
    AccessTable table = lockedTable();                       // the vectors' password
    for (const char* path : kEveryCall)
        for (const char* method : {"GET", "POST", "PUT", "DELETE"})
            CHECK_EQ(decideAccess(call(method, path), table).status, 401);
    CHECK_EQ(decideAccess(call("GET", "/api/login"), table).status, 0);
    CHECK_EQ(decideAccess(call("POST", "/api/login"), table).status, 0);
    const AccessVerdict status = decideAccess(call("GET", "/api/status"), table);
    CHECK_EQ(status.status, 0);
    CHECK(!status.full);
    CHECK_EQ(decideAccess(call("GET", "/"), table).status, 0);
    CHECK_EQ(decideAccess(call("GET", "/generate_204"), table).status, 0);
}
TEST(a_login_key_opens_everything)        // bearer: POST every call → 0 and full; GET /api/status → full; the same key as addressKey → 401
TEST(a_message_key_opens_the_two_message_calls_and_nothing_else)  // bearer and addressKey: POST both message calls → 0, !full; every other call → 401; GET /api/status → !full
TEST(a_key_that_is_gone_is_no_key)        // removeKey(), then the same bearer → 401
TEST(nothing_needs_a_key_without_a_password)  // POST every call → 0 and full
TEST(a_plugin_cannot_log_in_or_touch_the_password) {
    // fromDevice, locked: POST /api/cards/add → 0 and full, GET /api/device → 0;
    // 403 for POST /api/login, POST /api/password, GET and POST /api/keys, POST /api/logout,
    // POST /api/device, POST /api/restart, POST /api/update/start. The same without a password.
}
TEST(another_website_is_refused_with_or_without_a_password) {
    // origin "http://evil.example" → 403 on POST /api/restart, also with a login key
    // origin "http://deskhog.local", host "deskhog.local" → 0
    // origin "HTTP://DeskHog.local" → 0
    // origin "http://localhost:8080", host "localhost:8080" → 0
    // origin "http://192.168.1.20", host "192.168.1.20" → 0
    // origin "null" → 403
    // origin "http://evil.example" on GET "/" → 0
}
TEST(calls_that_change_something_refuse_get) {
    // no password: GET /api/cards/show, /api/cards/press, /api/connections/remove, /api/restart,
    // /api/something/new → 405; GET /api/state, /api/plugins/hello, /api/cards/screen → 0;
    // OPTIONS /api/state → 405. Locked, no key: GET /api/cards/show → 401, not 405.
}
TEST(the_hold_counts_down_and_fires_once) {
    RemoveHold hold;
    CHECK_EQ(hold.tick(true, 100).secondsLeft, -1);
    CHECK_EQ(hold.tick(true, 2099).secondsLeft, -1);
    CHECK_EQ(hold.tick(true, 2100).secondsLeft, 8);
    CHECK_EQ(hold.tick(true, 10099).secondsLeft, 1);
    CHECK(hold.tick(true, 10100).fire);
    CHECK(!hold.tick(true, 10200).fire);
    CHECK_EQ(hold.tick(true, 10200).secondsLeft, -1);
    CHECK_EQ(hold.tick(false, 10300).secondsLeft, -1);
    CHECK_EQ(hold.tick(true, 10400).secondsLeft, -1);     // a new hold starts from nothing
    CHECK_EQ(hold.tick(true, 12400).secondsLeft, 8);
}
TEST(letting_go_cancels_the_hold)         // held to 5 s, released, held again: no fire before another full 10 s
TEST(the_hold_survives_millis_wrapping)   // start at 0xFFFFF000
```

- [ ] **Step 2: Run** `test/native/run.sh 2>&1 | tail -5`. Expected: it does not compile (`decideAccess` not declared).
- [ ] **Step 3: Implement `decideAccess` and `RemoveHold`** in `lib/access/src/Access.cpp`.
- [ ] **Step 4: Run** `test/native/run.sh 2>&1 | tail -3`. Expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add lib/access test/native
git commit -m "Who may call what, and the hold that removes the password"
```

---

### Task 3: The check in front of every route

**Files:**
- Create: `src/DeviceAccess.h`, `src/DeviceAccess.cpp`, `src/plugins/AccessApi.h`, `src/plugins/AccessApi.cpp`
- Modify: `src/ConfigManager.h/.cpp`, `src/plugins/PluginApi.cpp`, `src/ui/CaptivePortal.h/.cpp`, `src/main.cpp`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces:

```cpp
// ConfigManager
struct SavedAccess { String salt; uint32_t rounds = 0; String verifier; String keys; };
SavedAccess getAccess();
void saveAccess(const SavedAccess& access);   // an empty verifier removes all four entries

// DeviceAccess.h
class DeviceAccess {
public:
    explicit DeviceAccess(ConfigManager& config);
    void begin();                                               // load what is saved
    /** Run `work` with the table and the guard under the lock. When it returns true, the table is saved. */
    void with(const std::function<bool(deskhog::AccessTable&, deskhog::LoginGuard&)>& work);
    deskhog::AccessVerdict decide(const deskhog::AccessRequest& request);
    bool hasPassword();
    void removeAtDevice();                                      // from the UI task: forget the password and every key
    static String randomHex(size_t bytes);                      // esp_fill_random
    static String deviceId();                                   // the 6 bytes of ESP.getEfuseMac() as 12 hex digits
};

// AccessApi.h
void registerAccessRoutes(AsyncWebServer& server, DeviceAccess& access);
deskhog::AccessVerdict verdictFor(AsyncWebServerRequest* request);
bool refusedEarly(AsyncWebServerRequest* request);              // true: the check will refuse this request
```

- [ ] **Step 1: `ConfigManager`.** Add `getAccess` and `saveAccess` using the four NVS entries from Global Constraints. Nothing is printed.
- [ ] **Step 2: `DeviceAccess`.** A mutex around the table and the guard. `fromDevice` is not its business: the caller fills the request.
- [ ] **Step 3: `AccessApi`.** `verdictFor` builds an `AccessRequest` from the method, `request->url()`, the `Origin`, `Host` and `Authorization` headers and the `auth` query parameter; `fromDevice` is the test `refusedFromDevice` in `PluginApi.cpp` makes today (`127.x`, `WiFi.localIP()`, `WiFi.softAPIP()`). `registerAccessRoutes` adds one server middleware (`server.addMiddleware`) that answers a verdict with a status as JSON (`{"ok": false, "error": ...}`, plus `"locked": true` for 401, `Cache-Control: no-store`) and otherwise calls `next()`. The routes themselves come in Task 4.

  The web server calls a route's body handler before it runs middleware (`WebRequest.cpp`, `_onData` before `_runMiddlewareChain`). So `collectBody` in `PluginApi.cpp` starts with `if (index == 0 && refusedEarly(request)) return;`: a refused request's body is never kept.
- [ ] **Step 4: `PluginApi.cpp`.** Remove `addCors`, `answerPreflight` and every call to them, and `refusedFromDevice` and its three calls (rule 4 of `decideAccess` replaces it).
- [ ] **Step 5: `CaptivePortal`.** The constructor takes a `DeviceAccess&`; `begin()` calls `registerAccessRoutes` before the other routes. Remove the three `Access-Control-Allow-Origin` headers. `handleApiStatus` answers only `{"locked": true, "updater": false}` when `verdictFor(request).full` is false.
- [ ] **Step 6: `main.cpp`.** Create `DeviceAccess` after `ConfigManager`, call `begin()`, hand it to `CaptivePortal`. Keep the pointer global (`deviceAccess`) for Task 8.
- [ ] **Step 7: Build** `~/.platformio/penv/bin/pio run 2>&1 | tail -15`. Expected: `SUCCESS`; note the firmware size against 2,228,224 bytes.
- [ ] **Step 8: Check nothing is left** `grep -rn "Access-Control\|answerPreflight\|refusedFromDevice" src/`. Expected: no lines.
- [ ] **Step 9: Run** `test/native/run.sh 2>&1 | tail -3`. Expected: all pass.
- [ ] **Step 10: Commit**

```bash
git add src
git commit -m "One check in front of every route; other websites are refused"
```

---

### Task 4: Logging in, the password and the keys over the API

**Files:**
- Modify: `src/plugins/AccessApi.cpp`, `src/plugins/PluginApi.cpp` (`deviceToJson`)

**Interfaces:**
- Consumes: `DeviceAccess::with`, `randomHex`, `deviceId`, `verdictFor` (Task 3); `DeskManners::settings().name` for the name.
- Produces, as JSON over HTTP (Tasks 5 to 10 rely on these shapes):

```
GET  /api/login      {"locked": true, "name": "kitchen", "id": "<12 hex>", "salt": "<32 hex>", "rounds": 20000, "nonce": "<32 hex>"}
                     without a password: locked false, salt "", rounds 0. Every call issues a new nonce
POST /api/login      {"nonce", "proof"}                        → {"ok": true, "key": "<32 hex>"}
POST /api/password   no password yet: {"salt", "rounds", "verifier"}                 → {"ok": true, "key": "<32 hex>"}
                     change: {"nonce", "proof", "salt", "rounds", "verifier": <masked>} → {"ok": true}
                     remove: {"nonce", "proof", "remove": true}                        → {"ok": true}
GET    /api/keys     {"logins": 3, "messages": [{"id": 4, "name": "doorbell", "key": "<32 hex>"}]}
POST   /api/keys     {"name"}                                  → {"ok": true, "id": 4, "name": "doorbell", "key": "<32 hex>"}
DELETE /api/keys?id=4                                          → {"ok": true}
POST   /api/logout   removes the key the request came with; with ?others=1 every login key but that one → {"ok": true}
```

Errors, all `{"ok": false, "error": "..."}`:

| When | Status | error |
|---|---|---|
| a proof that is wrong | 403 | `That is not the password.` |
| a nonce that is unknown, used or older than a minute | 403 | `That took too long. Try again.` |
| after five wrong tries, for a minute | 429 | `Too many wrong tries. Wait a minute.` |
| `POST /api/login` without a password set | 409 | `This DeskHog has no password.` |
| `POST /api/keys` without a password set | 409 | `Set a password first.` |
| a ninth message key | 409 | `There are 8 message keys. Remove one first.` |
| a bad name, salt, rounds or verifier | 400 | says which |
| `DELETE /api/keys` with an id no message key has | 404 | `no such key` |

`/api/device` status gains `"password": true|false`. (`"updater"` comes in Task 9.)

- [ ] **Step 1: Implement the four routes** in `AccessApi.cpp`, each inside `DeviceAccess::with`. A nonce is taken (`LoginGuard::take`) before the proof is looked at, so it works once whether the proof was right or wrong. A wrong proof calls `wrong()`, a right one `right()`, on all three uses of a proof. A change removes every login key but the one the request came with and keeps the message keys. Setting the first password adds a login key and returns it. Bodies are collected like the other routes' (`collectBody`), so they are refused early too.
- [ ] **Step 2: `status.password`** in `deviceToJson`.
- [ ] **Step 3: Build** `~/.platformio/penv/bin/pio run 2>&1 | tail -15`. Expected: `SUCCESS`; note the size.
- [ ] **Step 4: Check the log is clean** `grep -n "Serial" src/DeviceAccess.cpp src/plugins/AccessApi.cpp`. Expected: no line prints a salt, verifier, nonce, proof or key.
- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "Logging in, the password and message keys over the API"
```

---

### Task 5: The login maths in JavaScript, and a pretend device that can be locked

**Files:**
- Create: `html/login.js`
- Modify: `html/portal.html` (`<script src="login.js"></script>` before `portal.js`), `htmlconvert.py` (inline `login.js` the way it inlines `portal.js`), `test/portal/pretend-device.js`, `test/portal/serve.js`, `test/portal/portal.test.js`

**Interfaces:**
- Consumes: the JSON shapes and errors of Task 4; the rules of Task 2.
- Produces:

```js
// html/login.js: plain functions, and module.exports of the same when run by node
function passwordVerifier(password, saltHex, rounds)            // → 64 hex digits; normalises the password to NFC
function loginProof(verifierHex, nonceHex)                      // → 64 hex digits
function maskedVerifier(oldVerifierHex, nonceHex, newVerifierHex) // → 64 hex digits

// test/portal/pretend-device.js
device.handle(method, url, body, headers)   // headers: an object with lowercase names; may be left out
device.access                               // {password: null | {salt, rounds, verifier}, logins: [key], messages: [{id, name, key}], nonces: [nonce], updater: 2}
device.lock(password)                       // sets a password (100 rounds) and returns nothing
device.loginKey()                           // adds a login key and returns it
```

The pretend device follows the eight rules of Task 2 and answers as Task 4 says, in its firmware and in its updater (where only `/api/status`, `/api/login`, `/api/firmware` and `/api/restart` exist, a login key lasts until `inUpdater` goes false, and the trimmed status is `{"locked": true, "updater": true}`). `deviceNow()` reports `status.password` and `status.updater`.

- [ ] **Step 1: Write the failing tests** in `portal.test.js`. The fetch stub in `openPage` passes `options.headers` on to `device.handle` with lowercase names and records them in `device.requests[n].headers`. Load `html/login.js` with `require`.

```js
test('the login maths match the vectors', async () => {
    const v = vectors();                       // test/access/vectors.txt as an object
    equal(login.passwordVerifier(v.password, v.salt, 1000), v.verifier, 'the verifier');
    equal(login.loginProof(v.verifier, v.nonce), v.proof, 'the proof');
    equal(login.maskedVerifier(v.verifier, v.nonce, v.new_verifier), v.masked, 'the masked verifier');
    const odd = JSON.parse(v.utf8_password);
    equal(login.passwordVerifier(odd, v.salt, 1000), v.utf8_verifier, 'spaces, an umlaut and an emoji');
    equal(login.passwordVerifier(odd.normalize('NFD'), v.salt, 1000), v.utf8_verifier, 'typed as NFD');
});
test('twenty thousand rounds take well under a second here', ...)   // passwordVerifier(..., 20000) in less than 1000 ms
test('a locked pretend device answers like the firmware', async () => {
    // lock(); no key: GET /api/state → 401 with locked true; GET /api/status → {locked: true, updater: false};
    // GET /api/login → locked, salt, rounds 100, a nonce; POST /api/login with the proof → a key;
    // the same nonce again → 403; a wrong proof five times → 429 on the sixth;
    // the key as authorization "Bearer <key>": GET /api/state → 200;
    // a message key: POST /api/cards/message?key=weather:1&auth=<key> → 200, GET /api/state → 401;
    // origin "http://evil.example" with a login key → 403; GET /api/cards/show → 405 without a password;
    // in the updater: POST /api/firmware without a key → 401, GET /api/status → {locked: true, updater: true}
});
```

- [ ] **Step 2: Run** `test/portal/run.sh 2>&1 | tail -8`. Expected: FAIL, `Cannot find module` for `login.js`.
- [ ] **Step 3: Write `html/login.js`.** Its own SHA-256 (the page is plain HTTP, so there is no `crypto.subtle`), HMAC and PBKDF2, on `Uint8Array`. Passwords become bytes with `TextEncoder` after `normalize('NFC')`. Keep it under 4 KB of source.
- [ ] **Step 4: `htmlconvert.py`, `portal.html`, and `portal.test.js`'s loader** (strip the new script tag too, and add `login.js`'s text before `portal.js`'s).
- [ ] **Step 5: The pretend device.** Then `serve.js`: pass `request.headers` to `device.handle`; `--password <text>` locks the pretend device; `forward()` sets the `origin` header to `http://` + the real device's address when the browser sent one.
- [ ] **Step 6: Run** `test/portal/run.sh 2>&1 | tail -3`. Expected: all pass, the old tests too.
- [ ] **Step 7: Build** `~/.platformio/penv/bin/pio run 2>&1 | tail -6`. Expected: `SUCCESS`. The build writes `include/html_portal.h` again, which is committed with the page; check it now holds `passwordVerifier`.
- [ ] **Step 8: Commit**

```bash
git add html htmlconvert.py include/html_portal.h test/portal
git commit -m "The login maths for the page, and a pretend device that can be locked"
```

---

### Task 6: The page logs in

**Files:**
- Modify: `html/portal.html`, `html/portal.js`, `html/portal.css`, `test/portal/portal.test.js`

**Interfaces:**
- Consumes: `passwordVerifier`, `loginProof` (Task 5); the JSON shapes of Task 4; `device.lock`, `device.loginKey`.
- Produces, in `portal.js` (Task 7 uses them):

```js
let access = null;                       // the last answer of GET /api/login
function sessionKey()                    // the key, or '' ; from localStorage 'deskhog-key', or from memory when storage is refused
function setSessionKey(key)              // '' forgets it
async function deviceFetch(url, options) // fetch() to the device with the key added; a 401 forgets the key and shows the login screen
async function askAccess()               // GET /api/login into `access`, and returns it
function showLogin()                     // nothing of the page but the login screen
async function logIn(password)           // a fresh nonce, the proof, POST /api/login; true when it worked
```

Markup, in `portal.html` before `<main>`; `body.locked` hides the navigation and `<main>`:

```html
<section id="login" class="login" hidden>
    <h1>DeskHog <span id="login-name"></span></h1>
    <p>This DeskHog has a password.</p>
    <form id="login-form">
        <input type="password" id="login-password" autocomplete="current-password" aria-label="Password">
        <button type="submit">Log in</button>
    </form>
    <p id="login-error" role="alert"></p>
    <p><small>Forgot it? Hold ▲ and ▼ on the DeskHog for ten seconds.</small></p>
</section>
```

- [ ] **Step 1: Write the failing tests.**

```js
test('a locked device shows the login screen and nothing else', ...)
    // lock(); open: #login visible, body has class locked, #login-name is the device's name,
    // and no request went to /api/state
test('a wrong password says so, the right one opens the page', ...)
    // 'wrong password' → #login-error has "That is not the password."; then the right one:
    // #login hidden, the cards are there, and every later device request carries authorization "Bearer <key>"
test('the key goes to the device and nowhere else', ...)
    // logged in, open the plugin directory and check for firmware: no request to an http(s) address carries
    // an authorization header (record them in the stub's outside branch); every device request does
test('a key that stopped working leads back to the login screen', ...)
    // logged in; device.access.logins = []; the next refresh() → #login visible, sessionKey() === ''
test('a login screen left open still logs in', ...)
    // open while locked; device.access.nonces = [] (as after a restart); type the password: it works the first time
test('the page works when the browser refuses storage', ...)
    // window.localStorage's getItem and setItem throw; log in: the page works, requests carry the key
test('a reload stays logged in', ...)
    // log in, open a second page with the same storage: no login screen
test('a rename takes the key along', ...)
    // logged in at http://deskhog.local/, rename to kitchen: goTo is called with
    // 'http://kitchen.local/#device&key=<key>'; a page opened at that address holds the key,
    // and its address no longer shows it (location.hash === '#device')
test('an update on a locked device goes through its updater', ...)
    // logged in; the firmware offer; Update: device.firmware.installed has one entry and the
    // POST /api/firmware request carried the key
```

  To share storage between two pages in a test, `openPage` takes `options.storage` (an object used for `getItem`/`setItem`/`removeItem`).

- [ ] **Step 2: Run** `test/portal/run.sh 2>&1 | tail -15`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** `api()` and the two raw device fetches (`/api/cards/screen` and `firmwareStatus()`) go through `deviceFetch`; the fetches to plugin directories and GitHub do not. `start()` reads `key=` from the address first (stores it, removes it with `history.replaceState`), then `askAccess()`: locked without a key shows the login screen; otherwise the page starts as today. While the login screen shows, `refresh()` and `pollStatus()` do nothing. `logIn` calls `askAccess()` itself for a nonce, shows "Checking..." before the maths, and puts the device's `error` in `#login-error`. `renamedAddress` adds `&key=<key>` when there is a key.
- [ ] **Step 4: Run** `test/portal/run.sh 2>&1 | tail -3`. Expected: all pass.
- [ ] **Step 5: Build** `~/.platformio/penv/bin/pio run 2>&1 | tail -6`. Expected: `SUCCESS` (it writes `include/html_portal.h` again).
- [ ] **Step 6: Commit**

```bash
git add html include/html_portal.h test/portal
git commit -m "The page logs in and sends its key with every call to the device"
```

---

### Task 7: The Password panel and message keys

**Files:**
- Modify: `html/portal.html`, `html/portal.js`, `html/portal.css`, `test/portal/portal.test.js`

**Interfaces:**
- Consumes: everything Task 6 produces; `maskedVerifier` (Task 5); `state.device.status.password`, `status.updater`, `status.layout`.
- Produces: a panel in the Device page, after the Name panel: `<div class="panel" id="password-panel"><h2>Password</h2><div id="password-form"></div></div>`, and `let passwordRounds = 20000;` in `portal.js` (tests lower it).

Element ids the tests use: `set-password-btn`, `change-password-btn`, `remove-password-btn`, `logout-btn`, `logout-others-btn`, `new-password`, `new-password-again`, `current-password`, `save-password-btn`, `message-keys` (the list), `key-name`, `add-key-btn`. The panel's texts follow the two sketches under "The page" in the spec.

- [ ] **Step 1: Write the failing tests.**

```js
test('no password: the panel says so and offers to set one', ...)
    // text includes "No password. Anyone on your network can change this DeskHog."
test('setting a password logs this browser in', ...)
    // two fields; 7 characters → refused with a reason, nothing sent; two that differ → refused;
    // "correct horse battery" twice → POST /api/password with salt (32 hex), rounds 100, verifier (64 hex)
    // and no field that holds the password itself; device.access.password is set; sessionKey() is the answer's key
test('changing the password needs the old one and sends the new one masked', ...)
    // wrong current → "That is not the password.", nothing changed;
    // right: the request's verifier is not the new verifier, the device ends with the new one
    // (a login with the new password works), this browser stays logged in, another login key is gone
test('removing the password asks first and needs the password', ...)
    // confirm, current password: device.access.password === null, no keys left, the panel shows "No password"
test('log out, and log out everywhere else', ...)
    // logout-others: device.access.logins is this key only; logout: the key is gone on the device and
    // in the browser, #login shows
test('message keys can be added, copied and removed', ...)
    // add "doorbell": POST /api/keys {name: 'doorbell'}; the list shows the name and the key;
    // the line above says how to use it and includes "&auth="; remove asks first, then DELETE /api/keys?id=
test('the panel counts the other logins', ...)
    // two more login keys on the device: "and 2 other browsers or computers"
test('an old updater is pointed out where the password is', ...)
    // device.access.updater = 1: the panel says the updater is from before passwords and names
    // `pio run -e updater -t upload`; the update confirmation says it too; with updater 2 neither does;
    // on layout 1 (no updater) neither does
test('a password removed at the device is noticed', ...)
    // the browser holds a key, the device has no password: the notice says the password was removed
    // at the DeskHog, sessionKey() === ''
```

- [ ] **Step 2: Run** `test/portal/run.sh 2>&1 | tail -15`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** A new salt comes from `crypto.getRandomValues`. Changing and removing fetch a nonce with `askAccess()` right before they send. Copy uses `navigator.clipboard` when there is one and otherwise selects the key's text.
- [ ] **Step 4: Run** `test/portal/run.sh 2>&1 | tail -3`. Expected: all pass.
- [ ] **Step 5: Page size** `wc -c html/portal.html html/portal.css html/portal.js html/login.js`. Note the total; `tech-details.md` says 121,371 bytes today and is updated in Task 11.
- [ ] **Step 6: Build** `~/.platformio/penv/bin/pio run 2>&1 | tail -6`. Expected: `SUCCESS`, still under 2,228,224 bytes; note the size.
- [ ] **Step 7: Commit**

```bash
git add html include/html_portal.h test/portal
git commit -m "The Password panel: set, change, remove, log out, and keys for messages"
```

---

### Task 8: ▲ and ▼ at the device

**Files:**
- Create: `src/ui/RemoveOverlay.h`, `src/ui/RemoveOverlay.cpp`
- Modify: `src/main.cpp` (the button block in the UI task, around lines 118 to 166)

**Interfaces:**
- Consumes: `deskhog::RemoveHold` (Task 2), `DeviceAccess::hasPassword`, `DeviceAccess::removeAtDevice` (Task 3).
- Produces:

```cpp
// RemoveOverlay.h: UI task only
namespace RemoveOverlay {
void show(int secondsLeft);   // "Removing the password in 8", over whatever card is showing
void done();                  // "Password removed", for two seconds
void hide();
void tick(uint32_t now);      // takes "Password removed" away again
}
```

- [ ] **Step 1: `RemoveOverlay`.** One label on `lv_layer_top()`, made on first use, with a dark background so it reads over any card.
- [ ] **Step 2: `main.cpp`.** In the button block: `RemoveHold::State hold = removeHold.tick(upHeld && downHeld && deviceAccess->hasPassword(), millis());`. A `secondsLeft` of 1 or more shows the countdown, `fire` calls `deviceAccess->removeAtDevice()` and `RemoveOverlay::done()`, anything else hides it. While ▲ and ▼ are both held, single presses are not handed to the card stack, as with ● and ▼.
- [ ] **Step 3: Build** `~/.platformio/penv/bin/pio run 2>&1 | tail -15`. Expected: `SUCCESS`; note the size.
- [ ] **Step 4: Run** `test/native/run.sh 2>&1 | tail -3`. Expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "Holding up and down for ten seconds removes the password"
```

---

### Task 9: Updater 2

**Files:**
- Create: `updater/login_js.py`
- Modify: `updater/main.cpp`, `platformio.ini` (`[env:updater]`: `-DUPDATER_VERSION="\"2\""`, `pre:${PROJECT_DIR}/updater/login_js.py` in `extra_scripts`), `updater/include_updater.py` (its `sources` list gains `html/login.js` and the files in `lib/access/src`), `src/plugins/PluginApi.cpp`, `.gitignore` (`updater/login_js.h`)

**Interfaces:**
- Consumes: `lib/access` (Tasks 1 and 2), `html/login.js` (Task 5), the JSON shapes of Task 4 for `/api/login`.
- Produces: an updater that answers as the pretend device's updater does (Task 5); the text `DESKHOG-UPDATER-VERSION:2` inside its image; `status.updater` in `/api/device`: 0 without an updater slot, 1 when the slot has no such text, else the number after the colon.

- [ ] **Step 1: `updater/login_js.py`** writes `updater/login_js.h` with `html/login.js` as one raw string, `kLoginJs`, on every build.
- [ ] **Step 2: `updater/main.cpp`.**
  - `setup()` reads `pw_salt`, `pw_rounds`, `pw_ver` and `pw_keys` from `wifi_config` into an `AccessTable` (`setPassword`, `loadKeys`). It never writes them.
  - `server.collectHeaders` for `Origin` and `Authorization`. A function `refused()` builds an `AccessRequest` (`server.hostHeader()` for the host, `fromDevice` false), asks `decideAccess`, and sends the answer when the verdict has a status. `/api/firmware`'s final handler, `/api/restart` and `/api/status` call it first; `/api/status` sends only `{"locked": true, "updater": true}` when the verdict is not `full`.
  - `onUpload` asks `decideAccess` at `UPLOAD_FILE_START` and, when refused, sets a flag that makes the write and end parts do nothing. Nothing is written and `mainIntact` stays as it was.
  - `GET` and `POST /api/login` as in Task 4, with a `LoginGuard`. The key is made with `esp_fill_random`, added with `addLogin`, and not saved. `id` is made exactly as `DeviceAccess::deviceId` makes it.
  - No `Access-Control-Allow-Origin` header.
  - `kPage` includes `kLoginJs`. Its script reads `localStorage['deskhog-key']`, sends it as `Authorization: Bearer` with every fetch, and when `/api/status` says `locked` shows a password field that logs in with `passwordVerifier` and `loginProof`.
  - `const char kMarker[] = "DESKHOG-UPDATER-VERSION:" UPDATER_VERSION;`, used for the `version` in `sendStatus` so the linker keeps it.
- [ ] **Step 3: Build** `~/.platformio/penv/bin/pio run -e updater 2>&1 | tail -15`. Expected: `SUCCESS`, the size under 1,048,576 bytes; note it. The library list in the output names `access` and neither `plugin_core` nor `lua`.
- [ ] **Step 4: The marker is there** `grep -c "DESKHOG-UPDATER-VERSION:2" .pio/build/updater/firmware.bin`. Expected: `1`.
- [ ] **Step 5: `status.updater`** in `PluginApi.cpp`: `int updaterVersion()` maps the updater slot (`esp_partition_mmap`), looks for the text, and remembers the answer. `deviceToJson` reports it.
- [ ] **Step 6: Build** `~/.platformio/penv/bin/pio run 2>&1 | tail -15`. Expected: `SUCCESS`; note the size.
- [ ] **Step 7: Commit**

```bash
git add updater platformio.ini src .gitignore
git commit -m "Updater 2 asks for a key, and the firmware knows which updater it has"
```

---

### Task 10: `tools/deskhog` logs in

**Files:**
- Create: `test/cli/run.sh`
- Modify: `tools/deskhog`, `.github/workflows/test.yml` (a step `Command-line tests` running `test/cli/run.sh`, after the web page tests)

**Interfaces:**
- Consumes: the JSON shapes of Task 4; `serve.js --password` (Task 5).
- Produces:

```python
def password_verifier(password, salt_hex, rounds)   # hashlib.pbkdf2_hmac on the NFC password, → hex
def login_proof(verifier_hex, nonce_hex)            # → hex
# tools/deskhog login    asks for the password; saves the key
# tools/deskhog logout   removes the key, on the device and in the file
```

The key file is `keys.json` in `$XDG_CONFIG_HOME/deskhog` (default `~/.config/deskhog`; `%APPDATA%\deskhog` on Windows), mode 600, an object from the device's `id` to its key. `DESKHOG_KEY` in the environment is used instead when set. The password is asked with `getpass` when stdin is a terminal and read as one line from stdin otherwise.

- [ ] **Step 1: Write the failing test** `test/cli/run.sh`: it starts `node test/portal/serve.js --port 8765 --password "correct horse battery"` in the background, with `XDG_CONFIG_HOME` in a temporary folder, and stops it at the end. It fails on the first check that does not hold:

  1. Python loads `tools/deskhog` (`importlib.machinery.SourceFileLoader`) and gets the vectors' `verifier` from `password_verifier`, `proof` from `login_proof`, and `utf8_verifier` from the JSON-decoded `utf8_password`, also when that is given as NFD.
  2. `tools/deskhog --host localhost:8765 list` exits 1 and its error names `tools/deskhog login`.
  3. `printf 'wrong password\n' | tools/deskhog --host localhost:8765 login` exits 1 with `That is not the password.`
  4. `printf 'correct horse battery\n' | tools/deskhog --host localhost:8765 login` exits 0; `keys.json` exists with mode 600.
  5. `tools/deskhog --host localhost:8765 list` exits 0. So does `--host 127.0.0.1:8765` (the same `id`, the same key).
  6. `tools/deskhog --host localhost:8765 logout` exits 0; `list` exits 1 again.
  7. After logging in again, the script reads the key from `keys.json` and removes the file; with `DESKHOG_KEY` set to that key, `list` exits 0.

- [ ] **Step 2: Run** `test/cli/run.sh`. Expected: FAIL at check 1 (`password_verifier` is missing).
- [ ] **Step 3: Implement.** `Device` learns its key on first use: `DESKHOG_KEY`, or, when the key file has entries, the device's `id` from `GET /api/login` looked up in it. Every request carries it, including the upload in `install_firmware`, which goes through the same code as the others. A 401 becomes `This DeskHog has a password. Run tools/deskhog login.` `login` on a device without a password says so and exits 0.
- [ ] **Step 4: Run** `test/cli/run.sh`. Expected: `ok` and exit 0. Then `python3 tools/deskhog index --check`. Expected: exit 0.
- [ ] **Step 5: Commit**

```bash
git add tools/deskhog test/cli .github/workflows/test.yml
git commit -m "tools/deskhog login and logout"
```

---

### Task 11: Docs and the final checks

**Files:**
- Modify: `README.md`, `plugins/README.md`, `tech-details.md`, `src/plugins/PluginApi.h`, `getting-started/start-here.md`

- [ ] **Step 1: `README.md`.** A short "Password" part after "Updating": setting it on the Device page, what it protects, what it does not (someone capturing the WiFi traffic, someone at the device), ▲ and ▼ for ten seconds, `tools/deskhog login`, and the one-time USB step for the updater (`pio run -e updater -t upload`, or `deskhog-<version>-updater.bin` at `0x20000` with a browser flasher). Rewrite the "Anyone on your network can do this" line under Updating.
- [ ] **Step 2: `plugins/README.md`.** The two "no login" paragraphs (in "Messages" and above "Publishing a plugin"); messages with a message key, in the header and as `&auth=`; the new calls in the API list; `Authorization: Bearer` in the `curl` examples; that show, press and remove are POST only.
- [ ] **Step 3: `tech-details.md`.** A part "Password": `lib/access` and what is in it, the check in front of the routes and how to open a call on purpose (rule 6 and rule 8 of `decideAccess`, with a test), why body collectors ask `refusedEarly`, what is in NVS, the login exchange, the updater's part and its marker. Add ▲ with ▼ to the combinations under "Buttons". Update the page size and the two firmware sizes.
- [ ] **Step 4: `PluginApi.h` and `start-here.md`.** The comment's last paragraph ("there is no login") and its list of calls; one line in the guide that a password can be set on the Device page.
- [ ] **Step 5: No stale claims** `grep -rn -i "no login\|anyone on" README.md plugins/README.md tech-details.md getting-started src/plugins/PluginApi.h`. Expected: every line left is true.
- [ ] **Step 6: Everything passes**

```bash
test/native/run.sh 2>&1 | tail -3
test/portal/run.sh 2>&1 | tail -3
test/cli/run.sh
python3 tools/deskhog index --check
~/.platformio/penv/bin/pio run 2>&1 | tail -6
~/.platformio/penv/bin/pio run -e updater 2>&1 | tail -6
```

  Expected: all pass, both builds `SUCCESS`, the main firmware under 2,228,224 bytes and the updater under 1,048,576.
- [ ] **Step 7: Commit**

```bash
git add README.md plugins/README.md tech-details.md src/plugins/PluginApi.h getting-started
git commit -m "Docs for the password"
```

- [ ] **Step 8: Hand Tim the checks that need his device** (the spec's last verification item), as a list to walk through together:

  1. Flash updater 2 and the firmware over USB. Without a password: the page works as before; a local HTML file that posts to `/api/restart` gets 403; `curl http://<device>/api/cards/show?key=...` gets 405.
  2. Set a password. A second browser sees only the login screen. `curl http://<device>/api/state` gets 401. A 64 KB `curl -T` of a plugin without a key gets 401 and `tools/deskhog system` shows no memory lost.
  3. A message key: `curl -d hi 'http://<device>/api/cards/message?key=<card>&auth=<key>'` reaches the plugin; the same key on `/api/state` gets 401.
  4. `tools/deskhog login`, then `tools/deskhog list`.
  5. An update over WiFi from the page while logged in. During it, `curl -F firmware=@firmware.bin http://<device>/api/firmware` without a key gets 401 and the update still finishes.
  6. Logging in on a phone: the wait after pressing Log in is about half a second.
  7. ▲ and ▼ for ten seconds: the countdown, then no password; the page says it was removed at the device. Letting go at 5 cancels.
  8. The serial log during all of this shows no salt, verifier, nonce or key.
