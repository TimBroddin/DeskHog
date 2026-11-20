#pragma once

#include <Arduino.h>

/**
 * The words that appear over whatever card is showing while ▲ and ▼ are held
 * to remove the password: a countdown, then "Password removed" for two seconds.
 * The UI task only: it draws on LVGL's top layer.
 */
namespace RemoveOverlay {

/// "Removing the password in 8". The same number as last time touches nothing.
void show(int secondsLeft);
/// "Password removed", until tick() takes it away two seconds later.
void done();
/// Takes the countdown away. "Password removed" stays until tick() ends it.
void hide();
/// Call on every pass of the button block; ends "Password removed" in time.
void tick(uint32_t now);

}  // namespace RemoveOverlay
