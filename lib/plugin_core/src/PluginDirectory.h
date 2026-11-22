#pragma once

// Where a plugin directory's files are, as the web page and tools/deskhog
// work it out (directoryAddress in html/portal.js, directory_address in the
// tool). The device uses it when an agent installs a plugin through MCP.
//
// No Arduino in here, so the tests cover it.

#include <string>

namespace deskhog {

/**
 * The address of a directory's index.json. `source` is "owner/repo" or
 * "owner/repo@branch" (plugins/index.json in that GitHub repository), or a
 * web address: of the index itself when it ends in .json, else of the folder
 * that holds it. "" when `source` is neither.
 */
std::string directoryIndexAddress(const std::string& source);

/**
 * The address of a file the index names, next to the index. "" for anything
 * but a plain file name or path below the index's folder: no other host, no
 * "..", no query.
 */
std::string directoryFileAddress(const std::string& index, const std::string& file);

}  // namespace deskhog
