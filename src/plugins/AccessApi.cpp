#include "plugins/AccessApi.h"

#include <ESPAsyncWebServer.h>
#include <WiFi.h>

#include "DeskManners.h"
#include "DeviceAccess.h"
#include "Sha256.h"
#include "plugins/ApiHelpers.h"
#include "plugins/PluginManager.h"

namespace {

// Set once, before the web server starts. The manager is for the login calls.
DeviceAccess* gAccess = nullptr;
PluginManager* gManager = nullptr;

std::string headerValue(AsyncWebServerRequest* request, const char* name) {
    const AsyncWebHeader* header = request->getHeader(name);
    return header ? std::string(header->value().c_str()) : std::string();
}

// Plugins reach the API through the device's own address.
bool fromDevice(AsyncWebServerRequest* request) {
    const IPAddress from = request->client()->remoteIP();
    return from[0] == 127 || from == WiFi.localIP() || from == WiFi.softAPIP();
}

// What follows "Bearer " in the Authorization header; the word in any case.
std::string bearerOf(AsyncWebServerRequest* request) {
    const std::string value = headerValue(request, "Authorization");
    static const char kPrefix[] = "bearer ";
    const size_t length = sizeof(kPrefix) - 1;
    if (value.size() <= length || strncasecmp(value.c_str(), kPrefix, length) != 0) return std::string();
    return value.substr(length);
}

void answerVerdict(AsyncWebServerRequest* request, const deskhog::AccessVerdict& verdict) {
    DynamicJsonDocument doc(256);
    doc["ok"] = false;
    if (verdict.status == 401) doc["locked"] = true;
    doc["error"] = verdict.error;  // a string literal, so ArduinoJson may keep the pointer
    sendJson(request, verdict.status, doc);
}

// What a handler decided under the lock, answered after it is let go.
struct Answer {
    int status = 200;
    const char* error = "";  ///< A string literal
};

Answer fail(int status, const char* error) {
    Answer answer;
    answer.status = status;
    answer.error = error;
    return answer;
}

/** Answers a failure the way the check in front of the routes does, so a 401 looks the same from both. */
void sendFailure(AsyncWebServerRequest* request, const Answer& answer) {
    deskhog::AccessVerdict verdict;
    verdict.status = answer.status;
    verdict.error = answer.error;
    answerVerdict(request, verdict);
}

const char kNotThePassword[] = "That is not the password.";
const char kTooLong[] = "That took too long. Try again.";
const char kTooMany[] = "Too many wrong tries. Wait a minute.";
const char kNoPassword[] = "This DeskHog has no password.";

const char kBadNonce[] = "nonce is the 32 hex digits GET /api/login gave";
const char kBadProof[] = "proof is 64 hex digits";
const char kBadSalt[] = "salt is 32 hex digits";
const char kBadRounds[] = "rounds is a whole number from 1 to 10000000";
const char kBadVerifier[] = "verifier is 64 hex digits";

/** True when `value` is a string of hex digits for `bytes` bytes; the text goes in `out`. */
bool hexField(JsonVariantConst value, size_t bytes, std::string& out) {
    if (!value.is<const char*>()) return false;
    out = value.as<const char*>();
    uint8_t scratch[32];
    return bytes <= sizeof(scratch) && deskhog::fromHex(out, scratch, bytes);
}

/** The nonce and the proof of a body, or the 400 that says which is missing or malformed. */
bool readProof(JsonVariantConst body, std::string& nonce, std::string& proof, Answer& answer) {
    if (!hexField(body["nonce"], 16, nonce)) {
        answer = fail(400, kBadNonce);
        return false;
    }
    if (!hexField(body["proof"], 32, proof)) {
        answer = fail(400, kBadProof);
        return false;
    }
    return true;
}

/** Salt, rounds and verifier of a body, or the 400 that says which is bad. */
bool readPassword(JsonVariantConst body, std::string& salt, int& rounds, std::string& verifier, Answer& answer) {
    if (!hexField(body["salt"], 16, salt)) {
        answer = fail(400, kBadSalt);
        return false;
    }
    if (!body["rounds"].is<int>() || body["rounds"].as<int>() < 1 ||
        body["rounds"].as<int>() > deskhog::AccessTable::kMaxRounds) {
        answer = fail(400, kBadRounds);
        return false;
    }
    rounds = body["rounds"].as<int>();
    if (!hexField(body["verifier"], 32, verifier)) {
        answer = fail(400, kBadVerifier);
        return false;
    }
    return true;
}

/**
 * Every use of a proof (logging in, changing and removing the password) goes
 * through here, in this order: while logins are refused nothing is looked at;
 * then the nonce is used up, so it works once whether the proof is right or
 * not; then the proof counts as a wrong try or clears them. True: the proof is
 * right. Call under the lock, with a password set.
 */
bool useProof(deskhog::AccessTable& table, deskhog::LoginGuard& guard, const std::string& nonce,
              const std::string& proof, Answer& answer) {
    const uint32_t now = millis();
    if (guard.waiting(now)) {
        answer = fail(429, kTooMany);
        return false;
    }
    if (!guard.take(nonce, now)) {
        answer = fail(403, kTooLong);
        return false;
    }
    if (!table.checkProof(nonce, proof)) {
        guard.wrong(now);
        answer = fail(403, kNotThePassword);
        return false;
    }
    guard.right();
    return true;
}

bool isMethod(AsyncWebServerRequest* request, WebRequestMethodComposite methods) {
    return methods & request->method();
}

// GET: what a client needs to log in, and a fresh nonce. POST: a proof for a login key.
void handleLogin(AsyncWebServerRequest* request) {
    if (!isMethod(request, HTTP_GET | HTTP_POST)) return sendError(request, 405, "GET or POST /api/login");

    if (request->method() == HTTP_GET) {
        // Every call hands out a nonce, with a password or without, so the
        // answer does not change shape with the state of the device.
        const String nonce = DeviceAccess::randomHex(16);
        bool locked = false;
        String salt;
        int rounds = 0;
        gAccess->with([&](deskhog::AccessTable& table, deskhog::LoginGuard& guard) {
            guard.issue(nonce.c_str(), millis());
            locked = table.hasPassword();
            salt = table.salt().c_str();
            rounds = table.rounds();
            return false;
        });
        DeskManners* manners = gManager ? gManager->deskManners() : nullptr;
        DynamicJsonDocument doc(512);
        doc["locked"] = locked;
        doc["name"] = manners ? String(manners->settings().name.c_str()) : String();
        doc["id"] = DeviceAccess::deviceId();
        doc["salt"] = salt;
        doc["rounds"] = rounds;
        doc["nonce"] = nonce;
        return sendJson(request, 200, doc);
    }

    DynamicJsonDocument doc(512);
    if (!readJson(request, doc)) return;
    const String key = DeviceAccess::randomHex(16);
    Answer answer;
    gAccess->with([&](deskhog::AccessTable& table, deskhog::LoginGuard& guard) {
        if (!table.hasPassword()) {
            answer = fail(409, kNoPassword);
            return false;
        }
        std::string nonce, proof;
        if (!readProof(doc.as<JsonVariantConst>(), nonce, proof, answer)) return false;
        if (!useProof(table, guard, nonce, proof, answer)) return false;
        table.addLogin(key.c_str());
        return true;
    });
    if (answer.status != 200) return sendFailure(request, answer);
    sendOk(request, "key", key);
}

// Setting the first password, changing it with a proof of the old one, or removing it.
void handlePassword(AsyncWebServerRequest* request) {
    if (!isMethod(request, HTTP_POST)) return sendError(request, 405, "POST /api/password");
    DynamicJsonDocument doc(512);
    if (!readJson(request, doc)) return;
    const JsonVariantConst body = doc.as<JsonVariantConst>();
    if (!body.is<JsonObjectConst>()) return sendError(request, 400, "send a JSON object");

    // Taken before the lock: the key this request came with is kept on a change.
    const deskhog::AccessVerdict verdict = verdictFor(request);
    const String key = DeviceAccess::randomHex(16);
    bool first = false;
    Answer answer;
    gAccess->with([&](deskhog::AccessTable& table, deskhog::LoginGuard& guard) {
        std::string salt, verifier;
        int rounds = 0;
        if (!table.hasPassword()) {
            if (!body["remove"].isNull() || !body["nonce"].isNull() || !body["proof"].isNull()) {
                answer = fail(409, kNoPassword);
                return false;
            }
            if (!readPassword(body, salt, rounds, verifier, answer)) return false;
            if (!table.setPassword(salt, rounds, verifier)) {
                answer = fail(400, kBadVerifier);
                return false;
            }
            table.addLogin(key.c_str());
            first = true;
            return true;
        }

        // A password was set after the check in front of the routes let this
        // request through without a key: it gets the answer the check gives now.
        if (!verdict.hasKey || verdict.key.kind != deskhog::KeyKind::Login) {
            answer = fail(401, "This DeskHog has a password. Log in first.");
            return false;
        }
        std::string nonce, proof;
        if (!readProof(body, nonce, proof, answer)) return false;
        const bool remove = !body["remove"].isNull();
        if (remove && !(body["remove"].is<bool>() && body["remove"].as<bool>())) {
            answer = fail(400, "remove is true, or left out");
            return false;
        }
        // Checked before the proof, so a malformed change does not use up the nonce.
        if (!remove && !readPassword(body, salt, rounds, verifier, answer)) return false;

        if (!useProof(table, guard, nonce, proof, answer)) return false;
        if (remove) {
            table.removePassword();
            return true;
        }
        std::string newVerifier;
        if (!table.unmask(nonce, verifier, newVerifier) || !table.setPassword(salt, rounds, newVerifier)) {
            answer = fail(400, kBadVerifier);
            return false;
        }
        table.removeLoginsExcept(verdict.key.key);
        return true;
    });
    if (answer.status != 200) return sendFailure(request, answer);
    if (first) return sendOk(request, "key", key);
    sendOk(request);
}

// The message keys, and how many login keys there are. Reached only with a
// login key, or on a device without a password (which has no keys).
void handleKeys(AsyncWebServerRequest* request) {
    const WebRequestMethodComposite method = request->method();
    if (!isMethod(request, HTTP_GET | HTTP_POST | HTTP_DELETE)) {
        return sendError(request, 405, "GET, POST or DELETE /api/keys");
    }

    if (method == HTTP_GET) {
        size_t logins = 0;
        std::vector<deskhog::AccessKey> messages;
        gAccess->with([&](deskhog::AccessTable& table, deskhog::LoginGuard&) {
            logins = table.logins();
            messages = table.messageKeys();
            return false;
        });
        DynamicJsonDocument doc(2048);
        doc["logins"] = logins;
        JsonArray list = doc.createNestedArray("messages");
        for (const deskhog::AccessKey& each : messages) {
            JsonObject item = list.createNestedObject();
            item["id"] = each.id;
            item["name"] = String(each.name.c_str());
            item["key"] = String(each.key.c_str());
        }
        return sendJson(request, 200, doc);
    }

    if (method == HTTP_DELETE) {
        const AsyncWebParameter* param = request->getParam("id");
        const String text = param ? param->value() : String();
        char* end = nullptr;
        const long id = strtol(text.c_str(), &end, 10);
        if (text.isEmpty() || *end != '\0' || id < 1) {
            return sendError(request, 400, "id is the number of a message key");
        }
        bool removed = false;
        gAccess->with([&](deskhog::AccessTable& table, deskhog::LoginGuard&) {
            removed = table.removeMessageKey(static_cast<int>(id));
            return removed;
        });
        if (!removed) return sendError(request, 404, "no such key");
        return sendOk(request);
    }

    DynamicJsonDocument doc(512);
    if (!readJson(request, doc)) return;
    const JsonVariantConst name = doc["name"];
    const String key = DeviceAccess::randomHex(16);
    deskhog::AccessKey added;
    Answer answer;
    gAccess->with([&](deskhog::AccessTable& table, deskhog::LoginGuard&) {
        if (!table.hasPassword()) {
            answer = fail(409, "Set a password first.");
            return false;
        }
        if (table.messageKeys().size() >= deskhog::AccessTable::kMaxMessageKeys) {
            answer = fail(409, "There are 8 message keys. Remove one first.");
            return false;
        }
        // The table refuses a bad name too; the 8 are counted above, and a
        // new random key that is already taken does not happen.
        if (!name.is<const char*>() || !table.addMessageKey(key.c_str(), name.as<const char*>(), added)) {
            answer = fail(400, "name is 1 to 24 bytes, without control characters");
            return false;
        }
        return true;
    });
    if (answer.status != 200) return sendFailure(request, answer);
    DynamicJsonDocument reply(256);
    reply["ok"] = true;
    reply["id"] = added.id;
    reply["name"] = String(added.name.c_str());
    reply["key"] = key;
    sendJson(request, 200, reply);
}

// Removes the key the request came with, or with ?others=1 every other login
// key. On a device without a password there is no key, and nothing to do.
void handleLogout(AsyncWebServerRequest* request) {
    if (!isMethod(request, HTTP_POST)) return sendError(request, 405, "POST /api/logout");
    const deskhog::AccessVerdict verdict = verdictFor(request);
    if (!verdict.hasKey) return sendOk(request);
    const AsyncWebParameter* others = request->getParam("others");
    const bool keepThisOne = others && others->value() != "0";
    gAccess->with([&](deskhog::AccessTable& table, deskhog::LoginGuard&) {
        if (!keepThisOne) return table.removeKey(verdict.key.key);
        const size_t before = table.logins();
        table.removeLoginsExcept(verdict.key.key);
        return table.logins() != before;
    });
    sendOk(request);
}

}  // namespace

bool deviceHasPassword() { return gAccess && gAccess->hasPassword(); }

deskhog::AccessVerdict verdictFor(AsyncWebServerRequest* request) {
    if (!gAccess) {
        deskhog::AccessVerdict verdict;
        verdict.status = 503;
        verdict.error = "The device is still starting.";
        return verdict;
    }
    deskhog::AccessRequest r;
    // The router matches routes on url(): the decoded path without the query.
    // The method as it came, so HEAD and PATCH count as reads, not as POST.
    r.method = request->methodToString();
    r.path = request->url().c_str();
    r.origin = headerValue(request, "Origin");
    r.host = request->host().c_str();
    r.bearer = bearerOf(request);
    // The key in the address is a query parameter only, never a form field in the body.
    const AsyncWebParameter* auth = request->getParam("auth");
    if (auth) r.addressKey = auth->value().c_str();
    r.fromDevice = fromDevice(request);
    return gAccess->decide(r);
}

bool refusedEarly(AsyncWebServerRequest* request) { return verdictFor(request).status != 0; }

void registerAccessRoutes(AsyncWebServer& server, DeviceAccess& access, PluginManager& manager) {
    gAccess = &access;
    gManager = &manager;

    // Runs once the whole request is in, before whichever handler matched,
    // the not-found handler included. A refused request never reaches it.
    server.addMiddleware([](AsyncWebServerRequest* request, ArMiddlewareNext next) {
        const deskhog::AccessVerdict verdict = verdictFor(request);
        if (verdict.status != 0) return answerVerdict(request, verdict);
        next();
    });

    // Registered like the other routes, so their bodies are collected (and
    // refused early) the same way. Each handler checks the method itself.
    server.on("/api/login", HTTP_ANY, handleLogin, nullptr, collectBody);
    server.on("/api/password", HTTP_ANY, handlePassword, nullptr, collectBody);
    server.on("/api/keys", HTTP_ANY, handleKeys, nullptr, collectBody);
    server.on("/api/logout", HTTP_ANY, handleLogout, nullptr, collectBody);
}
