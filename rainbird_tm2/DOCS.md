# Rain Bird ESP-TM2 (local)

Talks directly to the Rain Bird LNK / LNK2 / LNK3 WiFi module on your LAN - no Rain Bird cloud.
It gives you:

- **A web UI in the Home Assistant sidebar** (ingress, like Zigbee2MQTT): live status, quick zone runs,
  rain delay, and a full editor for programs A/B/C - watering days (days of week, odd, even, every N days),
  days off, up to 4 start times, per-zone run times and seasonal adjust.
- **Home Assistant entities over MQTT discovery** - one device with zone switches, program buttons,
  rain delay, seasonal adjust, rain sensor, next scheduled run and more.

Built and tested for the **ESP-TM2 (model 010A, firmware 2.10)** with an LNK3 module. Other ESP-TM2 /
ESP-Me family controllers use the same protocol and should work.

## Setup

1. Give the WiFi module a DHCP reservation so its IP never changes.
2. Install the **Mosquitto broker** app and the **MQTT** integration if you don't have them
   (optional - without MQTT you still get the web UI).
3. Start the app and open **Rain Bird** in the sidebar. The first time, you get a setup screen:
   - **Scan network** broadcasts the same discovery ping the Rain Bird app uses and lists the modules that
     answer - click one to fill in its IP. (Some routers/VLANs block broadcasts; then type the IP from
     your router's client list.)
   - Enter the **device password** you set for the controller in the Rain Bird app.
     Not your WiFi password, not your Rain Bird account password.
   - **Test connection** shows the model and zone count; **Save and connect** stores it and starts.

   You can change it later under *Controller → Change controller*. Alternatively set `host` and `password`
   on the app's Configuration tab; a controller saved from the web page takes precedence.

The app manages **one controller**. It runs isolated on Home Assistant's internal network with an
AppArmor profile (security rating 8). *Scan network* pings every address of the subnet Home Assistant is on
(for large subnets, the /24 around Home Assistant's address); if your controller is on a different range,
enter its IP.

## Recommended: block the module's internet access

On your router/firewall, block outbound internet for the module's IP while keeping LAN access.
Other ESP-TM2 users found local control much more reliable this way: the module stops spending its
limited capacity on cloud syncs. The Rain Bird phone app will then only work on your home WiFi (or not at
all) - use this app instead.

**Do not migrate to the "Rain Bird 2.0" app / firmware** if it is offered. It moves the controller to the
IQ4 cloud and local access stops working.

## Things to know

- **One connection at a time.** The module serves a single request at a time. The app queues and paces
  everything, but if the Rain Bird phone app is open at the same moment, commands will be slow or retried.
- **Schedule writes are verified.** Each change is written one page at a time, then every schedule page is read
  back. If anything other than the intended page changed, the change is rolled back and you get an error.
  A full program save takes roughly 5-20 seconds.
- **Schedule changes are blocked while the controller is watering** (set `allow_writes_while_watering` to
  override).
- **Manual zone runs are 1-255 minutes** (protocol limit for manual runs). Program run times go up to 360.
- Changes made at the controller's own buttons are picked up on the next schedule refresh
  (`schedule_refresh_minutes`), or immediately with *Refresh* on the Controller tab.
- *Next scheduled run* is calculated by the app from the programs, rain delay and controller clock. It
  does not account for the rain sensor.

## Home Assistant entities

| Entity | What it does |
|---|---|
| `switch` per zone | On = run for that zone's default run time, Off = stop |
| `number` *Zone run time* per zone | Default minutes for the zone switch (stored in the app) |
| `button` *Start program A/B/C* | Runs a program now |
| `sensor` *Program A/B/C* | Summary text; full schedule in the attributes |
| `number` *Program X seasonal adjust* | 0-200 %, written to the controller |
| `button` *Stop watering*, *Next zone* | |
| `number` *Rain delay* | 0-14 days |
| `switch` *Rain sensor bypass* | Written to the controller |
| `binary_sensor` *Watering*, *Rain sensor*, *Controller connected* | |
| `sensor` *Active zone*, *Remaining time*, *Next scheduled run*, *Clock drift* | |
| `button` *Sync clock*, *Refresh* | |

### MQTT command topics

All under `rainbird_tm2/<serial>/cmd/`:

| Topic | Payload |
|---|---|
| `zone/<n>/set` | `ON`, `OFF`, or a number of minutes |
| `program/<A-C>/run` | anything |
| `program/<A-C>/seasonal/set` | 0-200 |
| `rain_delay/set` | 0-14 |
| `stop`, `advance`, `sync_clock`, `refresh` | anything |
| `json` | `{"action": "run_zone", "zone": 2, "minutes": 5}` - also `run_program`, `stop`, `advance`, `rain_delay` (`days`), `sync_clock`, `set_program` (`program`, `schedule`) |

Example automation action - water the flower beds for 8 minutes:

```yaml
action: mqtt.publish
data:
  topic: rainbird_tm2/<serial>/cmd/zone/5/set
  payload: "8"
```

`set_program` takes the same fields as the web UI, any subset of:
`frequency` (`custom|odd|even|cyclic`), `days` (0=Sun..6=Sat), `daysOff`, `cycleDays`, `daysRemaining`,
`starts` (`["06:00","21:30"]`), `runTimes` (`{"1": 10, "2": 0}`), `seasonal`.

## Troubleshooting

- **"Could not decrypt reply - wrong device password?"** - the password is wrong. If you don't know it,
  check Home Assistant's built-in Rain Bird integration config (`.storage/core.config_entries`), or set a new
  one in the Rain Bird app.
- **Unreachable / timeouts** - check the IP, that the phone app is closed, and raise `poll_interval`.
- The *Controller* tab has a command-support scan and a raw dump of the schedule pages; include it in any
  bug report together with the app log (set `log_level: debug` for SIP-level traces).

## Credits

Protocol details come from the reverse-engineering work in
[pyrainbird](https://github.com/allenporter/pyrainbird) and the
[Hubitat Rain Bird LNK driver](https://github.com/MHedish/Hubitat), which first verified schedule writes on
the ESP-TM2. Not affiliated with Rain Bird.
