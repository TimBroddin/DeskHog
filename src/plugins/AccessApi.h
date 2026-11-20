#pragma once

#include "Access.h"

class AsyncWebServer;
class AsyncWebServerRequest;
class DeviceAccess;
class PluginManager;

/**
 * The check in front of every route, and (later) the calls for logging in,
 * the password and the keys. Who may call what is decided by
 * deskhog::decideAccess in lib/access; this only feeds it the request.
 *
 * Call before any other route is registered. The check is server middleware,
 * so it also stands in front of routes added later and of the not-found
 * handler: a new route is locked without anyone remembering to lock it.
 */
void registerAccessRoutes(AsyncWebServer& server, DeviceAccess& access, PluginManager& manager);

/** What the rules say about this request: whether it is let through, and whether it may see everything. */
deskhog::AccessVerdict verdictFor(AsyncWebServerRequest* request);

/** True: the check will refuse this request. For body handlers, which run before the check. */
bool refusedEarly(AsyncWebServerRequest* request);
