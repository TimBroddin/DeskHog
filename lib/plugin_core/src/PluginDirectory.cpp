#include "PluginDirectory.h"

namespace deskhog {

namespace {

bool startsWith(const std::string& text, const char* prefix) { return text.compare(0, std::char_traits<char>::length(prefix), prefix) == 0; }

bool endsWith(const std::string& text, const char* suffix) {
    const size_t length = std::char_traits<char>::length(suffix);
    return text.size() >= length && text.compare(text.size() - length, length, suffix) == 0;
}

bool isNameChar(char c, bool slash) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '.' ||
           c == '-' || (slash && c == '/');
}

}  // namespace

std::string directoryIndexAddress(const std::string& source) {
    const size_t first = source.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return std::string();
    const std::string text = source.substr(first, source.find_last_not_of(" \t\r\n") - first + 1);

    if (startsWith(text, "http://") || startsWith(text, "https://")) {
        for (char c : text) {
            if (static_cast<unsigned char>(c) <= ' ' || c == '"' || c == '<' || c == '>' || c == 0x7F) return std::string();
        }
        if (endsWith(text, ".json")) return text;
        std::string folder = text;
        while (!folder.empty() && folder.back() == '/') folder.pop_back();
        return folder + "/index.json";
    }

    // owner/repo or owner/repo@ref
    const size_t slash = text.find('/');
    if (slash == std::string::npos || slash == 0) return std::string();
    const size_t at = text.find('@', slash);
    const std::string owner = text.substr(0, slash);
    const std::string repo = text.substr(slash + 1, at == std::string::npos ? std::string::npos : at - slash - 1);
    const std::string ref = at == std::string::npos ? "HEAD" : text.substr(at + 1);
    if (repo.empty() || ref.empty()) return std::string();
    for (char c : owner) if (!isNameChar(c, false)) return std::string();
    for (char c : repo) if (!isNameChar(c, false)) return std::string();
    for (char c : ref) if (!isNameChar(c, true)) return std::string();
    return "https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + ref + "/plugins/index.json";
}

std::string directoryFileAddress(const std::string& index, const std::string& file) {
    if (file.empty() || file.front() == '/' || file.size() > 200) return std::string();
    for (char c : file) {
        if (!isNameChar(c, true)) return std::string();  // no scheme (:), query, fragment or escapes
    }
    // No ".." among the parts, and no empty part.
    size_t start = 0;
    while (start <= file.size()) {
        const size_t end = file.find('/', start);
        const std::string part = file.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (part.empty() || part == "." || part == "..") return std::string();
        if (end == std::string::npos) break;
        start = end + 1;
    }
    const size_t folder = index.rfind('/');
    if (folder == std::string::npos || !(startsWith(index, "http://") || startsWith(index, "https://"))) return std::string();
    return index.substr(0, folder + 1) + file;
}

}  // namespace deskhog
