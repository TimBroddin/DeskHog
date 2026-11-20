#include "Sha256.h"

#include <string.h>

namespace deskhog {

namespace {

const uint32_t kRound[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

uint32_t rotr(uint32_t value, int bits) { return (value >> bits) | (value << (32 - bits)); }

}  // namespace

Sha256::Sha256() : buffered_(0), total_(0) {
    static const uint32_t start[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    memcpy(state_, start, sizeof(state_));
    memset(buffer_, 0, sizeof(buffer_));
}

void Sha256::block(const uint8_t* chunk) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = (uint32_t)chunk[i * 4] << 24 | (uint32_t)chunk[i * 4 + 1] << 16 |
               (uint32_t)chunk[i * 4 + 2] << 8 | (uint32_t)chunk[i * 4 + 3];
    }
    for (int i = 16; i < 64; i++) {
        const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3];
    uint32_t e = state_[4], f = state_[5], g = state_[6], h = state_[7];
    for (int i = 0; i < 64; i++) {
        const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const uint32_t choose = (e & f) ^ (~e & g);
        const uint32_t t1 = h + s1 + choose + kRound[i] + w[i];
        const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
        const uint32_t t2 = s0 + majority;
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }
    state_[0] += a; state_[1] += b; state_[2] += c; state_[3] += d;
    state_[4] += e; state_[5] += f; state_[6] += g; state_[7] += h;
}

void Sha256::update(const uint8_t* data, size_t length) {
    total_ += length;
    while (length > 0) {
        size_t room = 64 - buffered_;
        const size_t take = length < room ? length : room;
        memcpy(buffer_ + buffered_, data, take);
        buffered_ += take;
        data += take;
        length -= take;
        if (buffered_ == 64) {
            block(buffer_);
            buffered_ = 0;
        }
    }
}

void Sha256::finish(uint8_t out[32]) {
    const uint64_t bits = total_ * 8;
    // One 1 bit, zeros up to 56 bytes into a block, then the length in bits.
    const uint8_t one = 0x80, zero = 0;
    update(&one, 1);
    while (buffered_ != 56) update(&zero, 1);
    uint8_t length[8];
    for (int i = 0; i < 8; i++) length[i] = (uint8_t)(bits >> (56 - 8 * i));
    update(length, 8);
    for (int i = 0; i < 8; i++) {
        out[i * 4] = (uint8_t)(state_[i] >> 24);
        out[i * 4 + 1] = (uint8_t)(state_[i] >> 16);
        out[i * 4 + 2] = (uint8_t)(state_[i] >> 8);
        out[i * 4 + 3] = (uint8_t)state_[i];
    }
}

void hmacSha256(const uint8_t* key, size_t keyLength, const uint8_t* message, size_t messageLength, uint8_t out[32]) {
    uint8_t padded[64] = {0};
    if (keyLength > 64) {
        Sha256 shortened;
        shortened.update(key, keyLength);
        shortened.finish(padded);    // 32 bytes, the rest stays zero
    } else if (keyLength > 0) {
        memcpy(padded, key, keyLength);
    }
    uint8_t inner[64], outer[64];
    for (int i = 0; i < 64; i++) {
        inner[i] = padded[i] ^ 0x36;
        outer[i] = padded[i] ^ 0x5c;
    }
    uint8_t innerHash[32];
    Sha256 first;
    first.update(inner, 64);
    if (messageLength > 0) first.update(message, messageLength);
    first.finish(innerHash);
    Sha256 second;
    second.update(outer, 64);
    second.update(innerHash, 32);
    second.finish(out);
}

std::string toHex(const uint8_t* bytes, size_t count) {
    static const char digits[] = "0123456789abcdef";
    std::string text;
    text.reserve(count * 2);
    for (size_t i = 0; i < count; i++) {
        text += digits[bytes[i] >> 4];
        text += digits[bytes[i] & 15];
    }
    return text;
}

namespace {

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

}  // namespace

bool fromHex(const std::string& text, uint8_t* out, size_t count) {
    if (text.size() != count * 2) return false;
    for (size_t i = 0; i < count; i++) {
        const int high = hexValue(text[i * 2]), low = hexValue(text[i * 2 + 1]);
        if (high < 0 || low < 0) return false;
        out[i] = (uint8_t)(high << 4 | low);
    }
    return true;
}

bool sameBytes(const uint8_t* a, const uint8_t* b, size_t count) {
    uint8_t difference = 0;
    for (size_t i = 0; i < count; i++) difference |= a[i] ^ b[i];
    return difference == 0;
}

}  // namespace deskhog
