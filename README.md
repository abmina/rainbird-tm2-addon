# Rain Bird ESP-TM2 - Home Assistant add-on

Local, cloud-free control of a Rain Bird ESP-TM2 through its LNK WiFi module, with a sidebar web UI
(full program editor) and Home Assistant entities via MQTT discovery. See
[`rainbird_tm2/DOCS.md`](rainbird_tm2/DOCS.md) for setup and usage.

[![Add repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fabmina%2Frainbird-tm2-addon)

> Not affiliated with or endorsed by Rain Bird Corporation. Use at your own risk - this talks to your
> irrigation controller using a reverse-engineered protocol.

## Install

**From this repository (recommended):**

1. Click the button above, or in Home Assistant go to *Settings → Add-ons → Add-on store → ⋮ →
   Repositories* and add `https://github.com/abmina/rainbird-tm2-addon`.
2. Find **Rain Bird ESP-TM2** in the store, install, start, and open **Rain Bird** in the sidebar.

Requires Home Assistant OS or Supervised (anything with the Add-on store). Tested with an ESP-TM2
(model 010A, firmware 2.10) and LNK3 WiFi module; other ESP-TM2 / ESP-Me controllers use the same
protocol and are likely to work - reports welcome.

**As a local add-on (for development):**

1. Copy the `rainbird_tm2` folder into the `/addons` share of your Home Assistant
   (Samba share or the SSH / Terminal add-on): `/addons/rainbird_tm2/`.
2. *Settings → Add-ons → Add-on store → ⋮ → Check for updates*. It appears under **Local add-ons**.
3. Install, set `host` and `password`, start.

## Layout

```
repository.yaml
rainbird_tm2/
  config.yaml  build.yaml  Dockerfile  run.sh  DOCS.md  translations/
  app/
    src/       crypto.js  lnk.js (transport)  tm2.js (SIP commands)  schedule.js (pages, verified writes)
               controller.js  ha.js (MQTT discovery)  mqtt.js  server.js  config.js  store.js  main.js
    www/       index.html  app.js  style.css
    test/      mock-tm2.js (simulated controller)  mini-broker.js  test-protocol.js  test-addon.js
```

No npm dependencies - only Node.js 18+.

## Development

```sh
cd rainbird_tm2/app
npm test                      # protocol + end-to-end tests against the simulated ESP-TM2
node test/mock-tm2.js 8443    # simulated controller (password "secret")
DATA_DIR=/tmp/rb RAINBIRD_HOST=127.0.0.1 RAINBIRD_PORT=8443 RAINBIRD_PASSWORD=secret \
  HTTP_PORT=8099 node src/main.js   # then open http://localhost:8099
```

Point `RAINBIRD_HOST` at the real module (and `MQTT_HOST` at your broker) to run it outside
Home Assistant, e.g. on the Mint VM, before installing the add-on.
