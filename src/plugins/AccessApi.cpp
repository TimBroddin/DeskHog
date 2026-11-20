#include "plugins/AccessApi.h"

#include <ESPAsyncWebServer.h>
#include <WiFi.h>

#include "DeviceAccess.h"
#include "plugins/ApiHelpers.h"

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

}  // namespace

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
}
