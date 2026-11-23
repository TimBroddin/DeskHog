-- The latest headlines from Flemish news sites, one at a time, newest first,
-- with where they come from and how old they are. A new one every 15 seconds;
-- centre for the next one right away.
--
-- The feeds are RSS or Atom, newest first, and some are larger than the device
-- takes. So only the first 32 KB of each is read (`first`, firmware 0.6.1), and
-- an item cut off at the end is left out.

plugin = {
  name = "Headlines Belgium",
  description = "The latest headlines from VRT NWS, De Morgen, HLN and Nieuwsblad, one at a time (firmware 0.6.1)",
  author = "DeskHog",
  version = "1.0",
  refresh = 600,
  fps = 1,
}

config = {
  sources = { label = "Sources", default = "All",
    options = { "All", "VRT NWS", "De Morgen", "HLN", "Nieuwsblad" }, order = 1 },
  count = { label = "How many headlines", default = 15, order = 2 },
  advance = { label = "Seconds before the next headline (0 to stay)", default = 15, order = 3 },
}

local SOURCES = {
  { name = "VRT NWS", color = "#5ac8c8", url = "https://www.vrt.be/vrtnws/nl.rss.articles.xml" },
  { name = "De Morgen", color = "#e2001a", url = "https://www.demorgen.be/rss.xml" },
  { name = "HLN", color = "#c8102e", url = "https://www.hln.be/home/rss.xml" },
  { name = "Nieuwsblad", color = "#0a6ebd", url = "https://www.nieuwsblad.be/rss" },
}

local W, H = gfx.width, gfx.height
local PAD = 8
local TOP, BOTTOM = 26, H - 10

local headlines           -- nil until the first answer
local current = 1
local problem
local shownAt = 0
local lines, font = {}, "medium"

-- Typographic marks the device's fonts do not have, as plain ones.
local PLAIN = { ["\u{2018}"] = "'", ["\u{2019}"] = "'", ["\u{201A}"] = "'", ["\u{201C}"] = '"', ["\u{201D}"] = '"',
  ["\u{201E}"] = '"', ["\u{2013}"] = "-", ["\u{2014}"] = "-", ["\u{2026}"] = "...", ["\u{00A0}"] = " " }
local NAMED = { amp = "&", lt = "<", gt = ">", quot = '"', apos = "'", nbsp = " ", hellip = "...",
  lsquo = "'", rsquo = "'", ldquo = '"', rdquo = '"', ndash = "-", mdash = "-" }

-- XML text to plain text: CDATA, entities, and any tags left inside.
local function unescape(s)
  local cdata = s:match("^%s*<!%[CDATA%[(.-)%]%]>%s*$")
  if cdata then s = cdata end
  s = s:gsub("<[^>]*>", "")
  s = s:gsub("&(#?x?)(%w+);", function(kind, code)
    if kind == "#" then return utf8.char(tonumber(code) or 63) end
    if kind == "#x" then return utf8.char(tonumber(code, 16) or 63) end
    return NAMED[code]
  end)
  for fancy, plain in pairs(PLAIN) do s = s:gsub(fancy, plain) end
  return (s:gsub("%s+", " "):gsub("^ ", ""):gsub(" $", ""))
end

local MONTHS = { Jan = 1, Feb = 2, Mar = 3, Apr = 4, May = 5, Jun = 6,
  Jul = 7, Aug = 8, Sep = 9, Oct = 10, Nov = 11, Dec = 12 }

-- "2026-11-22T17:04:22.000Z" or "+01:00" at the end (Atom).
local function isoTime(s)
  local y, mo, d, h, mi, se, rest = s:match("(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)(.*)")
  if not y then return nil end
  local t = time.make({ year = tonumber(y), month = tonumber(mo), day = tonumber(d),
    hour = tonumber(h), min = tonumber(mi), sec = tonumber(se) }, "UTC0")
  local sign, oh, om = rest:match("([+-])(%d%d):?(%d%d)")
  if sign then
    local off = tonumber(oh) * 3600 + tonumber(om) * 60
    t = sign == "+" and t - off or t + off
  end
  return t
end

-- "Sun, 22 Nov 2026 15:48:00 GMT" or "+0100" at the end (RSS).
local function rssTime(s)
  local d, mon, y, h, mi, se, zone = s:match("(%d+) (%a+) (%d+) (%d+):(%d+):?(%d*) ?(%S*)")
  if not d or not MONTHS[mon] then return nil end
  local t = time.make({ year = tonumber(y), month = MONTHS[mon], day = tonumber(d),
    hour = tonumber(h), min = tonumber(mi), sec = tonumber(se) or 0 }, "UTC0")
  local sign, oh, om = zone:match("([+-])(%d%d)(%d%d)")
  if sign then
    local off = tonumber(oh) * 3600 + tonumber(om) * 60
    t = sign == "+" and t - off or t + off
  end
  return t
end

-- Every complete <item> or <entry> in what arrived. One cut off at the end has
-- no closing tag, so the patterns pass it by.
local function parse(body, source)
  local found = {}
  local function add(block, when)
    local title = block:match("<title[^>]*>(.-)</title>")
    if title then
      title = unescape(title)
      if title ~= "" then found[#found + 1] = { title = title, time = when, source = source } end
    end
  end
  for block in body:gmatch("<item[%s>](.-)</item>") do
    local date = block:match("<pubDate>(.-)</pubDate>")
    add(block, date and rssTime(date))
  end
  for block in body:gmatch("<entry[%s>](.-)</entry>") do
    local date = block:match("<published>(.-)</published>") or block:match("<updated>(.-)</updated>")
    add(block, date and isoTime(date))
  end
  return found
end

-- "5m", "3h" or "2d" since a moment.
local function age(at)
  local now = time.now()
  if now == 0 or not at then return nil end
  local seconds = math.max(0, now - at)
  if seconds < 3600 then return math.max(1, seconds // 60) .. "m" end
  if seconds < 86400 then return seconds // 3600 .. "h" end
  return seconds // 86400 .. "d"
end

-- Medium if the headline fits, otherwise small, and cut off what still does not.
local function layout()
  local item = headlines and headlines[current]
  if not item then lines = {} return end
  local room = BOTTOM - TOP
  font = "medium"
  lines = gfx.wrap(item.title, W - 2 * PAD, font)
  if #lines * gfx.textHeight(font) > room then
    font = "small"
    lines = gfx.wrap(item.title, W - 2 * PAD, font)
  end
  local fits = room // gfx.textHeight(font)
  if #lines > fits then
    for i = #lines, fits + 1, -1 do lines[i] = nil end
    local last = lines[fits]
    while #last > 1 and gfx.textWidth(last .. "...", font) > W - 2 * PAD do
      last = last:sub(1, (utf8.offset(last, -1) or #last) - 1)
    end
    lines[fits] = last .. "..."
  end
end

local function show(index)
  current = index
  shownAt = time.ms()
  layout()
end

local function wanted()
  local list = {}
  for _, source in ipairs(SOURCES) do
    if config.sources == source.name or config.sources == "All" then
      list[#list + 1] = source
    end
  end
  return list
end

function load()
  local sources = wanted()
  local results, waiting, failed = {}, #sources, {}

  local function finish()
    local all = {}
    for _, list in pairs(results) do
      for _, item in ipairs(list) do all[#all + 1] = item end
    end
    if #all == 0 then
      if not headlines then
        problem = #failed > 0 and ("No answer from " .. table.concat(failed, ", ")) or "No headlines right now"
      end
      return
    end
    -- Newest first; one without a date goes last.
    table.sort(all, function(a, b) return (a.time or 0) > (b.time or 0) end)
    local count = math.max(1, math.min(40, math.floor(config.count)))
    for i = #all, count + 1, -1 do all[i] = nil end

    -- Stay on the same headline if it is still there.
    local keep = headlines and headlines[current] and headlines[current].title
    headlines, problem = all, nil
    local at = 1
    for i, item in ipairs(all) do
      if item.title == keep then at = i end
    end
    show(at)
  end

  for i, source in ipairs(sources) do
    http.get(source.url, { first = 32 * 1024, timeout = 15 }, function(res)
      if res.ok and res.body then
        results[i] = parse(res.body, source)
      else
        failed[#failed + 1] = source.name
        print(source.name .. ": " .. (res.error or ("status " .. res.status)))
      end
      waiting = waiting - 1
      if waiting == 0 then finish() end
    end)
  end
end

-- The next headline every few seconds, measured with time.ms().
function update()
  if not headlines or #headlines < 2 or config.advance <= 0 then return false end
  if time.ms() - shownAt < config.advance * 1000 then return end   -- repaint: the bar moves on
  show(current % #headlines + 1)
end

function draw()
  if not headlines then
    gfx.text(PAD, 6, "Headlines Belgium", "white", "medium")
    gfx.text(PAD, 34, problem or "Loading...", problem and "orange" or "gray", "small")
    return
  end
  local item = headlines[current]

  -- Header: the source in its colour, then how old it is and where in the list.
  local name = item.source.name
  local boxW = gfx.textWidth(name, "small") + 10
  gfx.rect(PAD, 4, boxW, 18, item.source.color, 4)
  gfx.text(PAD + boxW / 2, 4, name, "white", "small", "center")
  local right = current .. "/" .. #headlines
  local old = age(item.time)
  if old then right = old .. "  ·  " .. right end
  gfx.text(W - PAD, 5, right, "gray", "small", "right")

  -- The headline, centred in the space it has.
  local lineHeight = gfx.textHeight(font)
  local y = TOP + (BOTTOM - TOP - #lines * lineHeight) // 2
  for _, line in ipairs(lines) do
    gfx.text(PAD, y, line, "white", font)
    y = y + lineHeight
  end

  -- How long until the next one, as a thin bar along the bottom.
  if config.advance > 0 and #headlines > 1 then
    local part = math.min(1, (time.ms() - shownAt) / (config.advance * 1000))
    gfx.rect(0, H - 3, W * part, 3, item.source.color)
  end
end

-- Centre goes to the next headline; up and down move between cards as usual.
function button(name)
  if name ~= "center" or not headlines or #headlines == 0 then return false end
  show(current % #headlines + 1)
  return true
end
