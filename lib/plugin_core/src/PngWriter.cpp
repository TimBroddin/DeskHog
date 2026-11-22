#include "PngWriter.h"

namespace deskhog {

namespace {

uint32_t crc32(const uint8_t* data, size_t length, uint32_t crc = 0) {
    static uint32_t table[256];
    static bool ready = false;
    if (!ready) {
        for (uint32_t n = 0; n < 256; n++) {
            uint32_t c = n;
            for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[n] = c;
        }
        ready = true;
    }
    crc = ~crc;
    for (size_t i = 0; i < length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
    return ~crc;
}

void putBig32(std::string& out, uint32_t value) {
    out += static_cast<char>(value >> 24);
    out += static_cast<char>(value >> 16);
    out += static_cast<char>(value >> 8);
    out += static_cast<char>(value);
}

void chunk(std::string& out, const char* type, const std::string& data) {
    putBig32(out, static_cast<uint32_t>(data.size()));
    const size_t start = out.size();
    out.append(type, 4);
    out += data;
    putBig32(out, crc32(reinterpret_cast<const uint8_t*>(out.data() + start), out.size() - start));
}

// Bits for deflate, lowest bit first.
class BitWriter {
public:
    explicit BitWriter(std::string& out) : out_(out) {}
    void bits(uint32_t value, int count) {
        buffer_ |= value << used_;
        used_ += count;
        while (used_ >= 8) {
            out_ += static_cast<char>(buffer_ & 0xFF);
            buffer_ >>= 8;
            used_ -= 8;
        }
    }
    /** A Huffman code, which deflate writes highest bit first. */
    void code(uint32_t value, int count) {
        uint32_t reversed = 0;
        for (int i = 0; i < count; i++) reversed |= ((value >> i) & 1) << (count - 1 - i);
        bits(reversed, count);
    }
    void flush() {
        if (used_ > 0) out_ += static_cast<char>(buffer_ & 0xFF);
        buffer_ = 0;
        used_ = 0;
    }

private:
    std::string& out_;
    uint32_t buffer_ = 0;
    int used_ = 0;
};

// The fixed Huffman code of a literal or length symbol (RFC 1951, 3.2.6).
void symbol(BitWriter& writer, int value) {
    if (value < 144) return writer.code(0x30 + value, 8);
    if (value < 256) return writer.code(0x190 + value - 144, 9);
    if (value < 280) return writer.code(value - 256, 7);
    writer.code(0xC0 + value - 280, 8);
}

// A run of `length` (3 to 258) copies of the byte before it: a match at distance 1.
void run(BitWriter& writer, int length) {
    static const uint16_t kBase[] = {3,  4,  5,  6,  7,  8,  9,  10, 11,  13,  15,  17,  19,  23, 27,
                                     31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258};
    static const uint8_t kExtra[] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
    int code = 28;
    while (kBase[code] > length) code--;
    symbol(writer, 257 + code);
    if (kExtra[code]) writer.bits(length - kBase[code], kExtra[code]);
    writer.code(0, 5);  // distance code 0: distance 1
}

}  // namespace

std::string rgb565ToPng(const uint8_t* pixels, int width, int height) {
    // The image data: each row is a filter byte and the row's RGB. Filter 1
    // ("sub") stores each byte as the difference to the pixel on its left, so
    // the plain areas of a card become runs of zeros.
    const size_t rowBytes = 1 + static_cast<size_t>(width) * 3;
    std::string raw;
    raw.reserve(rowBytes * height);
    for (int y = 0; y < height; y++) {
        raw += '\1';
        uint8_t left[3] = {0, 0, 0};
        for (int x = 0; x < width; x++) {
            const size_t at = (static_cast<size_t>(y) * width + x) * 2;
            const uint16_t pixel = static_cast<uint16_t>(pixels[at] | (pixels[at + 1] << 8));
            const uint8_t rgb[3] = {static_cast<uint8_t>(((pixel >> 11) & 0x1F) * 255 / 31),
                                    static_cast<uint8_t>(((pixel >> 5) & 0x3F) * 255 / 63),
                                    static_cast<uint8_t>((pixel & 0x1F) * 255 / 31)};
            for (int c = 0; c < 3; c++) {
                raw += static_cast<char>(static_cast<uint8_t>(rgb[c] - left[c]));
                left[c] = rgb[c];
            }
        }
    }

    // zlib: a header, one deflate block with the fixed codes, Adler-32 of the data.
    // Only runs of one byte are looked for, which is what the filter leaves.
    std::string zlib;
    zlib += static_cast<char>(0x78);
    zlib += static_cast<char>(0x01);
    {
        BitWriter writer(zlib);
        writer.bits(1, 1);  // the last block
        writer.bits(1, 2);  // fixed Huffman codes
        const size_t size = raw.size();
        size_t i = 0;
        while (i < size) {
            size_t length = 0;
            if (i > 0) {
                while (length < 258 && i + length < size && raw[i + length] == raw[i - 1]) length++;
            }
            if (length >= 3) {
                run(writer, static_cast<int>(length));
                i += length;
            } else {
                symbol(writer, static_cast<uint8_t>(raw[i]));
                i++;
            }
        }
        symbol(writer, 256);  // end of block
        writer.flush();
    }
    uint32_t a = 1, b = 0;
    for (unsigned char c : raw) {
        a = (a + c) % 65521;
        b = (b + a) % 65521;
    }
    putBig32(zlib, (b << 16) | a);
    raw = std::string();

    std::string png("\x89PNG\r\n\x1a\n", 8);
    std::string header;
    putBig32(header, static_cast<uint32_t>(width));
    putBig32(header, static_cast<uint32_t>(height));
    header += static_cast<char>(8);  // bits per channel
    header += static_cast<char>(2);  // RGB
    header.append(3, '\0');          // deflate, adaptive filtering, no interlace
    chunk(png, "IHDR", header);
    png.reserve(png.size() + zlib.size() + 24);
    chunk(png, "IDAT", zlib);
    chunk(png, "IEND", std::string());
    return png;
}

std::string base64Encode(const uint8_t* data, size_t length) {
    static const char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((length + 2) / 3 * 4);
    size_t i = 0;
    for (; i + 2 < length; i += 3) {
        const uint32_t n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        out += kAlphabet[n >> 18];
        out += kAlphabet[(n >> 12) & 63];
        out += kAlphabet[(n >> 6) & 63];
        out += kAlphabet[n & 63];
    }
    if (i < length) {
        const uint32_t n = (data[i] << 16) | (i + 1 < length ? data[i + 1] << 8 : 0);
        out += kAlphabet[n >> 18];
        out += kAlphabet[(n >> 12) & 63];
        out += i + 1 < length ? kAlphabet[(n >> 6) & 63] : '=';
        out += '=';
    }
    return out;
}

}  // namespace deskhog
