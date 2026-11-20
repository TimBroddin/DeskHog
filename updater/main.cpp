// The updater: a second, small firmware in its own slot (see partitions.csv).
//
// It can do one thing: join the saved WiFi under the device's name, take a
// firmware file over HTTP and write it over the main firmware. The main
// firmware restarts into it to be updated; a device whose main firmware is
// missing or half-written ends up here by itself, because the bootloader
// starts this slot whenever no other one is selected. So an update that fails
// can always be tried again without a cable.
//
// Nothing here comes from the main firmware except the names of its settings
// in NVS and the password rules (lib/access). Keep it small: it has to fit in
// its 1 MB slot.
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <SPI.h>
#include <Adafruit_ST7789.h>
#include <esp_ota_ops.h>
#include <esp_image_format.h>
#include <esp_partition.h>
#include <esp_random.h>
#include <mbedtls/sha256.h>

#include <Access.h>
#include <Sha256.h>

#include "login_js.h"

#ifndef UPDATER_VERSION
#define UPDATER_VERSION "1"
#endif

// The main firmware looks for this text in the updater's slot to learn which
// updater the device has (an updater without it is version 1).
#define MARKER_PREFIX "DESKHOG-UPDATER-VERSION:"

namespace {

const uint32_t kGiveUpMs = 5UL * 60UL * 1000UL;  ///< Without an upload, go back to the main firmware after this long

WebServer server(80);
Adafruit_ST7789 tft(&SPI, TFT_CS, TFT_DC, TFT_RST);

const esp_partition_t* target = nullptr;  ///< The main firmware's slot
String deviceName = "deskhog";
bool mainIntact = false;  ///< The main firmware can be started as it is
bool writing = false;
bool failed = false;
bool done = false;
String problem;
esp_ota_handle_t handle = 0;
mbedtls_sha256_context sha;
size_t written = 0;
size_t expected = 0;
int shownPercent = -1;
uint32_t lastActivityMs = 0;
uint32_t restartAtMs = 0;

const char kMarker[] = MARKER_PREFIX UPDATER_VERSION;
const char* const kVersion = kMarker + sizeof(MARKER_PREFIX) - 1;  ///< Used in the status, so the marker stays in the image

// ---------------------------------------------------------------- screen

void show(const char* headline, const String& detail, uint16_t color = ST77XX_WHITE) {
    tft.fillScreen(ST77XX_BLACK);
    tft.setTextWrap(true);
    tft.setTextColor(0x8410);  // gray
    tft.setTextSize(1);
    tft.setCursor(8, 8);
    tft.print("DeskHog updater");
    tft.setTextColor(color);
    tft.setTextSize(2);
    tft.setCursor(8, 34);
    tft.print(headline);
    tft.setTextColor(0xC618);  // light gray
    tft.setTextSize(1);
    tft.setCursor(8, 70);
    tft.print(detail);
}

void showProgress() {
    if (!expected) return;
    const int percent = (int)((uint64_t)written * 100 / expected);
    if (percent == shownPercent) return;
    if (shownPercent < 0) show("Updating", "Do not unplug the device.");
    shownPercent = percent;
    const int width = tft.width() - 16;
    tft.drawRect(8, 100, width, 14, ST77XX_WHITE);
    tft.fillRect(10, 102, (width - 4) * percent / 100, 10, 0xFA20);  // orange
}

String address() {
    if (WiFi.status() != WL_CONNECTED) return "Joining the WiFi...";
    return "http://" + deviceName + ".local\nhttp://" + WiFi.localIP().toString();
}

// ---------------------------------------------------------------- access
//
// The same check the main firmware puts in front of its calls (decideAccess in
// lib/access), with the password and the keys it saved in NVS. The updater
// only reads them: a login here gives a key that lasts until the updater
// restarts and is not saved. The answers have the main firmware's shapes and
// texts (src/plugins/AccessApi.cpp).

deskhog::AccessTable access;
deskhog::LoginGuard guard;
bool uploadRefused = false;  ///< The upload under way came without a key that works: none of it is written

std::string randomHex(size_t bytes) {
    uint8_t buffer[16];
    if (bytes > sizeof(buffer)) bytes = sizeof(buffer);
    esp_fill_random(buffer, bytes);
    return deskhog::toHex(buffer, bytes);
}

/** As DeviceAccess::deviceId() makes it, so the firmware and its updater have the same id. */
String deviceId() {
    const uint64_t mac = ESP.getEfuseMac();
    uint8_t bytes[6];
    for (int i = 0; i < 6; i++) bytes[i] = (uint8_t)(mac >> (8 * i));
    return deskhog::toHex(bytes, sizeof(bytes)).c_str();
}

/** Text that goes between quotes in an answer. */
String quoted(String text) {
    text.replace("\\", "\\\\");
    text.replace("\"", "\\\"");
    text.replace("\n", " ");
    return text;
}

void sendJson(int code, const String& json) {
    server.sendHeader("Cache-Control", "no-store");
    server.send(code, "application/json", json);
}

/** A refusal as the main firmware answers it; a 401 also says the device is locked. */
void sendFailure(int code, const char* error) {
    String json = "{\"ok\":false,";
    if (code == 401) json += "\"locked\":true,";
    json += "\"error\":\"" + String(error) + "\"}";
    sendJson(code, json);
}

/** What follows "Bearer " in the Authorization header; the word in any case. */
std::string bearer() {
    const String value = server.header("Authorization");
    static const char kPrefix[] = "bearer ";
    const size_t length = sizeof(kPrefix) - 1;
    if (value.length() <= length || strncasecmp(value.c_str(), kPrefix, length) != 0) return std::string();
    return std::string(value.c_str() + length);
}

deskhog::AccessVerdict verdict() {
    deskhog::AccessRequest request;
    request.method = http_method_str(server.method());
    request.path = server.uri().c_str();
    request.origin = server.header("Origin").c_str();
    request.host = server.hostHeader().c_str();
    request.bearer = bearer();
    // No key in the address: only message keys may come that way, and they open nothing here.
    return deskhog::decideAccess(request, access);
}

/** True, with the refusal sent, when this request may not go on. `full`: it may see everything. */
bool refused(bool* full = nullptr) {
    const deskhog::AccessVerdict answer = verdict();
    if (full) *full = answer.full;
    if (!answer.status) return false;
    sendFailure(answer.status, answer.error);
    return true;
}

/**
 * A field of the login's JSON body without a JSON library: the first quoted
 * string after the field's name in quotes. Taken only when it is hex for
 * exactly `bytes` bytes.
 */
bool hexField(const String& body, const char* name, size_t bytes, std::string& out) {
    const String label = String("\"") + name + "\"";
    const int at = body.indexOf(label);
    if (at < 0) return false;
    const int open = body.indexOf('"', at + label.length());
    const int close = open < 0 ? -1 : body.indexOf('"', open + 1);
    if (close < 0) return false;
    out = body.substring(open + 1, close).c_str();
    uint8_t scratch[32];
    return bytes <= sizeof(scratch) && deskhog::fromHex(out, scratch, bytes);
}

// GET /api/login: what a client needs to log in, and a fresh nonce on every call.
void handleLoginInfo() {
    if (refused()) return;
    const std::string nonce = randomHex(16);
    guard.issue(nonce, millis());
    String json = "{\"locked\":" + String(access.hasPassword() ? "true" : "false");
    json += ",\"name\":\"" + quoted(deviceName) + "\"";
    json += ",\"id\":\"" + deviceId() + "\"";
    json += ",\"salt\":\"" + String(access.salt().c_str()) + "\"";
    json += ",\"rounds\":" + String(access.rounds());
    json += ",\"nonce\":\"" + String(nonce.c_str()) + "\"}";
    sendJson(200, json);
}

// POST /api/login: a proof for a login key. The checks in the main firmware's
// order: while logins are refused nothing is looked at; the nonce is used up
// whether the proof is right or not; then the proof counts as a wrong try or
// clears them.
void handleLogin() {
    if (refused()) return;
    if (!access.hasPassword()) return sendFailure(409, "This DeskHog has no password.");
    const String body = server.arg("plain");
    std::string nonce, proof;
    if (!hexField(body, "nonce", 16, nonce)) return sendFailure(400, "nonce is the 32 hex digits GET /api/login gave");
    if (!hexField(body, "proof", 32, proof)) return sendFailure(400, "proof is 64 hex digits");
    const uint32_t now = millis();
    if (guard.waiting(now)) return sendFailure(429, "Too many wrong tries. Wait a minute.");
    if (!guard.take(nonce, now)) return sendFailure(403, "That took too long. Try again.");
    if (!access.checkProof(nonce, proof)) {
        guard.wrong(now);
        return sendFailure(403, "That is not the password.");
    }
    guard.right();
    const std::string key = randomHex(16);
    access.addLogin(key);
    sendJson(200, "{\"ok\":true,\"key\":\"" + String(key.c_str()) + "\"}");
}

/** The saved password and keys (ConfigManager::getAccess). A record that cannot be read means no password, as in the main firmware. */
void loadAccess(Preferences& settings) {
    if (!settings.isKey("pw_ver")) return;
    const String verifier = settings.getString("pw_ver", "");
    const String salt = settings.isKey("pw_salt") ? settings.getString("pw_salt", "") : String();
    const uint32_t rounds = settings.isKey("pw_rounds") ? settings.getUInt("pw_rounds", 0) : 0;
    if (!verifier.length()) return;
    // rounds past what an int holds turn negative, and setPassword refuses those too.
    if (!access.setPassword(salt.c_str(), (int)rounds, verifier.c_str())) return;
    if (settings.isKey("pw_keys")) access.loadKeys(settings.getString("pw_keys", "").c_str());
}

// ---------------------------------------------------------------- writing

bool mainLooksIntact() {
    if (!target) return false;
    esp_image_metadata_t data;
    const esp_partition_pos_t where = {target->address, target->size};
    return esp_image_verify(ESP_IMAGE_VERIFY_SILENT, &where, &data) == ESP_OK;
}

void fail(const String& why) {
    if (failed) return;
    failed = true;
    problem = why;
    if (writing) esp_ota_abort(handle);
    writing = false;
    show("Update failed", why + "\nTry again at\n" + address(), ST77XX_RED);
}

String hex(const unsigned char* bytes, size_t count) {
    static const char digits[] = "0123456789abcdef";
    String out;
    for (size_t i = 0; i < count; i++) {
        out += digits[bytes[i] >> 4];
        out += digits[bytes[i] & 15];
    }
    return out;
}

void onUpload() {
    // Only a form upload carries the file. The web server calls this for any
    // other body too, with no upload to look at; that body is dropped.
    if (!server.header("Content-Type").startsWith("multipart/")) return;
    HTTPUpload& part = server.upload();
    // Asked before anything changes, so a refused upload leaves the slot, the
    // screen and the time of the last activity as they were. The route's
    // final handler then sends the refusal.
    if (part.status == UPLOAD_FILE_START) uploadRefused = verdict().status != 0;
    if (uploadRefused) return;
    lastActivityMs = millis();
    if (part.status == UPLOAD_FILE_START) {
        failed = false;
        done = false;
        problem = "";
        written = 0;
        shownPercent = -1;
        expected = (size_t)server.arg("size").toInt();
        if (!target) return fail("This device has no slot for the firmware.");
        if (expected > target->size) return fail("The file is too large for this device.");
        // From the first byte on, the old firmware is gone.
        mainIntact = false;
        if (esp_ota_begin(target, OTA_WITH_SEQUENTIAL_WRITES, &handle) != ESP_OK) {
            return fail("Could not start writing.");
        }
        writing = true;
        mbedtls_sha256_init(&sha);
        mbedtls_sha256_starts(&sha, 0);
        show("Updating", "Do not unplug the device.");
    } else if (part.status == UPLOAD_FILE_WRITE) {
        if (failed || !writing) return;
        if (written + part.currentSize > target->size) return fail("The file is too large for this device.");
        if (esp_ota_write(handle, part.buf, part.currentSize) != ESP_OK) return fail("Writing failed.");
        mbedtls_sha256_update(&sha, part.buf, part.currentSize);
        written += part.currentSize;
        showProgress();
    } else if (part.status == UPLOAD_FILE_END) {
        if (failed || !writing) return;
        writing = false;
        unsigned char digest[32];
        mbedtls_sha256_finish(&sha, digest);
        if (expected && written != expected) {
            esp_ota_abort(handle);
            return fail("The file arrived incomplete.");
        }
        if (esp_ota_end(handle) != ESP_OK) return fail("That file is not DeskHog firmware.");
        String wanted = server.arg("sha256");
        wanted.toLowerCase();
        if (wanted.length() && wanted != hex(digest, sizeof(digest))) return fail("The file was damaged on the way.");
        if (esp_ota_set_boot_partition(target) != ESP_OK) return fail("Could not select the new firmware.");
        mainIntact = true;
        done = true;
    } else if (part.status == UPLOAD_FILE_ABORTED) {
        fail("The connection was lost.");
    }
}

// ---------------------------------------------------------------- web

void sendStatus(int code = 200) {
    String json = "{\"updater\":true,\"version\":\"" + String(kVersion) + "\",\"name\":\"" + quoted(deviceName) + "\"";
    json += ",\"main_intact\":" + String(mainIntact ? "true" : "false");
    json += ",\"writing\":" + String(writing ? "true" : "false");
    json += ",\"written\":" + String((unsigned long)written);
    json += ",\"done\":" + String(done ? "true" : "false");
    json += ",\"slot_size\":" + String((unsigned long)(target ? target->size : 0));
    json += ",\"error\":\"" + quoted(problem) + "\"}";
    sendJson(code, json);
}

// The page. html/login.js comes in as kLoginJs (see updater/login_js.py); its
// top-level names (passwordVerifier, loginProof, sha256, toHex ...) are globals
// here, so the page's own script uses none of them for anything else.
const char kPage[] PROGMEM = R"HTML(<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeskHog updater</title>
<style>body{font:16px system-ui,sans-serif;max-width:34em;margin:2em auto;padding:0 1em;color:#222}
button{font:inherit;padding:.4em 1em;margin:.3em .3em .3em 0}#say{margin:1em 0;font-weight:600}</style>
<h1>DeskHog updater</h1>
<div id="login" hidden><p>This DeskHog has a password. Log in to install firmware.</p>
<p><input type="password" id="password" autocomplete="current-password"> <button id="in">Log in</button></p></div>
<div id="main"><p>This device is waiting for firmware. If you were updating it from its web page, that page will carry on by itself.
To install a firmware file by hand, choose it here.</p>
<p><input type="file" id="file" accept=".bin"> <button id="send">Install</button></p>
<p><button id="back">Restart without updating</button></p></div>
<p id="say"></p>
<script>)HTML" kLoginJs R"HTML(</script>
<script>
// The key the main page saved (same address, same storage). A key from a
// login on this page stays in memory: the main firmware does not know it.
let key = '';
try { key = localStorage.getItem('deskhog-key') || ''; } catch (e) {}
const $ = id => document.getElementById(id);
const say = t => $('say').textContent = t;
const wait = () => setTimeout(() => location.reload(), 15000);
const call = (path, options) => fetch(path, Object.assign({ headers: key ? { Authorization: 'Bearer ' + key } : {} }, options));
const locked = on => { $('login').hidden = !on; $('main').hidden = on; };
call('/api/status').then(res => res.json()).then(status => locked(!!status.locked)).catch(() => {});
$('in').onclick = async () => {
  say('Logging in...');
  try {
    const info = await (await call('/api/login')).json();
    const proof = loginProof(passwordVerifier($('password').value, info.salt, info.rounds), info.nonce);
    const res = await call('/api/login', { method: 'POST', body: JSON.stringify({ nonce: info.nonce, proof }) });
    const answer = await res.json();
    if (!res.ok) return say(answer.error);
    key = answer.key;
    $('password').value = '';
    locked(false); say('');
  } catch (e) { say('The connection was lost. Reload this page and try again.'); }
};
$('send').onclick = async () => {
  const file = $('file').files[0];
  if (!file) return say('Choose a firmware file first.');
  const body = new FormData(); body.append('firmware', file);
  say('Installing. Do not unplug the device...');
  try {
    const res = await call('/api/firmware?size=' + file.size, { method: 'POST', body });
    const status = await res.json();
    if (res.status === 401) locked(true);
    if (!res.ok) return say('That did not work: ' + status.error);
    say('Installed. The device is restarting...'); wait();
  } catch (e) { say('The connection was lost. Reload this page and try again.'); }
};
$('back').onclick = async () => {
  const res = await call('/api/restart', { method: 'POST' });
  if (res.ok) { say('Restarting...'); wait(); }
  else if (res.status === 409) say('The firmware on this device is not complete, so there is nothing to restart into. Install a file.');
  else {
    if (res.status === 401) locked(true);
    say('That did not work: ' + ((await res.json()).error || 'the device could not select its firmware.'));
  }
};
</script>)HTML";

void startWeb() {
    // The headers the check in front of the calls reads, and the one onUpload does.
    static const char* kHeaders[] = {"Origin", "Authorization", "Content-Type"};
    server.collectHeaders(kHeaders, sizeof(kHeaders) / sizeof(kHeaders[0]));

    server.on("/", HTTP_GET, [] { server.send_P(200, "text/html", kPage); });
    server.on("/api/status", HTTP_GET, [] {
        bool full = false;
        if (refused(&full)) return;
        // Without a login key on a locked device: only that it is locked.
        if (!full) return sendJson(200, "{\"locked\":true,\"updater\":true}");
        sendStatus();
    });
    server.on("/api/login", HTTP_GET, handleLoginInfo);
    server.on("/api/login", HTTP_POST, handleLogin);
    server.on("/api/firmware", HTTP_POST, [] {
        // A refused upload wrote nothing (see onUpload); this says why.
        if (refused()) return;
        sendStatus(done ? 200 : 400);
        if (done) {
            show("Updated", "Restarting...", ST77XX_GREEN);
            restartAtMs = millis() + 800;
        }
    }, onUpload);
    server.on("/api/restart", HTTP_POST, [] {
        if (refused()) return;
        if (writing || !mainIntact) return sendStatus(409);
        if (esp_ota_set_boot_partition(target) != ESP_OK) return sendStatus(500);
        sendStatus();
        show("Restarting", "");
        restartAtMs = millis() + 800;
    });
    server.onNotFound([] { server.send(404, "text/plain", "The updater has no such page."); });
    server.begin();
}

}  // namespace

void setup() {
#if defined(TFT_I2C_POWER)
    pinMode(TFT_I2C_POWER, OUTPUT);
    digitalWrite(TFT_I2C_POWER, HIGH);
#endif
    pinMode(TFT_BACKLITE, OUTPUT);
    digitalWrite(TFT_BACKLITE, HIGH);
    SPI.begin();
    tft.init(135, 240);
    tft.setRotation(1);

    target = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, nullptr);
    mainIntact = mainLooksIntact();

    Preferences settings;
    settings.begin("wifi_config", true);
    const String ssid = settings.getString("ssid", "");
    const String password = settings.getString("password", "");
    const String name = settings.getString("dm_name", "");
    loadAccess(settings);
    settings.end();
    if (name.length()) deviceName = name;

    show("Ready to update", "Joining the WiFi...");
    WiFi.mode(WIFI_STA);
    WiFi.setHostname(deviceName.c_str());
    WiFi.begin(ssid.c_str(), password.c_str());
    startWeb();
    lastActivityMs = millis();
}

void loop() {
    static bool announced = false;
    if (!announced && WiFi.status() == WL_CONNECTED) {
        announced = true;
        if (MDNS.begin(deviceName.c_str())) MDNS.addService("http", "tcp", 80);
        if (!writing && !failed) {
            show(mainIntact ? "Ready to update" : "Needs firmware", "Waiting for the file at\n" + address());
        }
    }
    server.handleClient();

    const uint32_t now = millis();
    if (restartAtMs && (int32_t)(now - restartAtMs) >= 0) ESP.restart();
    // Nobody came: carry on with the firmware that is there, if it is whole.
    if (!restartAtMs && !writing && mainIntact && now - lastActivityMs > kGiveUpMs) {
        if (esp_ota_set_boot_partition(target) == ESP_OK) {
            show("Restarting", "No update arrived.");
            delay(800);
            ESP.restart();
        }
        lastActivityMs = now;
    }
    delay(2);
}
