#include "plugins/ApiHelpers.h"

#include <ESPAsyncWebServer.h>

#include "plugins/AccessApi.h"
#include "plugins/PluginManager.h"

void sendJson(AsyncWebServerRequest* request, int code, const JsonDocument& doc) {
    String body;
    serializeJson(doc, body);
    AsyncWebServerResponse* response = request->beginResponse(code, "application/json", body);
    response->addHeader("Cache-Control", "no-store");
    request->send(response);
}

void sendError(AsyncWebServerRequest* request, int code, const String& message) {
    DynamicJsonDocument doc(512);
    doc["ok"] = false;
    doc["error"] = message;
    sendJson(request, code, doc);
}

void sendOk(AsyncWebServerRequest* request, const char* field, const String& value) {
    DynamicJsonDocument doc(256);
    doc["ok"] = true;
    if (field) doc[field] = value;
    sendJson(request, 200, doc);
}

// The body arrives in pieces; collect them in one block the request owns.
// The web server frees _tempObject when the request ends.
//
// The web server hands a route the body before the check in front of the
// routes runs. A request the check refuses is taken from the routes at its
// headers (EarlyHandler in AccessApi.cpp); one whose answer changed since is
// turned away here on the first piece. Its later pieces find no block and are
// dropped too.
void collectBody(AsyncWebServerRequest* request, uint8_t* data, size_t len, size_t index, size_t total) {
    if (index == 0 && refusedEarly(request)) return;
    if (total > PluginManager::MAX_SOURCE_BYTES) return;  // answered with 413 later
    if (index == 0 && !request->_tempObject) request->_tempObject = malloc(total + 1);
    if (!request->_tempObject || index + len > total) return;
    memcpy(static_cast<uint8_t*>(request->_tempObject) + index, data, len);
}

bool readJson(AsyncWebServerRequest* request, JsonDocument& doc) {
    const size_t length = request->contentLength();
    if (!request->_tempObject || length == 0 || length > PluginManager::MAX_SOURCE_BYTES) {
        sendError(request, 400, "send a JSON body, labelled application/json");
        return false;
    }
    if (deserializeJson(doc, static_cast<const char*>(request->_tempObject), length)) {
        sendError(request, 400, "the body is not valid JSON");
        return false;
    }
    return true;
}
