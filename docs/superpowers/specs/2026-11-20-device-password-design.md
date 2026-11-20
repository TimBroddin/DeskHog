# A password for the device: design

## Why

Anyone who can reach a DeskHog on the network can do everything with it: install or
rewrite plugins, change cards, press its buttons, read its screen, rename it, restart
it and, since 0.5.0, install unsigned firmware. The firmware-updates design left login
out on purpose. Tim wants to keep other people on the same network out
(2026-11-20), and chose a login screen on the device's page with a key per browser.

Two things found on the way are part of this work:

- The API answers any website (`Access-Control-Allow-Origin: *`). A page open in a
  browser on the network can call the device, and plain form posts get through even
  without that header. Nothing needs it: the device serves its own page.
- Plugin secrets are only hidden from the page. Whoever can rewrite a plugin can make
  it send its API key somewhere, so "anyone can install plugins" already meant "anyone
  can read the secrets".

## Goals

1. The owner sets a password on the Device tab. From then on every call to the device
   needs a key, in the firmware and in the updater.
2. A browser gets a key by logging in on the device's own page, once. So does
   `tools/deskhog`.
3. Things that send messages to plugins (Homey, Home Assistant, a CI job) keep working
   with a key of their own that can do nothing else.
4. A website that is not the device's own page cannot make the device do anything,
   whether a password is set or not.
5. An owner who forgot the password gets back in at the device, without a cable and
   without losing plugins, cards or settings.
6. The docs stop saying "there is no login" and say plainly what the password does
   and does not protect.

## Non-goals

- No HTTPS. The page stays plain HTTP, so someone who captures the WiFi traffic can
  copy a key and use it until it is removed. The docs say so.
- One password, one owner. No user names, no roles, no read-only visitors.
- Nothing against someone who can touch the device: they can hold the buttons, or
  plug in a cable and read the flash. Its buttons keep working without a login.
- No signed firmware (still "Later" in the firmware-updates design).
- The updater is not updated over WiFi here. See "Devices that already have an updater".
- A device without a password is not protected from a website that points its own
  domain name at the device's address (DNS rebinding). Setting a password closes that.
- No managing the password or message keys from `tools/deskhog`: `login` and `logout`
  only. The page does the rest.
- Joining the setup hotspot stays open. What the page there can do is covered (below).

## Anti-goals

- A call that is open by accident. New API calls must be locked unless they are put
  on the short list of open ones.
- The password, the value stored for it, or a key appearing in an answer to someone
  who is not logged in, in the serial log, or anywhere a plugin can read.
- The page sending a key to anything but the device. It also fetches from plugin
  directories and GitHub; those requests never carry it.
- An owner with whole firmware who needs a cable to get back in.
- A firmware update that removes the password, or that locks the owner out.
- A plugin logging in, reading keys, or changing or removing the password.
- Secrets in plugin settings being sent by the device. That stays as it is, also for
  a logged-in browser.

## Constraints

- Flash: the main firmware has about 97 KB left in its slot, the updater about 59 KB.
  The page is about 119 KB and is stored in the firmware as it is.
- The page is served over plain HTTP, so `crypto.subtle` is missing: the page carries
  its own SHA-256. `crypto.getRandomValues` does work there.
- The page must work on the setup hotspot with no internet: everything it needs is in
  `html/`.
- The updater shares nothing with the main firmware but NVS (`wifi_config`), which it
  opens read-only. It has no filesystem. So whatever the updater must check lives in NVS.
- The update flow hops between two firmwares at one address. A browser that started an
  update must still be let in by the updater, and by the firmware afterwards.
- Plugins reach the API through the device's own address. `POST /api/device`,
  `/api/restart` and `/api/update/start` already refuse them (403).
- The task rules in `tech-details.md` apply: the web server runs on core 0 and never
  touches the screen; anything shown on the screen is drawn by the UI task.
- Text that comes from plugins and directories is shown as text on the page, never as
  HTML. With a key in the browser's storage that matters more; it stays true.

## Approaches

- **A. The browser's own login box (HTTP Digest).** Both web servers have it built in,
  so it is the least work. The dialog is ugly and has a user name that means nothing,
  there is no log out, and because browsers attach that login by themselves, another
  website could still act through a logged-in browser. Rejected.
- **B. A login screen on the page, then a key per browser (chosen by Tim).** The page
  asks for the password once; the device hands that browser a random key, which the
  page sends with every call. A website cannot use the key, because the browser never
  attaches it by itself. It allows logging out. It is the most to build.
- **C. No password: approve at the device.** A new browser asks for a press on the
  device and gets a key. Nothing to remember, but you must be at the device to add a
  browser or the CLI, and anyone at the device can let themselves in. It reuses B's
  keys, so it can be added later. Rejected for now.

## What a locked device answers

No password is set until the owner sets one; until then everything works as today
(except "Other websites", below). With a password set, without a key:

```
GET  /                 the page. Nothing in it is secret
GET  /api/status       only {locked: true, updater: false}
GET  /api/login        what a login needs (below), and the device's name
POST /api/login        a login
     captive-portal checks (/generate_204 and the like)
everything else        401 {ok: false, locked: true, error: "..."}
```

That includes the screen, plugin source, the card list and the WiFi setup calls
(`/api/actions/*`): on the setup hotspot of a device that has a password, the page
asks for the password first.

One check in front of every route decides this, from a list of open calls, so a route
added later is locked without anyone remembering to lock it. A refused request is
refused before its body is kept or written anywhere.

Requests from the device itself (plugins) need no key and are treated as today. They
are refused, as `/api/device` is, on everything under "Logging in" and "Keys" below.

## Logging in

The password itself never crosses the network (builder's call by Claude, see "Calls
made"). The device stores a salt, a number of rounds and a verifier:

```
verifier = PBKDF2-HMAC-SHA256(password, salt, rounds), 32 bytes
proof    = HMAC-SHA256(verifier, nonce)
```

- `GET /api/login` gives `{locked, name, id, salt, rounds, nonce}`. A nonce works
  once and for a minute. `id` is the same for the firmware and the updater of one
  device and does not change with its name.
- `POST /api/login` with the nonce and the proof gives a new login key. The page or
  the CLI computes the verifier; the device never runs PBKDF2, it only checks the proof.
- Rounds are chosen so the page's own JavaScript needs about half a second on a phone.
  They are stored with the salt, so a later version can raise them.
- Five wrong proofs in a row: no logins for a minute. Keys that exist keep working.
- The page and the CLI refuse a password shorter than 8 characters.

Setting and changing (`/api/password`, needs a login key once a password exists):

- **First time:** the page makes a salt, computes the verifier and sends both. That
  value is as good as the password for this one device, and it crosses the network
  this once. The answer carries a login key, so the browser that set it stays in.
- **Change:** needs a proof of the old password. The new verifier is sent masked:
  `new verifier XOR HMAC-SHA256(old verifier, nonce + "new")`, so someone listening
  learns nothing usable. Every other login key is removed; message keys stay.
- **Remove:** needs a proof of the password. Removes the password and every key.

Until a password is set, anyone on the network can set one. The buttons undo that.

## Keys

A key is 128 random bits. Two kinds:

- **Login keys** can do everything. One per login; at most 8, and a ninth login
  replaces the oldest. Sent as `Authorization: Bearer <key>` only.
- **Message keys** can call `POST /api/cards/message` and
  `POST /api/connections/message` and nothing else. The owner makes them on the page
  and gives each a name; at most 8. Sent as the same header or as `?auth=<key>` in the
  address, because many senders can only be given an address. (`key` is taken:
  `/api/cards/message?key=<connection>:<card>` names the card.) The page can show a
  message key again later (a logged-in browser can do everything anyway).

```
GET    /api/keys            {logins: <count>, messages: [{id, name, key}]}
POST   /api/keys            {name}: a new message key
DELETE /api/keys?id=<id>    remove a message key
POST   /api/logout          remove the key this request came with
POST   /api/logout?others=1 remove every login key but this one
```

A call with a key that no longer exists gets the same 401 as one without.

## Other websites

In both firmwares, password or not:

- No `Access-Control-*` headers any more, and no answer to preflight requests.
- A request under `/api/` that carries an `Origin` header is refused (403) unless that
  origin is `http://` plus the request's own `Host`. Browsers send `Origin` on every
  request from another site that can change something, except a plain GET; `curl`, the
  CLI and Homey send none.
- So no call that changes something answers a GET any more (405). Today
  `/api/connections/remove`, `/api/cards/press` and `/api/cards/show` do, because they
  never look at the method; the docs already list them as POST. The check in front of
  the routes knows, for each call, whether it only reads.
- `test/portal/serve.js --device` passes the browser's requests on to a real device;
  it rewrites `Origin` so that keeps working.

## The page

The key is kept in the browser's storage for this address (and in memory when storage
is refused), and sent with every call to the device.

A locked device, no key or a key that stopped working:

```
  DeskHog · kitchen

  This DeskHog has a password.
  [ password                ]
  [ Log in ]

  Forgot it? Hold ▲ and ▼ on the DeskHog for ten seconds.
```

Nothing else of the page is shown until the login worked. A 401 in the middle of a
session drops the key and shows this screen.

Device tab, no password:

```
  Password
  No password. Anyone on your network can change this DeskHog.
  [ Set a password ]
```

Device tab, password set:

```
  Password
  On. This browser is logged in, and 2 other browsers or computers.
  [ Change password ] [ Log out ] [ Log out everywhere else ] [ Remove password ]

  Keys for messages
  For things on your network that send messages to plugins. They can do nothing else.
  Add &auth=<key> to the message address, or send the header Authorization: Bearer <key>.
  doorbell   3f9a…c21e   [ Copy ] [ Remove ]
  [ Add a key ]
```

- The browser's address for the device is its identity: `http://kitchen.local` and
  `http://192.168.1.20` are two logins.
- After a rename the page moves to the new address; it takes its key along so the
  owner stays logged in.
- When the browser holds a key and the device says it has no password, the page says
  that the password was removed at the device and offers to set a new one.
- The page shows no message addresses today and gains none: the line above the keys
  says how to use one, and `plugins/README.md` has the addresses.

## At the device

▲ and ▼ held together for ten seconds remove the password and every key. Nothing else
changes. It only does something when a password is set.

- After two seconds the screen counts down ("Removing the password in 8"), on top of
  whatever card is showing. Letting go cancels.
- It joins the two combinations a plugin never sees (● with ▲, ● with ▼).
- The updater does not read the buttons. A device with broken firmware, a forgotten
  password and no browser or computer that is still logged in needs the cable.

## The updater

Version 2 of the updater reads the salt, the verifier and the keys from NVS and never
writes them.

- Open without a key: `GET /`, `GET /api/status` (only `{locked: true, updater: true}`)
  and the two login calls. `POST /api/firmware`, `POST /api/restart` and the full
  status need a login key. Message keys open nothing here.
- A firmware upload without a key is refused before the first byte is written.
- A login in the updater works the same way; the key it gives lasts until the updater
  restarts and is not saved.
- Its own small page finds the key the main page saved (same address, same storage)
  and shows a password field when there is none.
- The same rule for other websites applies.
- It carries a marker with its version that the main firmware can find in the updater
  slot. `/api/device` status gains `updater: <version>` (1 when there is no marker, 0
  when there is no updater) and `password: true|false`.

### Devices that already have an updater

A firmware update over WiFi replaces only the main firmware. A device moved to layout
2 with 0.5.0 keeps updater 1, which takes firmware from anyone while it runs (the
minutes an update takes, or after a failed one). Nobody can start it without a login
key, but the gap is real.

- Updater 2 is installed over USB, once: `pio run -e updater -t upload`, or
  `deskhog-<version>-updater.bin` at `0x20000` with a browser flasher. `tools/deskhog
  migrate` and `deskhog-full.bin` install it for devices that come later.
- While a password is set (or being set) and the updater is older than 2, the Device
  tab says so, with what to do, and the update confirmation repeats it.
- Updates keep working either way.

## `tools/deskhog`

- `tools/deskhog login` asks for the password and saves a login key for that device
  (by its `id`, so `--host <ip>` and `--host <name>.local` find the same one) in a file
  only the user can read. `tools/deskhog logout` removes it, on the device too.
- `DESKHOG_KEY` in the environment is used instead when set.
- Every command sends the key when there is one, also to the updater during `update`.
  A 401 says: this DeskHog has a password, run `tools/deskhog login`.
- `migrate` works over USB and needs no key. It keeps NVS, so the password and keys
  survive it. `deskhog-full.bin` blanks NVS: no password afterwards, like everything else.

## Docs

- `README.md`: a short "Password" part (setting it, what it protects, what it does not,
  the buttons, the one-time USB step for the updater), and the "Anyone on your network
  can do this" line under Updating rewritten.
- `plugins/README.md`: the two "no login" paragraphs, messages with a message key, the
  new calls in the API list, and `Authorization` in the `curl` examples.
- `tech-details.md`: how the check in front of the routes works and how to open a
  call on purpose, what is in NVS, the login exchange, the updater's part.

## Left to the builder

- Names of files, classes, NVS keys and JSON fields beyond those shown; the wording on
  the page and the screen.
- Where the rules live (what is open, checking a proof, the key table, the origin
  rule, the wait after wrong tries) so that `test/native` covers them and both
  firmwares use the same code or provably the same behaviour.
- How the check sits in front of the routes in each web server, and how nonces are kept.
- The exact number of rounds, and how the SHA-256 in the page is kept small.
- How the countdown is drawn over a card.
- Where the CLI keeps its file on each system.
- How the pretend device in `test/portal` plays a locked device and a locked updater.

## Verification

- One set of test vectors (password, salt, rounds, nonce, expected verifier, proof and
  masked verifier) that the firmware's code, the page's JavaScript and the CLI's Python
  must all reproduce.
- Native tests cover the rules: every call that exists today is locked on a locked
  device unless listed as open, message keys open only the two message calls, `?auth=`
  is refused for login keys, requests from the device itself, the origin rule, a GET
  on every call that changes something, the ninth login, wrong tries.
- Portal tests cover: the login screen and nothing else on a locked device, a wrong
  and a right password, the key on every device call and on no outside call, a 401
  mid-session, set, change and remove, message keys, both log outs, a rename, the
  notice after a removal at the device, and an update on a locked device through a
  locked updater.
- Both firmwares build; their sizes are noted against their slots.
- On Tim's device, with him: set a password; a second browser is locked out; `curl`
  without a key gets 401; a message key in the address delivers a message and opens
  nothing else; `tools/deskhog login`; an update over WiFi after updater 2 went on
  over USB; the buttons; a page on another origin that posts `/api/restart` gets 403,
  with and without a password.

## Calls made

By Claude, not yet confirmed by Tim unless marked:

1. Off until set, everything locked once set, plugins' own calls unchanged, the
   buttons to get back in, traffic capture not covered (shown to Tim 2026-11-20, not
   objected to).
2. The password never crosses the network. Simpler would be to post it and let the
   device compare; that leaks a possibly reused password to anyone listening.
3. Message keys as a second, weaker kind of key, allowed in the address.
4. The buttons remove the password and keep everything else, rather than wiping the
   device.
5. Updater 2 goes on over USB; updating the updater over WiFi stays a later project.
6. Other websites are refused by the `Origin` rule; DNS rebinding on a device without
   a password is not covered.
7. At most 8 logins and 8 message keys; login keys are counted, not listed.
8. The CLI only logs in and out.
9. Calls that change something refuse GET. A sender that used a plain GET address for
   `/api/cards/show`, `/api/cards/press` or `/api/connections/remove` has to switch to
   POST.
10. A message key in the address is `?auth=`, not `?key=`.

## Later

- Approving a new browser at the device (approach C), as a second way to get a key.
- The main firmware rewriting the updater slot, so the updater updates over WiFi.
- Signed firmware.
