# Changelog

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
