#pragma once

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <atomic>
#include <functional>

#include "Access.h"

class ConfigManager;

/**
 * The device's password and keys, kept in NVS. The rules are in lib/access;
 * this holds the one table and guard the device has, behind a lock, because
 * the web server and the UI task both reach them.
 *
 * The lock may be taken again by the task that holds it, so a `with` that
 * ends up in `decide` does not hang. Saving to NVS happens after the lock is
 * let go, so a check in front of a route never waits for the flash.
 */
class DeviceAccess {
public:
    explicit DeviceAccess(ConfigManager& config);

    /** Load what is saved. A record that cannot be read leaves the device without a password. */
    void begin();

    /**
     * Run `work` with the table and the guard under the lock. When it returns true, the table is saved.
     * False when that save did not reach the flash: the change holds until the next restart. True when
     * nothing needed saving.
     */
    bool with(const std::function<bool(deskhog::AccessTable&, deskhog::LoginGuard&)>& work);

    deskhog::AccessVerdict decide(const deskhog::AccessRequest& request);

    /** Cheap and safe from any task: the UI task asks on every pass. */
    bool hasPassword();

    /** From the UI task: forget the password and every key. */
    void removeAtDevice();

    /** `bytes` random bytes from the hardware generator, as lowercase hex. */
    static String randomHex(size_t bytes);
    /** The 6 bytes of ESP.getEfuseMac() as 12 hex digits. */
    static String deviceId();

private:
    ConfigManager& config_;
    SemaphoreHandle_t lock_;        ///< Around table_ and guard_
    SemaphoreHandle_t saveLock_;    ///< Around writing to NVS, so two saves cannot cross
    deskhog::AccessTable table_;
    deskhog::LoginGuard guard_;
    std::atomic<bool> hasPassword_{false};
    uint32_t changes_ = 0;          ///< Counts saves asked for; under lock_
    uint32_t saved_ = 0;            ///< The last of those written; under saveLock_
    bool savedOk_ = true;           ///< Whether that write took; under saveLock_
};
