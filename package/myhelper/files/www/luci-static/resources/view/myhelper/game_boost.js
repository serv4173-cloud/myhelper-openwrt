'use strict';
'require view';
'require uci';
'require rpc';
'require ui';
'require dom';
'require poll';

var callStatus        = rpc.declare({ object: 'myhelper', method: 'status' });
var callForceRecovery = rpc.declare({ object: 'myhelper', method: 'force_recovery' });
var callQosReapply    = rpc.declare({ object: 'myhelper', method: 'qos_reapply' });

var POLL_STATS  = 1;   // WAN rx/tx counters
var POLL_STATUS = 5;   // myhelper status (history arrays — heavy)

var loadChartScript = function() {
    return new Promise(function(resolve, reject) {
        if (window.Chart) return resolve();
        var script = document.createElement('script');
        script.src = L.resource('view/myhelper/chart.umd.min.js');
        script.onload  = function() { resolve(); };
        script.onerror = function() { reject(new Error('chart.umd.min.js not found')); };
        document.head.appendChild(script);
    });
};

var isOk = function(v) {
    if (v === true)  return true;
    if (v === false) return false;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return (v === '1' || v.toLowerCase() === 'true');
    return false;
};

var parseLastPing = function(s, key) {
    if (!s || !Array.isArray(s[key]) || s[key].length === 0) return '---';
    var last = s[key][s[key].length - 1];
    if (!last || !isOk(last.ok)) return 'timeout';
    var rtt = Number(last.rtt_us);
    if (!Number.isFinite(rtt) || rtt < 0) return 'err';
    return (rtt / 1000).toFixed(0) + ' ms';
};

var fmtUptime = function(sec) {
    sec = Math.floor(Number(sec) || 0);
    if (sec < 60)    return sec + 's';
    if (sec < 3600)  return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
};

var fmtAgo = function(ts) {
    ts = Number(ts) || 0;
    if (ts <= 0) return 'never';
    var sec = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (sec < 60)    return sec + 's ago';
    if (sec < 3600)  return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return Math.floor(sec / 86400) + 'd ago';
};

var RECOVERY_STATE_LABEL = ['idle', 'down', 'delay', 'up', 'ifup'];

var readSpeedtest = function() {
    return {
        dl: uci.get('myhelper', 'settings', 'speedtest_download')
         || uci.get('myhelper', 'game_boost', 'speedtest_download'),
        ul: uci.get('myhelper', 'settings', 'speedtest_upload')
         || uci.get('myhelper', 'game_boost', 'speedtest_upload'),
        ts: uci.get('myhelper', 'settings', 'speedtest_timestamp')
         || uci.get('myhelper', 'game_boost', 'speedtest_timestamp')
    };
};

var fmtSpeedtest = function(st) {
    if (!st || (!st.dl && !st.ul)) return null;
    var dlM = (Number(st.dl) > 0) ? (Number(st.dl) / 1000).toFixed(1) : '?';
    var ulM = (Number(st.ul) > 0) ? (Number(st.ul) / 1000).toFixed(1) : '?';
    return 'Auto: ↓' + dlM + ' ↑' + ulM + ' Mb/s' + (st.ts ? ' (' + fmtAgo(st.ts) + ')' : '');
};

return view.extend({
    speedChart: null,
    lastBytes: null,
    status: null,
    wanIface: 'wan',
    callIfaceStatus: null,
    _pollingStarted: false,

    load: function() {
        var self = this;
        return Promise.all([
            uci.load('myhelper'),
            callStatus().then(function(r) { self.status = r || {}; }).catch(function() { self.status = {}; })
        ]).then(function() {
            self.wanIface = uci.get('myhelper', 'settings', 'wan_iface') || 'wan';
            self.callIfaceStatus = rpc.declare({
                object: 'network.interface.' + self.wanIface,
                method: 'status'
            });
        });
    },

    render: function() {
        var self = this;
        var s = this.status || {};

        var gbEnabled = uci.get('myhelper', 'settings', 'enabled') === '1';

        var preset   = uci.get('myhelper', 'settings', 'qos_preset')         || 'balanced';
        var bwDown   = uci.get('myhelper', 'settings', 'bandwidth_download') || '0';
        var bwUp     = uci.get('myhelper', 'settings', 'bandwidth_upload')   || '0';
        var autoStr  = fmtSpeedtest(readSpeedtest());

        var wanPing  = parseLastPing(s, 'history');
        var devPing  = (typeof s.gaming_ip === 'string' && s.gaming_ip.length)
                       ? parseLastPing(s, 'history_device') : null;
        var gamingIp = (typeof s.gaming_ip === 'string' && s.gaming_ip.length) ? s.gaming_ip : null;

        var internetOn = Number(s.internet) === 1;
        var failCnt    = Number(s.fail_count)     || 0;
        var threshold  = Number(s.threshold)      || 0;
        var interval   = Number(s.interval)       || 0;
        var uptime     = Number(s.uptime)         || 0;
        var recCnt     = Number(s.recovery_count) || 0;
        var lastRec    = Number(s.last_recovery)  || 0;
        var recState   = Number(s.recovery_state) || 0;

        var css = E('style', {}, `
            .myhelper-dashboard {
                --space-bg: #0b001a;
                --bg-panel: rgba(14, 16, 24, 0.65);
                --accent-gold: #f5c451;
                --accent-red: #ff3333;
                --accent-blue: #00d2ff;
                --accent-green: #22c55e;
                --text-main: #e2e8f0;
                --text-muted: #94a3b8;
                background-color: var(--space-bg);
                background-image:
                    radial-gradient(circle at 15% 25%, rgba(168, 85, 247, 0.4) 0%, transparent 40%),
                    radial-gradient(circle at 85% 75%, rgba(59, 130, 246, 0.35) 0%, transparent 45%),
                    linear-gradient(135deg, #05050a 0%, #1e0b36 50%, #05050a 100%);
                color: var(--text-main);
                padding: 20px;
                border-radius: 8px;
                font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            }
            .myhelper-dashboard .dashboard-grid { display: grid; grid-template-columns: 1fr; gap: 15px; }
            @media (min-width: 800px) { .myhelper-dashboard .dashboard-grid { grid-template-columns: 1.2fr 1fr; } }
            .myhelper-dashboard .panel {
                background: var(--bg-panel); backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px;
                padding: 15px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            }
            .myhelper-dashboard .panel-header {
                display: flex; align-items: center; gap: 8px; margin-bottom: 15px;
                font-size: 14px; font-weight: bold; color: var(--accent-gold); text-transform: uppercase;
            }
            .myhelper-dashboard .status-row {
                display: flex; justify-content: space-between; padding: 6px 0;
                border-bottom: 1px solid rgba(255,255,255,0.08);
            }
            .myhelper-dashboard .label-internet { color: #00ffcc; font-weight: bold; }
            .myhelper-dashboard .label-ping { color: var(--accent-gold); font-weight: bold; }
            .myhelper-dashboard .badge-online { background: rgba(34, 197, 94, 0.15); color: var(--accent-green); padding: 2px 6px; border-radius: 4px; font-size: 10px; }
            .myhelper-dashboard .badge-offline { background: rgba(255, 51, 51, 0.15); color: var(--accent-red); padding: 2px 6px; border-radius: 4px; font-size: 10px; }
            .myhelper-dashboard .chart-container { height: 100px; width: 100%; background: rgba(0,0,0,0.5); border-radius: 4px; margin-top: 10px; }
            .myhelper-dashboard .btn {
                padding: 8px 12px; border-radius: 4px; border: none; font-weight: bold; cursor: pointer; font-size: 11px; text-transform: uppercase;
            }
            .myhelper-dashboard .btn-primary { background: var(--accent-red); color: #fff; box-shadow: 0 0 10px rgba(255, 51, 51, 0.4); }
            .myhelper-dashboard .btn-outline { background: transparent; border: 1px solid var(--accent-blue); color: var(--accent-blue); }
            .myhelper-dashboard .toggle-switch {
                position: relative; width: 36px; height: 18px; background: rgba(255,255,255,0.15); border-radius: 18px; cursor: pointer; transition: 0.3s;
            }
            .myhelper-dashboard .toggle-switch::after {
                content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: white; border-radius: 50%; transition: 0.3s;
            }
            .myhelper-dashboard .toggle-switch.active { background: var(--accent-green); box-shadow: 0 0 10px rgba(34, 197, 94, 0.6); }
            .myhelper-dashboard .toggle-switch.active::after { transform: translateX(18px); }
            .myhelper-dashboard .auto-line { font-size: 10px; color: var(--text-muted); margin-top: 4px; }
            .myhelper-dashboard .watchdog-grid {
                display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px;
                font-size: 10px; color: var(--text-muted);
                border-top: 1px solid rgba(255,255,255,0.08);
                padding-top: 10px; margin-top: 10px;
            }
            .myhelper-dashboard .watchdog-grid b { color: var(--text-main); font-weight: 600; }
            .myhelper-dashboard .recovery-line {
                font-size: 10px; color: var(--accent-gold); font-weight: bold;
                margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;
            }
        `);

        var dashboard = E('div', { 'class': 'myhelper-dashboard' }, [
            E('div', { 'class': 'dashboard-grid' }, [
                E('div', {}, [
                    E('div', { 'class': 'panel' }, [
                        E('div', { 'class': 'panel-header' }, 'LIVE STATUS'),
                        E('div', { 'class': 'status-row' }, [
                            E('span', { 'class': 'label-internet' }, 'INTERNET'),
                            E('span', { 'class': internetOn ? 'badge-online' : 'badge-offline', 'id': 'dash-badge' },
                                       internetOn ? 'ONLINE' : 'OFFLINE')
                        ]),
                        E('div', { 'class': 'status-row' }, [
                            E('span', { 'class': 'label-ping' }, 'WAN PING'),
                            E('span', { 'id': 'dash-ping' }, wanPing)
                        ]),
                        devPing !== null ? E('div', { 'class': 'status-row' }, [
                            E('span', { 'style': 'color: var(--accent-gold);' }, 'DEVICE PING'),
                            E('span', { 'id': 'dash-devping' }, devPing)
                        ]) : null,
                        gamingIp ? E('div', { 'class': 'status-row' }, [
                            E('span', { 'style': 'color: var(--accent-gold);' }, 'BOOSTED IP'),
                            E('span', { 'id': 'dash-gamingip', 'style': 'font-family: monospace;' }, gamingIp)
                        ]) : null,
                        E('div', { 'class': 'status-row' }, [
                            E('span', { 'style': 'color: var(--accent-blue);' }, 'LIVE SPEED'),
                            E('span', {}, [
                                E('span', { 'id': 'dash-down', 'style': 'color: #00d2ff; font-weight:bold;' }, '↓ 0.00 Mb/s'),
                                ' / ',
                                E('span', { 'id': 'dash-up',   'style': 'color: #ff3333; font-weight:bold;' }, '↑ 0.00 Mb/s')
                            ])
                        ]),
                        E('div', { 'class': 'chart-container', 'id': 'dash-chart-container' }, [
                            E('canvas', { 'id': 'speedChart' })
                        ])
                    ])
                ]),
                E('div', {}, [
                    E('div', { 'class': 'panel' }, [
                        E('div', { 'class': 'panel-header' }, 'GAME BOOST'),
                        E('div', { 'style': 'font-size: 11px; color: #94a3b8; margin-bottom: 4px;' },
                          'Preset: ' + preset.toUpperCase() + ' | Limits: ↓' + bwDown + ' ↑' + bwUp),
                        autoStr ? E('div', { 'class': 'auto-line' }, autoStr) : null,
                        E('div', { 'style': 'display:flex; align-items:center; gap:10px; margin: 15px 0;' }, [
                            E('div', {
                                'class': 'toggle-switch ' + (gbEnabled ? 'active' : ''),
                                'id': 'dash-toggle',
                                'click': ui.createHandlerFn(this, function(ev) {
                                    var el = ev.target;
                                    var willEnable = !el.classList.contains('active');
                                    el.classList.toggle('active');
                                    uci.set('myhelper', 'settings', 'enabled', willEnable ? '1' : '0');
                                    ui.addNotification(null,
                                        E('p', _('Game Boost change pending. Click Save & Apply.')), 'info');
                                })
                            }),
                            E('span', { 'style': 'font-size: 11px; font-weight: bold;' }, 'ENABLE GAME BOOST')
                        ]),
                        E('div', { 'style': 'display: flex; gap: 10px;' }, [
                            E('button', {
                                'class': 'btn btn-primary',
                                'click': ui.createHandlerFn(this, function() {
                                    uci.save()
                                        .then(function() { return callQosReapply(); })
                                        .then(function(r) {
                                            if (!r || Number(r.ok) !== 1) {
                                                throw new Error('qos_reapply failed (ok=' +
                                                                (r && r.ok) + ', rc=' + (r && r.rc) + ')');
                                            }
                                            return callStatus();
                                        })
                                        .then(function(res) {
                                            self.status = res || {};
                                            var tEl = document.getElementById('dash-toggle');
                                            if (tEl) tEl.classList.toggle('active',
                                                uci.get('myhelper', 'settings', 'enabled') === '1');
                                            self.refreshStatusFields();
                                            ui.addNotification(null,
                                                E('p', _('Configuration saved and applied.')), 'info');
                                        })
                                        .catch(function(err) {
                                            console.error('[myhelper] apply failed:', err);
                                            ui.addNotification(null,
                                                E('p', _('Apply failed: ') + (err && err.message ? err.message : err)),
                                                'danger');
                                        });
                                })
                            }, 'SAVE & APPLY'),
                            E('button', {
                                'class': 'btn btn-outline',
                                'click': ui.createHandlerFn(this, function() {
                                    if (confirm(_('Force WAN Recovery?'))) {
                                        callForceRecovery()
                                            .then(function(r) {
                                                if (!r || Number(r.ok) !== 1) {
                                                    if (r && Number(r.busy) === 1)
                                                        throw new Error(_('Recovery already in progress'));
                                                    throw new Error('force_recovery not acknowledged');
                                                }
                                                ui.addNotification(null,
                                                    E('p', _('Recovery started. Total: ') +
                                                      (r.recovery_count || '?') + ' run(s).'),
                                                    'warning');
                                                return callStatus();
                                            })
                                            .then(function(res) {
                                                if (res) {
                                                    self.status = res;
                                                    self.refreshStatusFields();
                                                }
                                            })
                                            .catch(function(err) {
                                                ui.addNotification(null,
                                                    E('p', _('Recovery failed: ') +
                                                      (err && err.message ? err.message : err)),
                                                    'danger');
                                            });
                                    }
                                })
                            }, 'FORCE RECOVERY')
                        ]),

                        E('div', { 'class': 'watchdog-grid' }, [
                            E('span', {}, ['Interval: ', E('b', { 'id': 'dash-interval' }, interval + 's')]),
                            E('span', {}, ['Fail: ',     E('b', { 'id': 'dash-fail' },     failCnt + ' / ' + threshold)]),
                            E('span', {}, ['Uptime: ',   E('b', { 'id': 'dash-uptime' },   fmtUptime(uptime))]),
                            E('span', {}, ['Recoveries: ', E('b', { 'id': 'dash-reccnt' }, String(recCnt))]),
                            E('span', { 'style': 'grid-column: 1 / -1;' },
                              ['Last recovery: ', E('b', { 'id': 'dash-lastrec' }, fmtAgo(lastRec))])
                        ]),
                        E('div', {
                            'class': 'recovery-line',
                            'id': 'dash-recstate',
                            'style': recState !== 0 ? '' : 'display:none;'
                        }, 'RECOVERY: ' + (RECOVERY_STATE_LABEL[recState] || '?'))
                    ])
                ])
            ])
        ]);

        var root = E('div', {}, [css, dashboard]);

        requestAnimationFrame(function() {
            loadChartScript().then(function() {
                var cv = document.getElementById('speedChart');
                if (!cv) return;
                var MAX = 30;
                self.speedChart = new Chart(cv.getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: new Array(MAX).fill(''),
                        datasets: [
                            { label: 'Down', data: new Array(MAX).fill(0), borderColor: '#00d2ff', backgroundColor: 'rgba(0,210,255,0.1)', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true },
                            { label: 'Up',   data: new Array(MAX).fill(0), borderColor: '#ff3333', backgroundColor: 'rgba(255,51,51,0.1)',   borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true }
                        ]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
                        plugins: { legend: { display: false } },
                        scales: { x: { display: false }, y: { display: false, min: 0, suggestedMax: 15 } },
                        layout: { padding: 0 }
                    }
                });
            }).catch(function(err) {
                console.error('[myhelper] Chart.js load failed:', err);
                // Replace canvas with explicit "unavailable" message so the user
                // doesn't see a silent black box.
                var container = document.getElementById('dash-chart-container');
                if (container) {
                    container.innerHTML = '';
                    container.appendChild(E('div', {
                        'style': 'display:flex; align-items:center; justify-content:center; ' +
                                 'height:100%; color:#ff3333; font-size:10px; ' +
                                 'text-align:center; padding: 4px; line-height: 1.3;'
                    }, 'Chart unavailable (chart.umd.min.js not found)'));
                }
            });
        });

        if (!this._pollingStarted) {
            this._pollingStarted = true;
            this.startPolling();
        }

        return root;
    },

    refreshStatusFields: function() {
        var s = this.status || {};
        var setText = function(id, txt) {
            var el = document.getElementById(id);
            if (el) el.innerText = txt;
        };
        setText('dash-ping',     parseLastPing(s, 'history'));
        setText('dash-devping',  parseLastPing(s, 'history_device'));
        setText('dash-gamingip', s.gaming_ip || '—');
        setText('dash-interval', (Number(s.interval) || 0) + 's');
        setText('dash-fail',     (Number(s.fail_count) || 0) + ' / ' + (Number(s.threshold) || 0));
        setText('dash-uptime',   fmtUptime(s.uptime));
        setText('dash-reccnt',   String(Number(s.recovery_count) || 0));
        setText('dash-lastrec',  fmtAgo(s.last_recovery));

        var internetOn = Number(s.internet) === 1;
        var badge = document.getElementById('dash-badge');
        if (badge) {
            badge.className = internetOn ? 'badge-online' : 'badge-offline';
            badge.innerText = internetOn ? 'ONLINE' : 'OFFLINE';
        }

        var recState = Number(s.recovery_state) || 0;
        var recEl = document.getElementById('dash-recstate');
        if (recEl) {
            if (recState !== 0) {
                recEl.style.display = '';
                recEl.innerText = 'RECOVERY: ' + (RECOVERY_STATE_LABEL[recState] || '?');
            } else {
                recEl.style.display = 'none';
            }
        }
    },

    startPolling: function() {
        var self = this;

        // Fast: WAN counters, 1s
        poll.add(function() {
            if (!document.getElementById('speedChart')) return Promise.resolve();
            if (!self.callIfaceStatus) return Promise.resolve();

            return self.callIfaceStatus().then(function(res) {
                if (!res || !res.statistics) return;

                var now = Date.now();
                var rx  = Number(res.statistics.rx_bytes) || 0;
                var tx  = Number(res.statistics.tx_bytes) || 0;

                if (self.lastBytes) {
                    var dt = (now - self.lastBytes.time) / 1000;
                    if (dt > 0) {
                        var rxMbps = ((rx - self.lastBytes.rx) * 8 / 1e6 / dt);
                        var txMbps = ((tx - self.lastBytes.tx) * 8 / 1e6 / dt);
                        if (!Number.isFinite(rxMbps) || rxMbps < 0) rxMbps = 0;
                        if (!Number.isFinite(txMbps) || txMbps < 0) txMbps = 0;

                        var dEl = document.getElementById('dash-down');
                        var uEl = document.getElementById('dash-up');
                        if (dEl) dEl.innerText = '↓ ' + rxMbps.toFixed(2) + ' Mb/s';
                        if (uEl) uEl.innerText = '↑ ' + txMbps.toFixed(2) + ' Mb/s';

                        var c = self.speedChart;
                        if (c) {
                            c.data.datasets[0].data.shift(); c.data.datasets[0].data.push(rxMbps);
                            c.data.datasets[1].data.shift(); c.data.datasets[1].data.push(txMbps);

                            // Auto-scale y based on max of last 15 samples
                            // (recent window, robust to single-sample spikes),
                            // floor at 15 Mb/s so idle state still looks sane.
                            var d0 = c.data.datasets[0].data, d1 = c.data.datasets[1].data;
                            var start = Math.max(0, d0.length - 15);
                            var maxRecent = 0;
                            for (var i = start; i < d0.length; i++) {
                                if (d0[i] > maxRecent) maxRecent = d0[i];
                                if (d1[i] > maxRecent) maxRecent = d1[i];
                            }
                            c.options.scales.y.suggestedMax = Math.max(15, maxRecent * 1.2);

                            c.update();
                        }
                    }
                }
                self.lastBytes = { rx: rx, tx: tx, time: now };
            }).catch(function() { /* transient WAN down */ });
        }, POLL_STATS);

        // Slow: daemon status, 5s
        poll.add(function() {
            if (!document.getElementById('speedChart')) return Promise.resolve();
            return callStatus().then(function(res) {
                self.status = res || {};
                self.refreshStatusFields();
            }).catch(function() { /* daemon temporarily unavailable */ });
        }, POLL_STATUS);
    }
});
