#pragma once

// A card's pixels as a PNG file, and bytes as base64: what an MCP client
// takes a picture as. The compression is simple, for the device's sake: each
// row is filtered so plain areas become runs of zeros, and deflate stores
// those runs with its fixed codes. A card is mostly plain, so a picture is a
// few KB instead of the 94 KB of its pixels.
//
// No Arduino in here, so the tests cover it.

#include <stddef.h>
#include <stdint.h>

#include <string>

namespace deskhog {

/** RGB565 pixels, two bytes each, low byte first (as cards hold them), as a PNG of 8-bit RGB. */
std::string rgb565ToPng(const uint8_t* pixels, int width, int height);

std::string base64Encode(const uint8_t* data, size_t length);

}  // namespace deskhog
