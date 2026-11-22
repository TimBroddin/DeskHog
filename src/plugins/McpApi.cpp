#include "plugins/McpApi.h"

#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <miniz.h>  // the inflater in the chip's ROM

#include <atomic>
#include <functional>
#include <memory>
#include <new>
#include <string>
#include <vector>

#include "PluginDirectory.h"
#include "PngWriter.h"
#include "Sha256.h"
#include "SourceHash.h"
#include "plugin_guide.h"
#include "plugins/ApiHelpers.h"
#include "plugins/PluginApi.h"
#include "plugins/PluginManager.h"

namespace {

const char* const kProtocolVersions[] = {"2025-06-18", "2025-03-26"};

const char kInstructions[] =
    "A DeskHog: a small desk display (233x135 pixels, three buttons) that runs Lua plugins. Each card on it "
    "shows a plugin; a connection is a plugin plus the settings its cards share. Start with list_cards. "
    "screenshot shows what a card looks like. To make a new card: directory and install_plugins, or "
    "plugin_guide and push_plugin for one you write; then add_card and configure.";

// ------------------------------------------------------------------ results

/** What a tool call answers: text, and maybe a picture. */
struct Result {
    std::vector<std::string> texts;
    std::string png;  ///< base64
    bool error = false;

    void text(std::string value) { texts.push_back(std::move(value)); }
    void fail(std::string value) {
        error = true;
        texts.push_back(std::move(value));
    }
};

/**
 * Work that finishes later: called each time the web server asks for the
 * answer (twice a second), until it returns true with `result` filled.
 */
using Later = std::function<bool(Result& result)>;

struct Call {
    JsonObjectConst args;
    PluginManager& manager;
    Result& result;
    Later& later;
    uint32_t& waitMs;  ///< How long `later` may take before the call fails
};

std::string toJson(const JsonDocument& doc) {
    std::string out;
    out.reserve(measureJson(doc) + 1);
    serializeJson(doc, out);
    return out;
}

const char kNoMemory[] = "The DeskHog is short of memory for that right now. Try again in a moment.";

/**
 * The JSON-RPC answer to a tools/call, as one string of the right size: a
 * screenshot is the largest thing the device holds at once here. The texts
 * are not copied into the document: it points at them.
 */
std::string answerJson(const std::string& id, const Result& result) {
    DynamicJsonDocument doc(512 + 64 * result.texts.size());
    JsonArray content = doc.createNestedArray("content");
    if (!result.png.empty()) {
        JsonObject image = content.createNestedObject();
        image["type"] = "image";
        image["data"] = result.png.c_str();
        image["mimeType"] = "image/png";
    }
    for (const std::string& text : result.texts) {
        JsonObject item = content.createNestedObject();
        item["type"] = "text";
        item["text"] = text.c_str();
    }
    doc["isError"] = result.error;
    const std::string head = "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":";
    std::string out;
    out.reserve(head.size() + measureJson(doc) + 2);
    out += head;
    serializeJson(doc, out);
    out += '}';
    return out;
}

/** The same, for a call that ran out of memory: small enough to still fit. */
std::string noMemoryJson(const std::string& id) {
    Result result;
    result.fail(kNoMemory);
    return answerJson(id, result);
}

std::string arg(const Call& call, const char* key) {
    const char* value = call.args[key] | "";
    return value;
}

bool has(const Call& call, const char* key) { return !call.args[key].isNull(); }

/** A plugin's name from the arguments, or "" with the call failed. */
std::string pluginArg(Call& call, const char* key = "name") {
    const std::string name = arg(call, key);
    if (!deskhog::isValidPluginName(name)) {
        call.result.fail("\"" + name + "\" is not a plugin name: 1-32 characters of a-z, 0-9, - and _.");
        return std::string();
    }
    return name;
}

void fieldsJson(JsonArray target, const std::vector<deskhog::LuaPlugin::ConfigField>& fields) {
    for (const auto& field : fields) {
        JsonObject item = target.createNestedObject();
        item["key"] = field.key;
        item["label"] = field.label;
        item["type"] = field.type;
        item["default"] = field.defaultValue;
        if (field.secret) item["secret"] = true;
        if (!field.options.empty()) {
            JsonArray options = item.createNestedArray("options");
            for (const std::string& option : field.options) options.add(option);
        }
        if (!field.choices.empty()) item["choices"] = true;  // setting_choices lists them
    }
}

/**
 * A card's key: "<connection>:<card>" as list_cards gives it, or a plugin's or
 * a connection's name for its first card. "" with the call failed.
 */
std::string cardArg(Call& call, const char* key = "card") {
    const std::string given = arg(call, key);
    const std::vector<PluginConnectionRecord> connections = call.manager.connections();
    for (const CardConfig& config : call.manager.cardStack()) {
        if (!config.isPlugin()) continue;
        const std::string card = config.config.c_str();
        if (card == given) return card;
        if (given.find(':') != std::string::npos) continue;
        std::string connectionId, cardId;
        if (!PluginManager::splitKey(card, connectionId, cardId)) continue;
        if (connectionId == given) return card;
        for (const PluginConnectionRecord& record : connections) {
            if (record.id == connectionId && record.plugin == given) return card;
        }
    }
    call.result.fail("No card \"" + given + "\" on the DeskHog. list_cards names the cards.");
    return std::string();
}

bool hasMeta(const std::map<std::string, PluginMeta>& metas, const std::string& name) { return metas.count(name) > 0; }

// ------------------------------------------------------------- the device

void listCards(Call& call) {
    writeState(call.manager, [&call](const JsonDocument& doc) { call.result.text(toJson(doc)); });
}

void pluginStatus(Call& call) {
    const std::string name = pluginArg(call);
    if (name.empty()) return;
    if (!call.manager.exists(name.c_str())) return call.result.fail("No plugin \"" + name + "\" on the DeskHog.");
    DynamicJsonDocument doc(12288);
    writePluginStatus(doc, call.manager, name.c_str());
    call.result.text(toJson(doc));
}

void screenshot(Call& call) {
    const std::string key = cardArg(call);
    if (key.empty()) return;
    // The first copy asks for the card to be painted even while it is not on
    // the screen. The picture is taken a moment later.
    std::vector<uint8_t> pixels;
    int width = 0, height = 0;
    uint32_t frames = 0;
    if (!call.manager.copyCardPixels(key, pixels, width, height, frames)) {
        return call.result.fail("The card " + key + " is not on the DeskHog right now.");
    }
    PluginManager* manager = &call.manager;
    const uint32_t asked = millis();
    call.waitMs = 6000;
    call.later = [manager, key, asked](Result& result) {
        if (millis() - asked < 1200) return false;
        std::vector<uint8_t> pixels;
        int width = 0, height = 0;
        uint32_t frames = 0;
        if (!manager->copyCardPixels(key, pixels, width, height, frames) || pixels.empty()) {
            result.fail("The card " + key + " is not on the DeskHog right now.");
            return true;
        }
        const std::string png = deskhog::rgb565ToPng(pixels.data(), width, height);
        pixels = std::vector<uint8_t>();
        result.png = deskhog::base64Encode(reinterpret_cast<const uint8_t*>(png.data()), png.size());
        result.text(key + ", " + std::to_string(width) + "x" + std::to_string(height) + " pixels.");
        return true;
    };
}

void pressButton(Call& call) {
    const std::string key = cardArg(call);
    if (key.empty()) return;
    const std::string button = arg(call, "button");
    const int index = button == "down" ? 0 : button == "center" ? 1 : button == "up" ? 2 : -1;
    if (index < 0) return call.result.fail("button is up, center or down.");
    if (!call.manager.press(key, static_cast<uint8_t>(index))) {
        return call.result.fail("The card " + key + " is not on the DeskHog right now.");
    }
    call.result.text("Pressed " + button + " for " + key + ". Take a screenshot to see what it did.");
}

void showCard(Call& call) {
    const std::string key = cardArg(call);
    if (key.empty()) return;
    if (!call.manager.show(key)) return call.result.fail("The card " + key + " is not on the DeskHog right now.");
    call.result.text(key + " is on the screen now.");
}

void sendMessage(Call& call) {
    const std::string key = cardArg(call);
    if (key.empty()) return;
    std::string body;
    if (call.args["message"].is<const char*>()) {
        body = call.args["message"].as<const char*>();
    } else {
        serializeJson(call.args["message"], body);
    }
    if (body.size() > PluginManager::MAX_MESSAGE_BYTES) return call.result.fail("The message is larger than 4 KB.");
    std::string connectionId, cardId;
    PluginManager::splitKey(key, connectionId, cardId);
    String error;
    int status = call.manager.sendMessage(connectionId, cardId, body, error);
    if (status == 404) {
        // This kind of card takes no messages. The plugin itself may: its global message().
        String second;
        const int again = call.manager.sendMessage(connectionId, "", body, second);
        if (again != 404) {
            status = again;
            error = second;
        }
    }
    if (status != 200) return call.result.fail(error.c_str());
    call.result.text("Sent to " + key + ".");
}

void restart(Call& call) {
    restartSoon();
    call.result.text("The DeskHog restarts now. It answers again in about ten seconds.");
}

// ----------------------------------------------------------------- settings

/** A card's or a connection's settings as configure shows them, with what can be set. */
void showSettings(Call& call, const std::string& target) {
    const std::map<std::string, PluginMeta> metas = call.manager.metas();
    DynamicJsonDocument doc(12288);
    std::string connectionId, cardId;
    const bool isCard = PluginManager::splitKey(target, connectionId, cardId);
    if (!isCard) connectionId = target;
    PluginConnectionRecord record;
    if (!call.manager.connection(connectionId, record)) return call.result.fail("No connection \"" + connectionId + "\".");
    const auto meta = metas.find(record.plugin);

    if (isCard) {
        const PluginCardRecord* card = record.card(cardId);
        if (!card) return call.result.fail("No card \"" + target + "\".");
        doc["card"] = target;
        for (const CardConfig& config : call.manager.cardStack()) {
            if (config.config == target.c_str()) doc["name"] = config.name;
        }
        doc["plugin"] = record.plugin;
        doc["kind"] = card->kind;
        JsonObject values = doc.createNestedObject("settings");
        for (const auto& pair : card->settings) values[pair.first] = pair.second;
        doc["front"] = card->mayInterrupt;
        doc["rotate"] = card->rotate;
        if (meta != metas.end()) {
            for (const auto& kind : meta->second.kinds) {
                if (kind.key == card->kind) fieldsJson(doc.createNestedArray("fields"), kind.config);
            }
        }
        doc["connection"] = connectionId;
    } else {
        doc["connection"] = connectionId;
        doc["plugin"] = record.plugin;
        doc["name"] = record.name;
        JsonObject values = doc.createNestedObject("settings");
        JsonArray secrets = doc.createNestedArray("secretsSet");
        for (const auto& pair : record.settings) {
            bool secret = false;
            if (meta != metas.end()) {
                for (const auto& field : meta->second.config) secret = secret || (field.key == pair.first && field.secret);
            }
            if (!secret) {
                values[pair.first] = pair.second;
            } else if (!pair.second.empty()) {
                secrets.add(pair.first);
            }
        }
        if (meta != metas.end()) fieldsJson(doc.createNestedArray("fields"), meta->second.config);
        JsonArray cards = doc.createNestedArray("cards");
        for (const PluginCardRecord& card : record.cards) cards.add(connectionId + ":" + card.id);
    }
    call.result.text(toJson(doc));
}

void configure(Call& call) {
    std::string target = arg(call, "target");
    const PluginSettings settings = settingsFrom(call.args["settings"]);
    std::string name;
    const bool hasName = call.args["name"].is<const char*>();
    if (hasName) name = call.args["name"].as<const char*>();

    if (target.find(':') != std::string::npos) {
        const bool hasFront = call.args["front"].is<bool>(), hasRotate = call.args["rotate"].is<bool>();
        const bool front = call.args["front"] | true, rotate = call.args["rotate"] | true;
        if ((hasName || !settings.empty() || hasFront || hasRotate) &&
            !call.manager.updateCard(target, hasName ? &name : nullptr, settings, hasFront ? &front : nullptr,
                                     hasRotate ? &rotate : nullptr)) {
            return call.result.fail("No card \"" + target + "\". list_cards names the cards.");
        }
    } else {
        if (has(call, "front") || has(call, "rotate")) {
            return call.result.fail("front and rotate belong to a card: give the card (\"" + target + ":1\").");
        }
        if ((hasName || !settings.empty()) && !call.manager.updateConnection(target, hasName ? &name : nullptr, settings)) {
            return call.result.fail("No connection \"" + target + "\". A card \"weather:2\" belongs to the connection \"weather\".");
        }
    }
    showSettings(call, target);
}

/** The list a plugin offers for a setting with choices. The plugin may ask the network first. */
void settingChoices(Call& call) {
    std::string target = arg(call, "target");
    const std::string field = arg(call, "field");
    std::string kind = arg(call, "kind");
    std::string connectionId, cardId;
    if (PluginManager::splitKey(target, connectionId, cardId)) {
        PluginConnectionRecord record;
        if (call.manager.connection(connectionId, record) && record.card(cardId) && kind.empty() && !has(call, "kind")) {
            kind = record.card(cardId)->kind;  // a card's setting, unless asked for the connection's
        }
    } else {
        connectionId = target;
    }
    const PluginSettings form = settingsFrom(call.args["settings"]);
    PluginManager* manager = &call.manager;
    call.waitMs = 25000;
    call.later = [manager, connectionId, kind, field, form](Result& result) {
        std::vector<deskhog::Choice> choices;
        String error;
        const int status = manager->choices(connectionId, kind, field, form, choices, error);
        if (status == 202) return false;
        if (status != 200) {
            result.fail(error.c_str());
            return true;
        }
        DynamicJsonDocument doc(2048 + choices.size() * 96);
        JsonArray list = doc.to<JsonArray>();
        for (const deskhog::Choice& choice : choices) {
            JsonObject item = list.createNestedObject();
            item["value"] = choice.value.c_str();
            item["label"] = choice.label.c_str();
        }
        result.text(toJson(doc));
        return true;
    };
}

void deviceSettings(Call& call) {
    if (has(call, "settings")) {
        if (!call.args["settings"].is<JsonObjectConst>()) return call.result.fail("settings is an object.");
        // "screen.day": 80 is {"screen": {"day": 80}}, the way POST /api/device takes it.
        DynamicJsonDocument body(2048);
        for (JsonPairConst pair : call.args["settings"].as<JsonObjectConst>()) {
            const std::string key = pair.key().c_str();
            const size_t dot = key.find('.');
            if (dot == std::string::npos) {
                body[key] = pair.value();
            } else {
                const std::string prefix = key.substr(0, dot);
                JsonObject group = body[prefix].as<JsonObject>();
                if (group.isNull()) group = body.createNestedObject(prefix);
                group[key.substr(dot + 1)] = pair.value();
            }
        }
        std::string error;
        if (!changeDevice(body.as<JsonObjectConst>(), call.manager, error)) return call.result.fail(error);
    }
    DynamicJsonDocument doc(2048);
    writeDevice(doc.to<JsonObject>(), call.manager);
    call.result.text(toJson(doc));
}

void setTimezone(Call& call) {
    String error;
    if (!call.manager.setTimeZone(arg(call, "posix").c_str(), arg(call, "name").c_str(), error)) {
        return call.result.fail(error.c_str());
    }
    const std::string name = call.manager.timeZoneName();
    call.result.text("The time zone is " + call.manager.timeZone() + (name.empty() ? std::string() : " (" + name + ")") + ".");
}

// ------------------------------------------------------------ cards

void addCard(Call& call) {
    const std::string plugin = pluginArg(call, "plugin");
    if (plugin.empty()) return;
    const std::map<std::string, PluginMeta> metas = call.manager.metas();
    const auto meta = metas.find(plugin);
    if (meta == metas.end()) {
        return call.result.fail("No plugin \"" + plugin + "\" on the DeskHog. Install it first: install_plugins or push_plugin.");
    }
    if (!meta->second.error.empty()) return call.result.fail("The plugin does not load: " + meta->second.error);
    if (meta->second.kinds.empty()) return call.result.fail("The plugin has no kind of card.");

    const std::string wanted = arg(call, "kind");
    const deskhog::LuaPlugin::CardKind* kind = &meta->second.kinds.front();
    if (!wanted.empty()) {
        kind = nullptr;
        for (const auto& each : meta->second.kinds) {
            if (each.key == wanted) kind = &each;
        }
        if (!kind) {
            std::string kinds;
            for (const auto& each : meta->second.kinds) kinds += (kinds.empty() ? "" : ", ") + each.key;
            return call.result.fail("\"" + plugin + "\" has no kind of card \"" + wanted + "\". It has: " + kinds + ".");
        }
    }

    // As the web page asks: a plugin of one card keeps its settings on its connection,
    // one with kinds of card keeps them on each card, and its cards share a connection.
    std::string connection, connectionName;
    PluginSettings connectionSettings, cardSettings;
    if (!meta->second.multiCard) {
        connectionSettings = settingsFrom(call.args["settings"]);
    } else {
        cardSettings = settingsFrom(call.args["settings"]);
        if (has(call, "connection")) {
            connection = arg(call, "connection");
        } else {
            for (const PluginConnectionRecord& record : call.manager.connections()) {
                if (record.plugin == plugin && connection.empty()) connection = record.id;
            }
        }
        if (connection.empty()) {
            connectionName = arg(call, "connection_name");
            connectionSettings = settingsFrom(call.args["connection_settings"]);
        }
    }
    String error;
    const std::string key = call.manager.addCard(plugin, connection, connectionName, connectionSettings, kind->key,
                                                 arg(call, "name"), cardSettings, error, call.args["front"] | true,
                                                 call.args["rotate"] | true);
    if (key.empty()) return call.result.fail(error.c_str());
    call.result.text("Added the card " + key + ". It is on the DeskHog now; screenshot shows it.");
    showSettings(call, key);
}

void removeCard(Call& call) {
    const std::string key = cardArg(call);
    if (key.empty()) return;
    std::vector<std::string> keep;
    for (const CardConfig& config : call.manager.cardStack()) {
        if (config.config.c_str() != key) keep.push_back(std::string(config.type.c_str()) + "|" + config.config.c_str());
    }
    if (!call.manager.saveLayout(keep)) return call.result.fail("The DeskHog could not save the cards.");
    call.result.text("Removed the card " + key + ". Its plugin is still installed.");
}

// ------------------------------------------------------------ plugin files

void readPlugin(Call& call) {
    const std::string name = pluginArg(call);
    if (name.empty()) return;
    String source;
    if (!call.manager.exists(name.c_str()) || !call.manager.readSource(name.c_str(), source)) {
        return call.result.fail("No plugin \"" + name + "\" on the DeskHog.");
    }
    call.result.text(source.c_str());
}

void removePlugin(Call& call) {
    const std::string name = pluginArg(call);
    if (name.empty()) return;
    if (!call.manager.exists(name.c_str())) return call.result.fail("No plugin \"" + name + "\" on the DeskHog.");
    call.manager.remove(name.c_str());
    call.result.text("Removed " + name + ", with its connections and cards.");
}

void pushPlugin(Call& call) {
    const std::string name = pluginArg(call);
    if (name.empty()) return;
    if (!call.args["source"].is<const char*>()) return call.result.fail("source is the plugin's Lua source, as text.");
    const char* source = call.args["source"].as<const char*>();
    const size_t length = strlen(source);
    if (length > PluginManager::MAX_SOURCE_BYTES) return call.result.fail("The plugin is larger than 64 KB.");
    String error;
    if (!call.manager.writeSource(name.c_str(), reinterpret_cast<const uint8_t*>(source), length, error, true)) {
        return call.result.fail(error.c_str());
    }
    // The device restarts the plugin on its next round: report how that went.
    PluginManager* manager = &call.manager;
    const uint32_t saved = millis();
    call.waitMs = 8000;
    call.later = [manager, name, saved](Result& result) {
        const uint32_t waited = millis() - saved;
        if (waited < 1200) return false;
        DynamicJsonDocument doc(12288);
        writePluginStatus(doc, *manager, name.c_str());
        if (doc["state"] == "no card" && waited < 5000) return false;
        result.text("Saved " + name + ". " + toJson(doc));
        if (doc["state"] == "failed") result.error = true;
        return true;
    };
}

void pluginGuide(Call& call) {
    std::string guide(PLUGIN_GUIDE_SIZE, '\0');
    tinfl_decompressor* inflater = static_cast<tinfl_decompressor*>(malloc(sizeof(tinfl_decompressor)));
    if (!inflater) return call.result.fail("The DeskHog has no memory for that right now.");
    tinfl_init(inflater);
    size_t in = sizeof(PLUGIN_GUIDE_ZLIB), out = guide.size();
    uint8_t* start = reinterpret_cast<uint8_t*>(&guide[0]);
    const tinfl_status status = tinfl_decompress(inflater, PLUGIN_GUIDE_ZLIB, &in, start, start, &out,
                                                 TINFL_FLAG_PARSE_ZLIB_HEADER | TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
    free(inflater);
    if (status != TINFL_STATUS_DONE || out != PLUGIN_GUIDE_SIZE) return call.result.fail("The guide in the firmware is damaged.");
    call.result.text(guide);
}

// ---------------------------------------------------------- the directory
//
// The web page and tools/deskhog fetch plugins themselves and hand them to the
// device. An agent has only the device, so for these two the device fetches:
// on the network task, with the certificate checks plugins get.

/** Work handed to the network task, and what it found. */
struct Download {
    std::atomic<bool> done{false};
    Result result;
};

/** The directory's index, fetched on the network task. Null with `error` set. */
std::unique_ptr<DynamicJsonDocument> fetchIndex(PluginManager& manager, const std::string& address, std::string& body,
                                                std::string& error) {
    deskhog::HttpRequest request;
    request.url = address;
    request.timeoutMs = 20000;
    request.maxBytes = 256 * 1024;
    deskhog::HttpResponse response;
    manager.fetch(request, response);
    if (response.status != 200) {
        error = "Could not fetch " + address + " (" +
                (response.status ? "HTTP " + std::to_string(response.status) : response.error) + ").";
        return nullptr;
    }
    body.swap(response.body);
    // In place: the strings stay in `body`, the document holds only the structure.
    std::unique_ptr<DynamicJsonDocument> index(new DynamicJsonDocument(body.size() / 2 + 16384));
    if (deserializeJson(*index, &body[0], body.size()) || !(*index)["plugins"].is<JsonArray>()) {
        error = address + " is not a plugin directory: it has no list of plugins.";
        return nullptr;
    }
    return index;
}

/** The directory to use: the one asked for, else the one the device remembers. "" with the call failed. */
std::string indexArg(Call& call) {
    const std::string source = has(call, "source") ? arg(call, "source") : std::string(call.manager.directorySource().c_str());
    const std::string address = deskhog::directoryIndexAddress(source);
    if (address.empty()) call.result.fail("\"" + source + "\" is not a plugin directory. Give \"owner/repo\" or the address of an index.json.");
    return address;
}

/** Hands `work` to the network task, and the answer to `call.later`. */
void download(Call& call, std::function<void(Result&)> work) {
    auto job = std::make_shared<Download>();
    const bool queued = call.manager.runOnNetworkTask([job, work]() {
        try {
            work(job->result);
        } catch (const std::bad_alloc&) {
            job->result = Result();
            job->result.fail(kNoMemory);
        }
        job->done = true;
    });
    if (!queued) return call.result.fail("The DeskHog is busy with network requests. Try again in a moment.");
    call.waitMs = 90000;
    call.later = [job](Result& result) {
        if (!job->done) return false;
        result = job->result;
        return true;
    };
}

void directory(Call& call) {
    const std::string address = indexArg(call);
    if (address.empty()) return;
    PluginManager* manager = &call.manager;
    download(call, [manager, address](Result& result) {
        std::string body, error;
        std::unique_ptr<DynamicJsonDocument> index = fetchIndex(*manager, address, body, error);
        if (!index) return result.fail(error);
        const std::map<std::string, PluginMeta> metas = manager->metas();
        DynamicJsonDocument doc(body.size() + 8192);
        doc["directory"] = address;
        JsonArray list = doc.createNestedArray("plugins");
        for (JsonObjectConst entry : (*index)["plugins"].as<JsonArrayConst>()) {
            JsonObject item = list.createNestedObject();
            for (const char* key : {"name", "title", "description", "author", "version"}) {
                if (!entry[key].isNull()) item[key] = entry[key];
            }
            const auto installed = metas.find(entry["name"] | "");
            if (installed == metas.end()) {
                item["status"] = "not installed";
                continue;
            }
            char hash[9];
            snprintf(hash, sizeof(hash), "%08x", (unsigned)installed->second.hash);
            const std::string version = entry["version"] | "";
            if (entry["hash"] == hash) {
                item["status"] = "installed";
            } else if (installed->second.version != version) {
                item["status"] = "update: " + (installed->second.version.empty() ? std::string("?") : installed->second.version) +
                                 " -> " + (version.empty() ? std::string("?") : version);
            } else {
                item["status"] = "installed, but changed on the device";
            }
        }
        result.text(toJson(doc));
    });
}

void installPlugins(Call& call) {
    if (!call.args["names"].is<JsonArrayConst>() || call.args["names"].size() == 0) {
        return call.result.fail("names is a list of plugin names from the directory.");
    }
    std::vector<std::string> names;
    for (JsonVariantConst each : call.args["names"].as<JsonArrayConst>()) {
        const std::string name = each | "";
        if (!deskhog::isValidPluginName(name)) return call.result.fail("\"" + name + "\" is not a plugin name.");
        names.push_back(name);
    }
    const std::string address = indexArg(call);
    if (address.empty()) return;
    PluginManager* manager = &call.manager;
    download(call, [manager, address, names](Result& result) {
        std::string body, error;
        std::unique_ptr<DynamicJsonDocument> index = fetchIndex(*manager, address, body, error);
        if (!index) return result.fail(error);
        for (const std::string& name : names) {
            JsonObjectConst entry;
            for (JsonObjectConst each : (*index)["plugins"].as<JsonArrayConst>()) {
                if (name == (each["name"] | "")) entry = each;
            }
            if (entry.isNull()) {
                result.fail("The directory has no plugin \"" + name + "\". directory lists what it has.");
                continue;
            }
            const std::string file = deskhog::directoryFileAddress(address, entry["file"] | "");
            if (file.empty()) {
                result.fail(name + ": the directory gives no file for it that the DeskHog may fetch.");
                continue;
            }
            deskhog::HttpRequest request;
            request.url = file;
            request.timeoutMs = 20000;
            request.maxBytes = PluginManager::MAX_SOURCE_BYTES;
            deskhog::HttpResponse response;
            manager->fetch(request, response);
            if (response.status != 200) {
                result.fail(name + ": could not fetch " + file + " (" +
                            (response.status ? "HTTP " + std::to_string(response.status) : response.error) + ").");
                continue;
            }
            const std::string& source = response.body;
            // The file has to be the one the index describes.
            bool matches = true;
            if (entry["sha256"].is<const char*>()) {
                deskhog::Sha256 sha;
                sha.update(reinterpret_cast<const uint8_t*>(source.data()), source.size());
                uint8_t digest[32];
                sha.finish(digest);
                matches = deskhog::toHex(digest, sizeof(digest)) == (entry["sha256"] | "");
            } else if (entry["hash"].is<const char*>()) {
                char hash[9];
                snprintf(hash, sizeof(hash), "%08x", (unsigned)deskhog::sourceHash(source.data(), source.size()));
                matches = entry["hash"] == hash;
            }
            if (!matches) {
                result.fail(name + ": the file is not the one the directory describes. Try again in a few minutes; it may be in the middle of an update.");
                continue;
            }
            String saveError;
            // As from the web page: installing adds no card. add_card does, with the settings wanted.
            if (!manager->writeSource(name.c_str(), reinterpret_cast<const uint8_t*>(source.data()), source.size(), saveError,
                                      false)) {
                result.fail(name + ": " + saveError.c_str());
                continue;
            }
            const std::string version = entry["version"] | "";
            result.text("Installed " + std::string(entry["title"] | name.c_str()) + (version.empty() ? "" : " " + version) +
                        (manager->firstCardOf(name).empty() ? ". No card shows it yet: add_card adds one." : "."));
        }
    });
}

void setDirectory(Call& call) {
    String error;
    if (!call.manager.setDirectorySource(arg(call, "source").c_str(), error)) return call.result.fail(error.c_str());
    call.result.text("The DeskHog takes plugins from " + std::string(call.manager.directorySource().c_str()) + " now.");
}

// ------------------------------------------------------------------ tools

struct Tool {
    const char* name;
    void (*run)(Call& call);
};

const Tool kTools[] = {
    {"list_cards", listCards},       {"plugin_status", pluginStatus},   {"screenshot", screenshot},
    {"press_button", pressButton},   {"show_card", showCard},           {"send_message", sendMessage},
    {"configure", configure},        {"setting_choices", settingChoices}, {"add_card", addCard},
    {"remove_card", removeCard},     {"directory", directory},          {"install_plugins", installPlugins},
    {"set_directory", setDirectory}, {"plugin_guide", pluginGuide},     {"push_plugin", pushPlugin},
    {"read_plugin", readPlugin},     {"remove_plugin", removePlugin},   {"device_settings", deviceSettings},
    {"set_timezone", setTimezone},   {"restart", restart},
};

// What tools/list answers. Written out, so the device spends no memory building it.
const char kToolList[] = R"json({"tools":[
{"name":"list_cards","description":"Everything on the DeskHog: its plugins (with their settings and kinds of card), connections (a plugin plus settings its cards share, and whether it runs or failed), the cards in their order (key, name, which is on screen), the device's settings and time zone. Start here: the other tools take the card keys it gives.","inputSchema":{"type":"object","properties":{}},"annotations":{"readOnlyHint":true}},
{"name":"plugin_status","description":"How a plugin is running: its state, memory, the error it last stopped on, and the last lines it print()ed.","inputSchema":{"type":"object","properties":{"name":{"type":"string","description":"The plugin's name"}},"required":["name"]},"annotations":{"readOnlyHint":true}},
{"name":"screenshot","description":"What a card shows right now, as a picture of its 233x135 screen. Also for a card that is not on the screen.","inputSchema":{"type":"object","properties":{"card":{"type":"string","description":"A card key \"<connection>:<card>\", or a plugin's name for its first card"}},"required":["card"]},"annotations":{"readOnlyHint":true}},
{"name":"press_button","description":"Press one of the three buttons for a card, as if on the device. On the device up and down move between cards, so most plugins only use center.","inputSchema":{"type":"object","properties":{"card":{"type":"string"},"button":{"type":"string","enum":["up","center","down"]}},"required":["card","button"]}},
{"name":"show_card","description":"Bring a card to the front of the screen.","inputSchema":{"type":"object","properties":{"card":{"type":"string"}},"required":["card"]}},
{"name":"send_message","description":"Send a message to a card's plugin: its message() function gets it. Text or JSON, at most 4 KB. What it does with it is up to the plugin.","inputSchema":{"type":"object","properties":{"card":{"type":"string"},"message":{"type":["string","object","array"],"description":"Text, or a JSON value"}},"required":["card","message"]}},
{"name":"configure","description":"Show or change settings. A connection (\"weather\") holds what its cards share, such as an API key; a card (\"weather:2\") has its own, such as a city. Without changes it shows them, with the fields that can be set. front (may come to the front by itself) and rotate (auto-rotate visits it) are every card's own. Secrets are never shown, only whether they are set.","inputSchema":{"type":"object","properties":{"target":{"type":"string","description":"A connection id or a card key"},"name":{"type":"string"},"settings":{"type":"object","additionalProperties":{"type":["string","number","boolean"]}},"front":{"type":"boolean"},"rotate":{"type":"boolean"}},"required":["target"]}},
{"name":"setting_choices","description":"What a plugin offers to pick from for a setting marked choices (its devices, say). The plugin may ask the network first.","inputSchema":{"type":"object","properties":{"target":{"type":"string","description":"The connection, or a card for one of its card's settings"},"field":{"type":"string"},"kind":{"type":"string","description":"The kind of card the setting belongs to; \"\" for the connection's"},"settings":{"type":"object","description":"Settings not saved yet that the list depends on"}},"required":["target","field"]},"annotations":{"readOnlyHint":true}},
{"name":"add_card","description":"Add a card of an installed plugin at the end of the cards. list_cards names a plugin's kinds of card. Its answer shows the settings the card takes; change them with configure.","inputSchema":{"type":"object","properties":{"plugin":{"type":"string"},"kind":{"type":"string","description":"For a plugin with kinds of card. Default: the first"},"name":{"type":"string"},"settings":{"type":"object","description":"The card's settings (a one-card plugin: its connection's)"},"connection":{"type":"string","description":"For a plugin with kinds of card: the connection to share; \"\" for a new one. Default: its first"},"connection_name":{"type":"string"},"connection_settings":{"type":"object","description":"A new connection's settings, such as an API key"},"front":{"type":"boolean"},"rotate":{"type":"boolean"}},"required":["plugin"]}},
{"name":"remove_card","description":"Remove one card. Its plugin stays installed.","inputSchema":{"type":"object","properties":{"card":{"type":"string"}},"required":["card"]},"annotations":{"destructiveHint":true}},
{"name":"directory","description":"What the plugin directory offers (by default the one the device uses), and what of it is on the device: installed, an update, or changed on the device.","inputSchema":{"type":"object","properties":{"source":{"type":"string","description":"Another directory: \"owner/repo\" on GitHub or the address of an index.json"}}},"annotations":{"readOnlyHint":true}},
{"name":"install_plugins","description":"Install or update plugins from the plugin directory. The DeskHog checks each file against the directory's index. Installing adds no card: add_card does.","inputSchema":{"type":"object","properties":{"names":{"type":"array","items":{"type":"string"},"minItems":1},"source":{"type":"string","description":"Another directory, as for directory"}},"required":["names"]}},
{"name":"set_directory","description":"Change where the DeskHog's web page and tools look for plugins: \"owner/repo\" on GitHub or the address of an index.json; \"\" for the default.","inputSchema":{"type":"object","properties":{"source":{"type":"string"}},"required":["source"]}},
{"name":"plugin_guide","description":"How to write a DeskHog plugin: the Lua API for drawing, buttons, pages, HTTP, storage, timers and messages, with examples, for the plugin API this firmware has. Read it before push_plugin; read_plugin shows how existing plugins do it.","inputSchema":{"type":"object","properties":{}},"annotations":{"readOnlyHint":true}},
{"name":"push_plugin","description":"Install a plugin from its Lua source, or replace one, and say how it started (its error and print() output when it did not). A plugin no card shows yet gets a first card. At most about 60 KB of source.","inputSchema":{"type":"object","properties":{"name":{"type":"string","description":"1-32 characters of a-z, 0-9, - and _"},"source":{"type":"string"}},"required":["name","source"]}},
{"name":"read_plugin","description":"A plugin's Lua source, as it is on the device.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]},"annotations":{"readOnlyHint":true}},
{"name":"remove_plugin","description":"Remove a plugin, with its connections and every card that shows it.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]},"annotations":{"destructiveHint":true}},
{"name":"device_settings","description":"Show or change the DeskHog's own settings: name (it is then <name>.local), screen.day and screen.night (brightness 0-100), led.day and led.night, night.enabled, night.from and night.until (\"22:00\"), rotate.seconds (0 or 10-600: move to the next card by itself), battery. Also its memory headroom and firmware version.","inputSchema":{"type":"object","properties":{"settings":{"type":"object","description":"Keys as above, e.g. {\"screen.night\": 5, \"night.enabled\": true}"}}}},
{"name":"set_timezone","description":"Set the time zone plugins tell local time by, as a POSIX TZ string (\"CET-1CEST,M3.5.0,M10.5.0/3\" for Brussels); \"\" for UTC.","inputSchema":{"type":"object","properties":{"posix":{"type":"string"},"name":{"type":"string","description":"The place, to show with it, e.g. Europe/Brussels"}},"required":["posix"]}},
{"name":"restart","description":"Restart the DeskHog. It answers again after about ten seconds.","inputSchema":{"type":"object","properties":{}},"annotations":{"destructiveHint":true}}
]})json";

// --------------------------------------------------------------- protocol

std::string rpcAnswer(const std::string& id, const std::string& result) {
    return "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":" + result + "}";
}

std::string rpcError(const std::string& id, int code, const char* message) {
    DynamicJsonDocument doc(512);
    doc["jsonrpc"] = "2.0";
    doc["id"] = serialized(id);
    doc["error"]["code"] = code;
    doc["error"]["message"] = message;
    return toJson(doc);
}

/** Send `body`, which the response keeps until it is out. */
void sendBody(AsyncWebServerRequest* request, int code, std::shared_ptr<std::string> body) {
    AsyncWebServerResponse* response =
        request->beginResponse("application/json", body->size(), [body](uint8_t* buffer, size_t maxLen, size_t index) -> size_t {
            if (index >= body->size()) return 0;
            const size_t count = std::min(maxLen, body->size() - index);
            memcpy(buffer, body->data() + index, count);
            return count;
        });
    response->setCode(code);
    response->addHeader("Cache-Control", "no-store");
    request->send(response);
}

/** A tool call that waits: its request is paused until `later` has the answer. */
struct Waiting {
    std::string id;
    Result result;
    Later later;
    uint32_t sinceMs = 0;
    uint32_t waitMs = 0;
    AsyncWebServerRequestPtr request;
};

// The calls that wait, and the task that finishes them. The web server's task
// may not wait, and the UI and network tasks have their own work; so a small
// task of its own asks each call's `later` a few times a second and sends the
// answer when it is there. The web server allows a paused request to be sent
// from another task (its RequestContinuation example does that).
SemaphoreHandle_t gWaitingLock = nullptr;
std::vector<std::shared_ptr<Waiting>> gWaiting;
TaskHandle_t gWaitTask = nullptr;

void waitLoop(void*) {
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(200));
        std::vector<std::shared_ptr<Waiting>> calls;
        xSemaphoreTake(gWaitingLock, portMAX_DELAY);
        calls = gWaiting;
        xSemaphoreGive(gWaitingLock);

        for (const std::shared_ptr<Waiting>& call : calls) {
            bool finished = call->request.expired();  // the client went away
            if (!finished) {
                try {
                    finished = call->later(call->result);
                } catch (const std::bad_alloc&) {
                    call->result = Result();
                    call->result.fail(kNoMemory);
                    finished = true;
                }
                if (!finished && millis() - call->sinceMs >= call->waitMs) {
                    call->result.fail("That took the DeskHog too long.");
                    finished = true;
                }
                if (finished) {
                    std::shared_ptr<std::string> body;
                    try {
                        body = std::make_shared<std::string>(answerJson(call->id, call->result));
                    } catch (const std::bad_alloc&) {
                        call->result = Result();
                        body = std::make_shared<std::string>(noMemoryJson(call->id));
                    }
                    call->result = Result();
                    if (auto request = call->request.lock()) sendBody(request.get(), 200, body);
                }
            }
            if (!finished) continue;
            xSemaphoreTake(gWaitingLock, portMAX_DELAY);
            for (size_t i = 0; i < gWaiting.size(); i++) {
                if (gWaiting[i] == call) {
                    gWaiting.erase(gWaiting.begin() + i);
                    break;
                }
            }
            xSemaphoreGive(gWaitingLock);
        }
    }
}

void sendLater(AsyncWebServerRequest* request, std::shared_ptr<Waiting> waiting) {
    if (!gWaitTask) {
        gWaitingLock = xSemaphoreCreateMutex();
        // Started the first time it is needed, and kept: 6 KB of internal RAM.
        if (xTaskCreatePinnedToCore(waitLoop, "mcpWait", 6144, nullptr, 1, &gWaitTask, 0) != pdPASS) {
            gWaitTask = nullptr;
            return sendBody(request, 200, std::make_shared<std::string>(noMemoryJson(waiting->id)));
        }
    }
    waiting->request = request->pause();
    xSemaphoreTake(gWaitingLock, portMAX_DELAY);
    gWaiting.push_back(waiting);
    xSemaphoreGive(gWaitingLock);
}

void handleMcp(AsyncWebServerRequest* request, PluginManager& manager) {
    if (request->method() != HTTP_POST) {
        // No stream from the device (GET) and no sessions to end (DELETE).
        return sendError(request, 405, "POST JSON-RPC messages to /api/mcp");
    }
    const size_t length = request->contentLength();
    if (!request->_tempObject || length == 0) {
        return sendBody(request, 400, std::make_shared<std::string>(rpcError("null", -32700, "send a JSON-RPC message")));
    }
    // In place: the strings stay in the request's body, the document holds the structure.
    DynamicJsonDocument doc(length + 4096);
    const DeserializationError parsed = deserializeJson(doc, static_cast<char*>(request->_tempObject), length);
    if (parsed) {
        const char* why = parsed == DeserializationError::NoMemory ? "that message is too large for the DeskHog" : "that is not JSON";
        return sendBody(request, 400, std::make_shared<std::string>(rpcError("null", -32700, why)));
    }
    if (doc.is<JsonArray>()) {
        return sendBody(request, 400, std::make_shared<std::string>(rpcError("null", -32600, "one message at a time")));
    }
    // A notification, or an answer to something the device never asks: nothing to say back.
    if (!doc.containsKey("id") || !doc.containsKey("method")) {
        AsyncWebServerResponse* response = request->beginResponse(202);
        request->send(response);
        return;
    }
    std::string id;
    serializeJson(doc["id"], id);
    const std::string method = doc["method"] | "";
    const JsonObjectConst params = doc["params"].as<JsonObjectConst>();

    if (method == "initialize") {
        const char* asked = params["protocolVersion"] | "";
        const char* version = kProtocolVersions[0];
        for (const char* known : kProtocolVersions) {
            if (!strcmp(asked, known)) version = known;
        }
        DynamicJsonDocument answer(1024);
        answer["protocolVersion"] = version;
        answer["capabilities"].createNestedObject("tools");
        answer["serverInfo"]["name"] = "deskhog";
        answer["serverInfo"]["version"] = CURRENT_FIRMWARE_VERSION;
        answer["instructions"] = kInstructions;
        return sendBody(request, 200, std::make_shared<std::string>(rpcAnswer(id, toJson(answer))));
    }
    if (method == "ping") return sendBody(request, 200, std::make_shared<std::string>(rpcAnswer(id, "{}")));
    if (method == "tools/list") return sendBody(request, 200, std::make_shared<std::string>(rpcAnswer(id, kToolList)));
    if (method != "tools/call") {
        return sendBody(request, 200, std::make_shared<std::string>(rpcError(id, -32601, "the DeskHog has tools only")));
    }

    const std::string name = params["name"] | "";
    const Tool* tool = nullptr;
    for (const Tool& each : kTools) {
        if (name == each.name) tool = &each;
    }
    if (!tool) return sendBody(request, 200, std::make_shared<std::string>(rpcError(id, -32602, "no such tool")));

    auto waiting = std::make_shared<Waiting>();
    waiting->id = id;
    Call call{params["arguments"].as<JsonObjectConst>(), manager, waiting->result, waiting->later, waiting->waitMs};
    std::shared_ptr<std::string> body;
    try {
        tool->run(call);
        if (waiting->later && !waiting->result.error) {
            waiting->sinceMs = millis();
            return sendLater(request, waiting);
        }
        body = std::make_shared<std::string>(answerJson(id, waiting->result));
    } catch (const std::bad_alloc&) {
        waiting->result = Result();
        waiting->later = nullptr;
        body = std::make_shared<std::string>(noMemoryJson(id));
    }
    sendBody(request, 200, body);
}

/**
 * The route, as a handler of its own: the web server takes any request whose
 * Accept mentions text/event-stream for an EventSource and keeps it from the
 * usual routes, POST or not. MCP clients send "application/json,
 * text/event-stream" with every message.
 */
class McpHandler : public AsyncWebHandler {
public:
    explicit McpHandler(PluginManager& manager) : manager_(manager) {}

    bool canHandle(AsyncWebServerRequest* request) const override {
        const String& path = request->url();
        return path == "/api/mcp" || path.startsWith("/api/mcp/");
    }
    void handleRequest(AsyncWebServerRequest* request) override { handleMcp(request, manager_); }
    void handleBody(AsyncWebServerRequest* request, uint8_t* data, size_t len, size_t index, size_t total) override {
        collectBody(request, data, len, index, total);
    }
    bool isRequestHandlerTrivial() const override { return false; }

private:
    PluginManager& manager_;
};

}  // namespace

void registerMcpRoute(AsyncWebServer& server, PluginManager& manager) { server.addHandler(new McpHandler(manager)); }
