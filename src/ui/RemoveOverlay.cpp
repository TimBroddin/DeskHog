#include "RemoveOverlay.h"

#include <lvgl.h>

#include "Style.h"

namespace RemoveOverlay {

namespace {

constexpr uint32_t kDoneMs = 2000;  // how long "Password removed" stays

lv_obj_t* label = nullptr;  // made on first use, then reused
int shownSeconds = -1;      // the countdown on the label, -1 when it shows none
bool doneShown = false;
uint32_t doneAt = 0;

// One label on the top layer, so it covers every card. The black background
// keeps it readable over any of them. Not clickable: it never takes a press.
lv_obj_t* make() {
    if (label) return label;
    label = lv_label_create(lv_layer_top());
    lv_obj_set_width(label, 240);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_font(label, Style::valueFont(), 0);
    lv_obj_set_style_text_color(label, Style::valueColor(), 0);
    lv_obj_set_style_bg_color(label, Style::backgroundColor(), 0);
    lv_obj_set_style_bg_opa(label, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(label, 8, 0);
    lv_obj_center(label);
    lv_obj_add_flag(label, LV_OBJ_FLAG_HIDDEN);
    return label;
}

}  // namespace

void show(int secondsLeft) {
    if (secondsLeft == shownSeconds && !doneShown) return;
    lv_obj_t* l = make();
    doneShown = false;
    shownSeconds = secondsLeft;
    lv_label_set_text_fmt(l, "Removing the password in %d", secondsLeft);
    lv_obj_clear_flag(l, LV_OBJ_FLAG_HIDDEN);
}

void done() {
    lv_obj_t* l = make();
    shownSeconds = -1;
    doneShown = true;
    doneAt = millis();
    lv_label_set_text(l, "Password removed");
    lv_obj_clear_flag(l, LV_OBJ_FLAG_HIDDEN);
}

void hide() {
    if (doneShown || shownSeconds < 0) return;
    shownSeconds = -1;
    if (label) lv_obj_add_flag(label, LV_OBJ_FLAG_HIDDEN);
}

void tick(uint32_t now) {
    if (!doneShown || now - doneAt < kDoneMs) return;
    doneShown = false;
    if (label) lv_obj_add_flag(label, LV_OBJ_FLAG_HIDDEN);
}

}  // namespace RemoveOverlay
