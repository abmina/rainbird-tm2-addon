'use strict';
// Protocol-level tests against the mock controller: transport, SIP commands,
// schedule decode/encode and verified page writes.
const assert = require('assert/strict');
const { MockTm2 } = require('./mock-tm2');
const { LnkClient } = require('../src/lnk');
const { Tm2, NackError } = require('../src/tm2');
const { ScheduleManager, nextRun, describeProgram } = require('../src/schedule');
const { encrypt, decrypt } = require('../src/crypto');
const { wallParts, wallToEpoch } = require('../src/time');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function main() {
  // crypto round trip incl. block-aligned and unaligned lengths
  for (const s of ['{}', '{"a":1234567890123}', 'x'.repeat(16), 'x'.repeat(33)]) {
    assert.equal(decrypt(encrypt(s, 'pw'), 'pw'), s);
  }

  const mock = new MockTm2({ password: 'secret', busyEvery: 7 });
  const port = await mock.listen();
  const lnk = new LnkClient({ host: '127.0.0.1', port, password: 'secret', minDelayMs: 5, log: quiet });
  const tm2 = new Tm2(lnk, quiet);
  try {
    const model = await tm2.getModel();
    assert.equal(model.id, '010A');
    assert.equal(model.name, 'ESP-TM2');
    assert.equal(lnk.scheme, 'https', 'auto-detects HTTPS');
    assert.deepEqual(await tm2.getStations(), [1, 2, 3, 4, 5, 6]);
    assert.equal(await tm2.getSerial(), '30C8A1F2E0040000');
    assert.equal(await tm2.getFirmware(), '2.10.0');

    // control
    await tm2.runZone(3, 2);
    assert.deepEqual(await tm2.getActiveZones(), [3]);
    let cs = await tm2.getCombinedState();
    assert.equal(cs.activeZone, 3);
    assert.ok(cs.remainingSeconds > 100 && cs.remainingSeconds <= 120);
    await tm2.stop();
    assert.deepEqual(await tm2.getActiveZones(), []);
    await tm2.runProgram(0);
    assert.deepEqual(await tm2.getActiveZones(), [1]);
    await tm2.advance();
    assert.deepEqual(await tm2.getActiveZones(), [2]);
    await tm2.stop();
    await assert.rejects(() => tm2.runProgram(2), NackError, 'empty program C is NACKed');
    await tm2.setRainDelay(3);
    assert.equal(await tm2.getRainDelay(), 3);
    await tm2.setRainDelay(0);
    await assert.rejects(() => tm2.runZone(1, 300), RangeError);

    // clock
    mock.clockOffset = -3600 * 1000;
    const tzLocal = Intl.DateTimeFormat().resolvedOptions().timeZone; // the mock keeps the process's local time
    await tm2.setDateTime(wallParts(Date.now(), tzLocal));
    const t = await tm2.getTime();
    assert.ok(Math.abs(t.hour * 3600 + t.minute * 60 + t.second - (new Date().getHours() * 3600 + new Date().getMinutes() * 60 + new Date().getSeconds())) < 5);

    // schedule
    const sm = new ScheduleManager(tm2, { log: quiet, maxZone: 6 });
    const s = await sm.refresh();
    assert.equal(s.programs.length, 3);
    const A = s.programs[0];
    assert.equal(A.frequency, 'custom');
    assert.deepEqual(A.days, [1, 3, 5]);
    assert.deepEqual(A.starts, ['06:00']);
    assert.equal(A.startSlots, 4);
    assert.deepEqual(A.runTimes, { 1: 10, 2: 15, 3: 8, 4: 8, 5: 0, 6: 12 });
    const B = s.programs[1];
    assert.equal(B.frequency, 'cyclic');
    assert.equal(B.cycleDays, 3);
    assert.equal(B.seasonal, 80);
    assert.equal(describeProgram(A), 'Mon, Wed, Fri at 06:00 · 53 min');
    assert.equal(describeProgram(s.programs[2]), 'Not scheduled');

    // write: new start time, days, seasonal and run times on program C
    const res = await sm.setProgram(2, { frequency: 'custom', days: [0, 6], starts: ['19:15', '05:30'], seasonal: 120, runTimes: { 2: 7, 5: 9 } });
    const C = res.schedule.programs[2];
    assert.deepEqual(C.days, [0, 6]);
    assert.deepEqual(C.starts, ['05:30', '19:15']);
    assert.equal(C.seasonal, 120);
    assert.equal(C.runTimes[2], 7);
    assert.equal(C.runTimes[5], 9);
    // other programs untouched
    assert.deepEqual(res.schedule.programs[0], A);
    assert.equal(res.log.length, 4, 'info + starts + 2 run-time pages');
    // controller really has it
    assert.equal(mock.pages[0x62], '014A' + '0483' + 'FFFF' + 'FFFF');

    // odd / even / cyclic validation
    await assert.rejects(() => sm.setProgram(2, { frequency: 'cyclic', cycleDays: 3, daysRemaining: 3 }), RangeError);
    await assert.rejects(() => sm.setProgram(2, { frequency: 'custom', days: [], starts: ['1:00', '2:00', '3:00', '4:00', '5:00'] }), RangeError);
    await sm.setProgram(2, { frequency: 'even' });
    assert.equal(sm.decode().programs[2].frequency, 'even');

    // verification failure -> rollback: make the mock corrupt a neighbouring page on the next write
    const orig = mock.sip.bind(mock);
    mock.sip = (d) => {
      const r = orig(d);
      if (d.startsWith('210061')) mock.pages[0x60] = '0000FFFFFFFFFFFF';
      return r;
    };
    await assert.rejects(() => sm.setProgram(1, { frequency: 'cyclic', cycleDays: 3, daysRemaining: 1, starts: ['22:00'] }), /verification failed/);
    mock.sip = orig;
    assert.equal(mock.pages[0x61], (1290).toString(16).toUpperCase().padStart(4, '0') + 'FFFFFFFFFFFF', 'target page restored');

    // global page
    mock.pages[0x60] = '0168FFFFFFFFFFFF';
    await sm.setGlobal({ rainSensorBypass: true });
    assert.equal(sm.decode().global.rainSensorBypass, true);
    await sm.setGlobal({ rainSensorBypass: false });

    // clear
    await sm.clearProgram(2);
    assert.equal(describeProgram(sm.decode().programs[2]), 'Not scheduled');

    // next run: Program A Mon/Wed/Fri 06:00; from a Tuesday noon -> Wednesday 06:00
    const tue = new Date(Date.UTC(2026, 9, 27, 12, 0)); // Tue 27 Oct 2026 12:00 controller wall time
    const nr = nextRun(sm.decode(), tue);
    assert.ok(nr);
    // Program B (cyclic, next in 1 day at 21:30) -> Wed 21:30 ; A -> Wed 06:00 wins
    assert.equal(nr.program, 'A');
    assert.equal(nr.at.getUTCDate(), 28);
    assert.equal(nr.at.getUTCHours(), 6);
    const nr2 = nextRun(sm.decode(), tue, { rainDelay: 2 });
    assert.ok(nr2.at.getUTCDate() >= 29);

    // time zones: Chicago is UTC-5 in October (CDT), UTC-6 after Nov 1 2026 (CST)
    const oct = Date.UTC(2026, 9, 31, 0, 20); // 2026-10-31 00:20Z
    assert.deepEqual(wallParts(oct, 'America/Chicago'), { year: 2026, month: 10, day: 30, hour: 19, minute: 20, second: 0 });
    assert.equal(wallToEpoch({ year: 2026, month: 10, day: 30, hour: 19, minute: 20, second: 0 }, 'America/Chicago'), oct);
    assert.equal(wallToEpoch({ year: 2026, month: 12, day: 1, hour: 6, minute: 0 }, 'America/Chicago'), Date.UTC(2026, 11, 1, 12, 0));
    assert.equal(wallParts(Date.UTC(2026, 6, 1, 12), 'Asia/Kolkata').minute, 30);

    // ---- the user's report: cyclic every 3 days, watered today at 03:00, DST ends Sun Nov 1 2026
    {
      const { Controller } = require('../src/controller');
      const { Store } = require('../src/store');
      const os = require('os'); const fsx = require('fs'); const px = require('path');
      const ctl = new Controller({ host: 'x', password: 'x', timezone: 'America/Chicago', timezoneSource: 'Home Assistant', autoSyncClock: true }, new Store(fsx.mkdtempSync(px.join(os.tmpdir(), 'rbst-'))), quiet);
      const realNow = Date.now;
      const now = Date.UTC(2026, 9, 31, 1, 18); // Fri Oct 30 20:18 CDT
      Date.now = () => now;
      try {
        ctl.state.status = { clockDriftSeconds: 0, rainDelay: 0 };
        ctl._ctrlWall = { utc: Date.UTC(2026, 9, 30, 20, 18), at: now };
        ctl.state.schedule = { programs: [{ name: 'A', frequency: 'cyclic', cycleDays: 3, daysRemaining: 0, days: [], daysOff: [], seasonal: 100, starts: ['03:00'], runTimes: { 1: 2, 2: 7 } }] };
        ctl._updateNextRun();
        assert.equal(ctl.state.nextRun.at, '2026-11-02T09:00:00.000Z', 'Mon Nov 2 03:00 CST, not 02:00');
        assert.equal(ctl.state.schedule.programs[0].nextRun, '2026-11-02T09:00:00.000Z');
        // controller 5h ahead (set to UTC): it starts at its 03:00, i.e. 5h earlier in real time
        ctl.state.status.clockDriftSeconds = 5 * 3600;
        ctl._updateNextRun();
        assert.equal(ctl.state.nextRun.at, '2026-11-02T04:00:00.000Z');

        // DST: Mon Nov 2 12:00 CST, controller still on CDT -> 1 h ahead -> synced automatically
        const after = Date.UTC(2026, 10, 2, 18, 0);
        Date.now = () => after;
        let synced = 0;
        ctl.syncClock = async () => { synced++; };
        ctl.state.status.clockDriftSeconds = 3600;
        await ctl._maybeSyncClock();
        assert.equal(synced, 1, 'DST shift is synced');
        // ...but a 5 h difference (time zone mismatch) still is not
        ctl.state.status.clockDriftSeconds = 5 * 3600;
        await ctl._maybeSyncClock();
        assert.equal(synced, 1, 'time zone mismatch is not auto-synced');
        // ...and a 1 h difference outside a DST week is not either
        Date.now = () => Date.UTC(2026, 11, 15, 18, 0);
        ctl.state.status.clockDriftSeconds = 3600;
        await ctl._maybeSyncClock();
        assert.equal(synced, 1);
      } finally {
        Date.now = realNow;
      }
    }

    // wrong password
    const bad = new Tm2(new LnkClient({ host: '127.0.0.1', port, password: 'nope', minDelayMs: 5, attempts: 1, log: quiet }));
    await assert.rejects(() => bad.getModel(), /password/);

    assert.ok(lnk.stats.retries > 0, 'busy 503s were retried');
    console.log(`protocol tests passed (${mock.requests} requests, ${lnk.stats.retries} busy retries)`);
  } finally {
    await mock.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
