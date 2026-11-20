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
    static constexpr size_t kNonces = 4;

    void issue(const std::string& nonce, uint32_t now);    ///< The fifth pushes out the oldest
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

}  // namespace deskhog
