#pragma once

// SHA-256 (FIPS 180-4), HMAC-SHA256 and the hex helpers the password needs.
//
// Written out here and not taken from mbedtls so the same code runs in the
// firmware, in the updater and in the desktop tests. Standard C++ only.

#include <stddef.h>
#include <stdint.h>
#include <string>

namespace deskhog {

class Sha256 {
public:
    Sha256();
    void update(const uint8_t* data, size_t length);
    /** Ends the hash and writes 32 bytes. The object is not usable afterwards. */
    void finish(uint8_t out[32]);

private:
    void block(const uint8_t* chunk);

    uint32_t state_[8];
    uint8_t buffer_[64];
    size_t buffered_;
    uint64_t total_;    ///< Bytes taken in so far
};

void hmacSha256(const uint8_t* key, size_t keyLength, const uint8_t* message, size_t messageLength, uint8_t out[32]);

/** Lowercase hex, two digits per byte. */
std::string toHex(const uint8_t* bytes, size_t count);

/** True only for exactly 2 * count hex digits, in either case. */
bool fromHex(const std::string& text, uint8_t* out, size_t count);

/** Compares count bytes and takes the same time whatever differs. */
bool sameBytes(const uint8_t* a, const uint8_t* b, size_t count);

}  // namespace deskhog
