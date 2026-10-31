# Changelog

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
