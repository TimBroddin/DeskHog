#!/usr/bin/env bash
# Test tools/deskhog's login and logout without a device: it talks to the
# pretend device of test/portal/serve.js, started here with a password. Needs
# Node.js and Python 3. The key file goes in a temporary folder, never in the
# real ~/.config/deskhog.

set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tool="$root/tools/deskhog"
host="localhost:8765"
work="$(mktemp -d)"
server=""

cleanup() {
    if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true; fi
    rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

# These checks must not see a key from the caller's environment or home folder.
unset DESKHOG_KEY DESKHOG_HOST
export XDG_CONFIG_HOME="$work/config"
keys="$XDG_CONFIG_HOME/deskhog/keys.json"

# 1. The maths: the vectors that pin it for the firmware, the page and this tool.
python3 - "$root" <<'PY'
import importlib.machinery, importlib.util, json, sys, unicodedata
root = sys.argv[1]
loader = importlib.machinery.SourceFileLoader("deskhog", root + "/tools/deskhog")
spec = importlib.util.spec_from_loader("deskhog", loader)
tool = importlib.util.module_from_spec(spec)
loader.exec_module(tool)
v = dict(line.rstrip("\n").split("=", 1) for line in open(root + "/test/access/vectors.txt") if "=" in line)
verifier = tool.password_verifier(v["password"], v["salt"], int(v["rounds"]))
assert verifier == v["verifier"], "verifier"
assert tool.login_proof(verifier, v["nonce"]) == v["proof"], "proof"
utf8 = json.loads(v["utf8_password"])
for form in ("NFC", "NFD"):
    text = unicodedata.normalize(form, utf8)
    assert tool.password_verifier(text, v["salt"], int(v["rounds"])) == v["utf8_verifier"], "utf8 " + form
PY

# 8. With DESKHOG_KEY set, a request built for the device carries the key and
#    one for an outside address does not. Both go through the same stand-in for
#    the network, so the first shows that the stand-in sees headers at all.
DESKHOG_KEY=00112233445566778899aabbccddeeff python3 - "$root" <<'PY'
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("deskhog", sys.argv[1] + "/tools/deskhog")
spec = importlib.util.spec_from_loader("deskhog", loader)
tool = importlib.util.module_from_spec(spec)
loader.exec_module(tool)
seen = []
class Answer:
    headers = {}
    def __enter__(self): return self
    def __exit__(self, *none): return False
    def read(self): return b"{}"
tool.urllib.request.urlopen = lambda request, timeout=None: (seen.append(request), Answer())[1]
def authorization(request):
    if isinstance(request, str):
        return None
    return dict((name.lower(), value) for name, value in request.header_items()).get("authorization")
tool.Device("deskhog.local").request("GET", "/api/state")
assert len(seen) == 1, "the device request was not made"
assert authorization(seen[0]) == "Bearer 00112233445566778899aabbccddeeff", "the device was not given the key"
tool.fetch("https://raw.githubusercontent.com/example/repo/HEAD/plugins/index.json")
assert len(seen) == 2, "fetch made no request"
assert authorization(seen[1]) is None, "a key went to an outside address"
PY

if curl -s -o /dev/null --max-time 2 "http://$host/api/login"; then
    fail "port 8765 is already in use; stop what runs there and try again"
fi
node "$root/test/portal/serve.js" --port 8765 --password "correct horse battery" >"$work/server.log" 2>&1 &
server=$!
for _ in $(seq 1 100); do
    if curl -s -o /dev/null --max-time 2 "http://$host/api/login"; then break; fi
    kill -0 "$server" 2>/dev/null || fail "the pretend device did not start: $(cat "$work/server.log")"
    sleep 0.1
done
curl -s -o /dev/null --max-time 2 "http://$host/api/login" || fail "the pretend device does not answer"

# Runs a command, keeping its output in $out and its exit status in $status.
run() { set +e; out="$("$@" 2>&1)"; status=$?; set -e; }

# 2. Without a key the device says no, and the tool says how to log in.
run "$tool" --host "$host" list
[ "$status" -eq 1 ] || fail "2: list without a key exited $status, not 1"
case "$out" in *"tools/deskhog login"*) ;; *) fail "2: the error does not name tools/deskhog login: $out" ;; esac

# 3. A wrong password.
run bash -c 'printf "wrong password\n" | "$0" --host "$1" login' "$tool" "$host"
[ "$status" -eq 1 ] || fail "3: a wrong password exited $status, not 1"
case "$out" in *"That is not the password."*) ;; *) fail "3: the device's words are missing: $out" ;; esac

# 4. The right password; the key file is private.
run bash -c 'printf "correct horse battery\n" | "$0" --host "$1" login' "$tool" "$host"
[ "$status" -eq 0 ] || fail "4: login exited $status: $out"
[ -f "$keys" ] || fail "4: $keys was not written"
mode="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$keys")"
[ "$mode" = "0o600" ] || fail "4: keys.json has mode $mode, not 600"

# 5. The key works, on both names of the same device.
run "$tool" --host "$host" list
[ "$status" -eq 0 ] || fail "5: list after login exited $status: $out"
run "$tool" --host 127.0.0.1:8765 list
[ "$status" -eq 0 ] || fail "5: list through 127.0.0.1 exited $status: $out"

# 6. Logging out removes the key.
run "$tool" --host "$host" logout
[ "$status" -eq 0 ] || fail "6: logout exited $status: $out"
run "$tool" --host "$host" list
[ "$status" -eq 1 ] || fail "6: list after logout exited $status, not 1"

# 7. DESKHOG_KEY is used instead of the file.
run bash -c 'printf "correct horse battery\n" | "$0" --host "$1" login' "$tool" "$host"
[ "$status" -eq 0 ] || fail "7: the second login exited $status: $out"
key="$(python3 -c 'import json,sys; print(list(json.load(open(sys.argv[1])).values())[0])' "$keys")"
rm -f "$keys"
run "$tool" --host "$host" list
[ "$status" -eq 1 ] || fail "7: list without the file exited $status, not 1"
run env DESKHOG_KEY="$key" "$tool" --host "$host" list
[ "$status" -eq 0 ] || fail "7: list with DESKHOG_KEY exited $status: $out"

# 9. A message key: send to connection:card works; a plugin name cannot be looked
#    up with it, and the tool says to give the card. Any 401 with DESKHOG_KEY set
#    says that key was refused, not to log in again.
message="$(curl -s -X POST -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -d '{"name":"bell"}' "http://$host/api/keys" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')"
run env DESKHOG_KEY="$message" "$tool" --host "$host" send homey:1 hello
[ "$status" -eq 0 ] || fail "9: send homey:1 with a message key exited $status: $out"
run env DESKHOG_KEY="$message" "$tool" --host "$host" send homey hello
[ "$status" -eq 1 ] || fail "9: send homey with a message key exited $status, not 1"
case "$out" in *"connection:card"*) ;; *) fail "9: it does not say to give the card as connection:card: $out" ;; esac
case "$out" in *"DESKHOG_KEY"*) ;; *) fail "9: it does not say the key in DESKHOG_KEY was refused: $out" ;; esac
run env DESKHOG_KEY="$message" "$tool" --host "$host" list
[ "$status" -eq 1 ] || fail "9: list with a message key exited $status, not 1"
case "$out" in *"DESKHOG_KEY"*) ;; *) fail "9: a 401 with DESKHOG_KEY set does not name it: $out" ;; esac
case "$out" in *"Run tools/deskhog login"*) fail "9: with DESKHOG_KEY set it still says to log in: $out" ;; esac

# 10. An update on a locked device: refused in the tool's words without a key,
#     installed through the (pretend) updater with one.
python3 -c 'import sys; sys.stdout.buffer.write(b"\xe9" + bytes(4095))' > "$work/firmware.bin"
run "$tool" --host "$host" update "$work/firmware.bin"
[ "$status" -eq 1 ] || fail "10: update without a key exited $status, not 1"
case "$out" in *"tools/deskhog login"*) ;; *) fail "10: update without a key does not say to log in: $out" ;; esac
run env DESKHOG_KEY="$key" "$tool" --host "$host" update "$work/firmware.bin"
[ "$status" -eq 0 ] || fail "10: update with a key exited $status: $out"
case "$out" in *"The device is back, on firmware custom."*) ;; *) fail "10: the update did not finish: $out" ;; esac

# 11. Categories: index writes them in the order of categories.json, and refuses
#     a plugin in none, in two, or a name that is no plugin.
folder="$work/directory"
mkdir -p "$folder"
for name in clock snake; do
    printf 'plugin = { name = "%s", description = "x", version = "1.0" }\n' "$name" > "$folder/$name.lua"
done
run "$tool" index "$folder"
[ "$status" -eq 0 ] || fail "11: index without categories exited $status: $out"
grep -q categor "$folder/index.json" && fail "11: categories out of nowhere"
echo '{ "Time": ["clock"], "Games": ["snake"], "Empty": [] }' > "$folder/categories.json"
run "$tool" index "$folder"
[ "$status" -eq 0 ] || fail "11: index exited $status: $out"
python3 - "$folder/index.json" <<'PY' || fail "11: the index does not have the categories"
import json, sys
index = json.load(open(sys.argv[1]))
assert index["categories"] == ["Time", "Games"], index
assert {p["name"]: p["category"] for p in index["plugins"]} == {"clock": "Time", "snake": "Games"}, index
PY
refuses() {
    echo "$1" > "$folder/categories.json"
    run "$tool" index --check "$folder"
    [ "$status" -ne 0 ] || fail "11: took $1"
    case "$out" in *"$2"*) ;; *) fail "11: $1 does not say \"$2\": $out" ;; esac
}
refuses '{ "Time": ["clock"] }' "put snake in a category"
refuses '{ "Time": ["clock", "snake"], "Games": ["snake"] }' "listed twice"
refuses '{ "Time": ["clock", "snake", "sundial"] }' "no plugin sundial"

echo ok
