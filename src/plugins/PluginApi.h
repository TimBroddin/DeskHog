#pragma once

#include <ArduinoJson.h>

#include <functional>
#include <string>

#include "plugins/PluginManager.h"

class AsyncWebServer;

/**
 * The HTTP API for plugins, connections and cards, served next to the rest of
 * the portal. Bodies and answers are JSON unless noted.
 *
 * For the web page:
 *
 *   GET  /api/state                         plugins, connections, the card stack and their live state
 *   POST /api/timezone                      {posix, name}: the device's time zone, as a POSIX TZ string; "" is UTC
 *   GET  /api/device                        the device's settings and status (also `device` in /api/state):
 *                                           {name, screen: {day, night}, led: {day, night},
 *                                            night: {enabled, from, until}, rotate: {seconds}, battery,
 *                                            status: {night, manual, battery, gauge}}
 *   POST /api/device                        any part of the same, without status; all or nothing.
 *                                           {preview: "night" | "day"} shows those levels for a few
 *                                           seconds and saves nothing. Answers like GET
 *   POST /api/restart                       restarts the device half a second after answering
 *   POST /api/cards/add                     {plugin, kind, name, settings, front, rotate, connection | connectionName + connectionSettings}
 *   POST /api/cards/update?key=<c>:<n>      {name, settings, front, rotate}; front: may the card come to the front
 *                                           by itself; rotate: does auto-rotate stop at it
 *   POST /api/cards/layout                  ["<TYPE>|<config>", ...] in the new order; cards left out are removed
 *   GET  /api/cards/screen?key=<c>:<n>      the card's pixels, raw RGB565 (width and height in X-Width, X-Height)
 *   POST /api/cards/press?key=..&button=..  press up, center or down for a card
 *   POST /api/cards/show?key=..             bring a card to the front
 *   POST /api/connections/add               {plugin, name, settings}
 *   POST /api/connections/update?id=<c>     {name, settings}
 *   POST /api/connections/remove?id=<c>     also removes its cards
 *   GET  /api/connections/choices?id=<c>&field=<key>[&kind=<kind>][&settings=<JSON>]
 *                                           what the plugin offers for a setting with `choices`:
 *                                           {choices: [{value, label}]}. Answers 202 {pending: true}
 *                                           while the plugin is working on it: ask again
 *
 * For anything that wants to tell a plugin something (body: text or JSON, 4 KB at most). With a
 * password these two take a message key, as `Authorization: Bearer <key>` or `&auth=<key>`:
 *
 *   POST /api/cards/message?key=<c>:<n>     calls the card's message(msg); 404 if it has none, 429 if 8 are waiting
 *   POST /api/connections/message?id=<c>    calls the plugin's global message(msg)
 *
 * For developers:
 *
 *   GET    /api/plugins                     plugin files, storage use and headroom
 *   GET    /api/plugins/<name>              the plugin's source (text)
 *   PUT    /api/plugins/<name>              install or replace (body: Lua source); POST works too
 *   DELETE /api/plugins/<name>              remove the plugin, its connections and cards
 *   GET    /api/plugins/<name>/status       how it is running, last error, print() output
 *
 * For agents: POST /api/mcp, an MCP server with tools for all of the above (McpApi.h).
 *
 * Who may call what is decided in front of every route (decideAccess in
 * lib/access, wired up in AccessApi.cpp). Without a password anyone on the
 * network may; with one, every call under /api/ needs a key, except the login
 * calls. Only the calls on the read list answer GET; the others want POST (or
 * PUT, DELETE). A route nobody put on a list in decideAccess is locked and
 * POST only. The login, password and key calls are in AccessApi.h.
 */
void registerPluginRoutes(AsyncWebServer& server, PluginManager& manager);

// What the routes answer, without a request, for the MCP server (McpApi.h).

/**
 * GET /api/state: hands the document to `use`, which may only use it then. It
 * points into the manager's records instead of copying every name.
 */
void writeState(PluginManager& manager, const std::function<void(const JsonDocument&)>& use);
/** GET /api/plugins/<name>/status. Needs a document of 12 KB. */
void writePluginStatus(JsonDocument& doc, PluginManager& manager, const String& name);
/** GET /api/device, with the memory and stack headroom of GET /api/plugins in `system`. */
void writeDevice(JsonObject device, PluginManager& manager);
/** The change POST /api/device makes, all or nothing. False with `error` set. */
bool changeDevice(JsonObjectConst body, PluginManager& manager, std::string& error);
/** A JSON object of settings, as the routes take them; every value as text. */
PluginSettings settingsFrom(JsonVariantConst source);
/** Restart the device half a second from now, so an answer can still go out. */
void restartSoon();
