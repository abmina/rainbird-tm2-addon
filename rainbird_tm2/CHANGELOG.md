# Changelog

## 0.2.0
- Security rating 8 (of 8): the add-on now runs isolated on Home Assistant's internal network
  (no host networking) and ships a custom AppArmor profile.
- "Scan network" works without host networking: it pings every address of Home Assistant's
  subnet (the /24 around it on large networks) and also recognises Rain Bird modules by their
  HTTPS certificate, so modules that ignore the discovery ping are still found. It reports
  which range it scanned.
- Generic examples in the configuration descriptions.

## 0.1.6
- Rain delay: +/- update instantly; one request is sent with the final value.

## 0.1.5
- Much faster: one HTTPS connection is reused for bursts of requests instead of a new TLS
  handshake per request (closed after 3 s idle so the Rain Bird app can still connect).
- Faster verified schedule writes: each page is read back right after writing, then one final
  full check (28 requests for a typical program save instead of 54). Still rolls back on mismatch.
- Lighter status polling; default request spacing 150 ms.
- Fix: "+ Add start time" (and removing one) now updates the program editor immediately.
- Fix: clicking a start time opens the time picker, and editing hour/minutes/AM-PM no longer
  kicks you out of the field after the first part.
- Controller tab shows connections and average request time.

## 0.1.3
- Fix: next-run times were an hour off across a daylight saving change.
- The ESP-TM2 has no DST support; after a DST change the controller clock is now moved
  forward/back automatically (only for exactly the DST shift).
- Program editor shows each program's next run, and explains the "every N days" counter
  (0 means today is a watering day, even if today's start has already passed).
- MQTT: program attributes include `next_run`.

## 0.1.2
- Fix: the add-on now receives the Supervisor token and time zone (start script uses `with-contenv`),
  so MQTT and the Home Assistant time zone are picked up automatically.

## 0.1.1
- Controller clock handled in Home Assistant's time zone (new optional `timezone` option).
- Automatic clock sync no longer "corrects" whole-hour differences, which are almost always a
  time zone mismatch - it warns instead; use *Sync clock* to fix.

## 0.1.0
- First release: local control of the ESP-TM2 via the LNK WiFi module, sidebar web UI with program
  editor, verified schedule writes, MQTT discovery entities, network discovery setup screen.
