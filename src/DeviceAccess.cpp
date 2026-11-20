#include "DeviceAccess.h"

#include <esp_random.h>

#include "ConfigManager.h"

namespace {

class Held {
public:
    explicit Held(SemaphoreHandle_t lock) : lock_(lock) { xSemaphoreTakeRecursive(lock_, portMAX_DELAY); }
    ~Held() { xSemaphoreGiveRecursive(lock_); }
    Held(const Held&) = delete;
    Held& operator=(const Held&) = delete;

private:
    SemaphoreHandle_t lock_;
};

String hex(const uint8_t* bytes, size_t count) {
    static const char kDigits[] = "0123456789abcdef";
    String text;
    text.reserve(count * 2);
    for (size_t i = 0; i < count; i++) {
        text += kDigits[bytes[i] >> 4];
        text += kDigits[bytes[i] & 0x0f];
    }
    return text;
}

}  // namespace

DeviceAccess::DeviceAccess(ConfigManager& config)
    : config_(config), lock_(xSemaphoreCreateRecursiveMutex()), saveLock_(xSemaphoreCreateMutex()) {}

void DeviceAccess::begin() {
    const SavedAccess saved = config_.getAccess();
    Held held(lock_);
    table_.removePassword();
    if (saved.verifier.length()) {
        // rounds past what an int holds turn negative, and setPassword refuses those too.
        if (table_.setPassword(saved.salt.c_str(), static_cast<int>(saved.rounds), saved.verifier.c_str())) {
            table_.loadKeys(saved.keys.c_str());
        } else {
            Serial.println("The saved password record could not be read. Starting without a password.");
        }
    }
    hasPassword_ = table_.hasPassword();
}

bool DeviceAccess::with(const std::function<bool(deskhog::AccessTable&, deskhog::LoginGuard&)>& work) {
    SavedAccess record;
    uint32_t change = 0;
    {
        Held held(lock_);
        const bool save = work(table_, guard_);
        hasPassword_ = table_.hasPassword();
        if (!save) return true;
        if (table_.hasPassword()) {
            record.salt = table_.salt().c_str();
            record.rounds = static_cast<uint32_t>(table_.rounds());
            record.verifier = table_.verifier().c_str();
            record.keys = table_.keysText().c_str();
        }
        change = ++changes_;
    }

    // Writing the flash takes a while; the lock is free meanwhile. A save that
    // was overtaken by a newer one has nothing left to write: the newer record
    // holds this change too, so whether that one took is the answer.
    xSemaphoreTake(saveLock_, portMAX_DELAY);
    if (static_cast<int32_t>(change - saved_) > 0) {
        savedOk_ = config_.saveAccess(record);
        saved_ = change;
    }
    const bool took = savedOk_;
    xSemaphoreGive(saveLock_);
    return took;
}

deskhog::AccessVerdict DeviceAccess::decide(const deskhog::AccessRequest& request) {
    Held held(lock_);
    return deskhog::decideAccess(request, table_);
}

bool DeviceAccess::hasPassword() { return hasPassword_; }

void DeviceAccess::removeAtDevice() {
    const bool saved = with([](deskhog::AccessTable& table, deskhog::LoginGuard&) {
        table.removePassword();
        return true;
    });
    if (!saved) Serial.println("Removing the password did not reach the flash: it is back after a restart.");
}

String DeviceAccess::randomHex(size_t bytes) {
    uint8_t buffer[64];
    String text;
    while (bytes > 0) {
        const size_t count = bytes < sizeof(buffer) ? bytes : sizeof(buffer);
        esp_fill_random(buffer, count);
        text += hex(buffer, count);
        bytes -= count;
    }
    return text;
}

String DeviceAccess::deviceId() {
    const uint64_t mac = ESP.getEfuseMac();
    uint8_t bytes[6];
    for (int i = 0; i < 6; i++) bytes[i] = static_cast<uint8_t>(mac >> (8 * i));
    return hex(bytes, sizeof(bytes));
}
