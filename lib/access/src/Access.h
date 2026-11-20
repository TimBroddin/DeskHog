#pragma once

// The password and the keys of a DeskHog, as rules. Nothing here touches
// hardware, storage or the network, so the firmware, the updater and the
// tests share it.
//
// The device stores a salt, a number of rounds and a verifier (what the
// password turns into with PBKDF2; the device never runs that, the page or the
// CLI does). To log in, the client proves it knows the verifier without
// sending it:
//
//   proof  = HMAC-SHA256(verifier, nonce)
//   masked = new verifier XOR HMAC-SHA256(old verifier, nonce + "new")
//
// A successful login gets a login key. The owner can also make message keys,
// which may only send messages. Every binary value travels as lowercase hex:
// salt and nonce 16 bytes, verifier and proof 32, a key 16.
//
// Not thread safe: callers keep one lock around a table and a guard.

#include <stddef.h>
#include <stdint.h>
#include <string>
#include <vector>

namespace deskhog {

enum class KeyKind { Login, Message };

struct AccessKey {
    int id = 0;
    KeyKind kind = KeyKind::Login;
    std::string key;     ///< 32 hex digits
    std::string name;    ///< Message keys only
};

class AccessTable {
public:
    static constexpr size_t kMaxLogins = 8;
    static constexpr size_t kMaxMessageKeys = 8;
    static constexpr size_t kMaxName = 24;
    static constexpr int kMaxRounds = 10000000;

    bool hasPassword() const;
    const std::string& salt() const;
    int rounds() const;
    const std::string& verifier() const;    ///< For saving only, never for an answer

    /** False, and nothing changed, unless salt is 32 hex digits, verifier 64 and rounds 1 to 10,000,000. */
    bool setPassword(const std::string& salt, int rounds, const std::string& verifier);
    void removePassword();                  ///< And every key

    /** True when proof is HMAC-SHA256(verifier, nonce). False without a password or with malformed hex. */
    bool checkProof(const std::string& nonce, const std::string& proof) const;
    /** Undoes the mask of a new verifier. False without a password or with malformed hex. */
    bool unmask(const std::string& nonce, const std::string& masked, std::string& newVerifier) const;

    /** Looks a key up. Takes the same time whichever key matches, or none. */
    bool find(const std::string& key, AccessKey& found) const;
    AccessKey addLogin(const std::string& key);    ///< A ninth replaces the one with the lowest id
    /** False when the name is not 1 to 24 bytes without a control character, the key exists, or 8 exist. */
    bool addMessageKey(const std::string& key, const std::string& name, AccessKey& added);
    bool removeMessageKey(int id);
    bool removeKey(const std::string& key);
    void removeLoginsExcept(const std::string& key);
    size_t logins() const;
    std::vector<AccessKey> messageKeys() const;

    /** One line per key: "<L|M>\t<id>\t<key>\t<name>\n". */
    std::string keysText() const;
    /** Replaces the keys the table had. Skips lines it cannot read, and keys past the 8 of each kind. */
    void loadKeys(const std::string& text);

private:
    int nextId() const;

    std::string salt_;
    int rounds_ = 0;
    std::string verifier_;
    std::vector<AccessKey> keys_;
};

/**
 * Remembers the nonces handed out and the wrong proofs, so a nonce works once
 * and guessing is slow. Times are millis() values; only differences are
 * compared, so they survive the counter wrapping.
 */
class LoginGuard {
public:
    static constexpr uint32_t kNonceMs = 60000;
    static constexpr uint32_t kWaitMs = 60000;
    static constexpr int kWrongTries = 5;
    static constexpr size_t kNonces = 16;    ///< Every page load and CLI command asks for one

    void issue(const std::string& nonce, uint32_t now);    ///< The seventeenth pushes out the oldest
    bool take(const std::string& nonce, uint32_t now);     ///< True once per nonce, within a minute of issue
    bool waiting(uint32_t now) const;                      ///< True while logins are refused
    void wrong(uint32_t now);
    void right();

private:
    struct Issued {
        std::string nonce;
        uint32_t at;
    };
    void dropOld(uint32_t now);

    std::vector<Issued> nonces_;    ///< Oldest first
    int wrongInARow_ = 0;
    mutable bool locked_ = false;    ///< Cleared once the wait is over, so a wrapped counter cannot bring it back
    uint32_t lockedAt_ = 0;
};

/** One call to the device's HTTP API, as far as deciding who may make it goes. */
struct AccessRequest {
    std::string method;      ///< Whatever the request had: "GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD" ...
    std::string path;        ///< Without the query
    std::string origin;      ///< The Origin header, "" when there is none
    std::string host;        ///< The Host header
    std::string bearer;      ///< What follows "Authorization: Bearer ", "" when there is none
    std::string addressKey;  ///< ?auth=, "" when there is none
    bool fromDevice = false; ///< The device calling itself: a plugin
};

struct AccessVerdict {
    int status = 0;          ///< 0: let it through. Otherwise answer this status with `error`
    const char* error = "";  ///< Always a string literal
    bool full = false;       ///< May see everything: no password, a login key, or the device itself
    bool hasKey = false;
    AccessKey key;           ///< The key it came with, when hasKey
};

/**
 * Decides who may make a call. Everything under /api/ is locked on a device
 * with a password unless it is on the short list of open calls in the .cpp.
 * The rules are numbered there, in the order they apply.
 */
AccessVerdict decideAccess(const AccessRequest& request, const AccessTable& table);

/**
 * The two buttons held together to remove the password at the device. Nothing
 * for two seconds, then a countdown, then one fire at ten seconds; after that
 * nothing until the buttons were let go. Times are millis() values; only
 * differences are compared, so they survive the counter wrapping.
 */
class RemoveHold {
public:
    static constexpr uint32_t kShowMs = 2000;
    static constexpr uint32_t kFireMs = 10000;
    struct State {
        int secondsLeft = -1;    ///< -1: show nothing
        bool fire = false;
    };
    State tick(bool bothHeld, uint32_t now);

private:
    bool held_ = false;
    bool fired_ = false;
    uint32_t since_ = 0;
};

}  // namespace deskhog
