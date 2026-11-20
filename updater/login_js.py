"""Put the page's login maths (html/login.js) into the updater.

The updater has no filesystem, so its page is a string in the firmware. This
writes updater/login_js.h, with html/login.js as one raw string, before every
updater build. The file is only rewritten when its text changes, so an
unchanged build does not recompile main.cpp. It is generated: git ignores it.
"""

import os

Import("env")  # noqa: F821  (provided by PlatformIO)

project = env.subst("$PROJECT_DIR")  # noqa: F821
source = os.path.join(project, "html", "login.js")
target = os.path.join(project, "updater", "login_js.h")
end = ")LOGINJS\""

with open(source, encoding="utf-8") as handle:
    script = handle.read()
if end in script:
    print("login_js: html/login.js contains %s, which would end the string early" % end)
    env.Exit(1)  # noqa: F821

# A macro, so the compiler can put it between the two halves of the page.
text = ("// Generated from html/login.js by updater/login_js.py on every build. Do not edit.\n"
        "#pragma once\n"
        "#define kLoginJs R\"LOGINJS(" + script + end + "\n")

old = None
if os.path.exists(target):
    with open(target, encoding="utf-8") as handle:
        old = handle.read()
if old != text:
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(text)
