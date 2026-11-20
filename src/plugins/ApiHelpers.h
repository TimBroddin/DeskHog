#pragma once

// What the HTTP API's handlers share: answering in JSON and taking a JSON body.

#include <Arduino.h>
#include <ArduinoJson.h>

class AsyncWebServerRequest;

/** Answers with the document as JSON, never cached. */
void sendJson(AsyncWebServerRequest* request, int code, const JsonDocument& doc);
/** Answers {"ok": false, "error": message}. */
void sendError(AsyncWebServerRequest* request, int code, const String& message);
/** Answers {"ok": true}, with one more field when `field` is given. */
void sendOk(AsyncWebServerRequest* request, const char* field = nullptr, const String& value = String());

/**
 * A route's body handler: keeps the body in one block the request owns. A
 * request the check in front of the routes will refuse is not kept at all.
 */
void collectBody(AsyncWebServerRequest* request, uint8_t* data, size_t len, size_t index, size_t total);

/** Parse the request body as JSON. Answers the request itself when that fails. */
bool readJson(AsyncWebServerRequest* request, JsonDocument& doc);
