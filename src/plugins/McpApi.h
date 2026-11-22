#pragma once

class AsyncWebServer;
class PluginManager;

/**
 * An MCP server on the device: POST /api/mcp, the Streamable HTTP transport
 * of the Model Context Protocol, without sessions and without streams. An
 * agent (Claude Code, Claude Desktop, Cursor, ...) connects to it directly:
 *
 *   claude mcp add --transport http deskhog http://deskhog.local/api/mcp
 *   claude mcp add --transport http deskhog http://deskhog.local/api/mcp --header "Authorization: Bearer <key>"
 *
 * Its tools do what the web page does: list the cards, take a screenshot of
 * one, press its buttons, send it messages, change settings, install plugins
 * from the plugin directory or from source, add and remove cards, and change
 * the device's own settings. They call the same code as the routes in
 * PluginApi.h.
 *
 * It sits under /api/, so the check in front of the routes decides who may
 * call it (lib/access): with a password it wants a login key, a page on
 * another website may not, and a plugin may not either, since it reaches what
 * a plugin is refused elsewhere (the device's settings, restarting).
 *
 * Most tools answer at once. A few wait for the device: a screenshot for the
 * card to be painted, a pushed plugin to start, a plugin's list of choices,
 * and the plugin directory for the network task (installing is the one time
 * the device downloads plugins itself). Their request is paused, and a small
 * task of its own sends the answer when it is there, so neither the web
 * server nor the UI task waits.
 */
void registerMcpRoute(AsyncWebServer& server, PluginManager& manager);
