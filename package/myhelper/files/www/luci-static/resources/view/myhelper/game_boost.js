'use strict';
'require view';
'require uci';
'require rpc';
'require ui';
'require dom';
'require poll';

// --- Module-level RPC declarations (stable methods) ---
var callStatus        = rpc.declare({ object: 'myhelper', method: 'status' });
var callForceRecovery = rpc.declare({ object: 'myhelper', method: 'force_recovery' });
var callQosReapply    = rpc.declare({ object: 'myhelper', method: 'qos_reapply' });
var callDhcpLeases    = rpc.declare({ object: 'dhcp', method: 'ipv4leases' });

// Poll intervals (seconds)
var POLL_STATS  = 1;   // WAN rx/tx counters
var POLL_STATUS = 5;   // daemon status (heavy: history array)

// Module-level guard: register poll handlers exactly once per page lifetime.
var _pollRegistered = false;

// Lazy Chart.js loader (local copy under luci-static/resources/view/myhelper/)
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

// Contract: status.history[N] = { ok: bool, rtt_us: int }
// Defensive: any shape mismatch (NaN/undefined/null/negative) → 'err'.
var parseLastPing = function(s) {
    if (!s || !Array.isArray(s.history) || s.history.length === 0) return '---';
    var last = s.history[s.history.length - 1];
    if (!last || last.ok !== true) return 'timeout';
    var rtt = Number(last.rtt_us);
    if (!Number.isFinite(rtt) || rtt < 0) return 'err';
    return (rtt / 1000).toFixed(0) + ' ms';
};

// UCI field is `myhelper.settings.enabled` (confirmed from init script).
// Daemon may echo it back as `enabled`, `qos_enabled` or `game_boost` — try all.
// Returns null if unknown → caller falls back to UCI.
var parseDaemonEnabled = function(s) {
    if (!s) return null;
    if (typeof s.enabled     === 'boolean') return s.enabled;
    if (typeof s.qos_enabled === 'boolean') return s.qos_enabled;
    if (typeof s.game_boost  === 'boolean') return s.game_boost;
    return null;
};

var syncToggleFromDaemon = function(enabled) {
    if (enabled === null) return;
    var el = document.getElementById('dash-toggle');
    if (!el) return;
    if (enabled) el.classList.add('active');
    else         el.classList.remove('active');
};

// Speedtest stored in settings.* (after shell fix) — fallback to legacy
// game_boost.* section for routers that ran the old speedtest() once.
var readSpeedtest = function() {
    var dl = uci.get('myhelper', 'settings', 'speedtest_download')
          || uci.get('myhelper', 'game_boost', 'speedtest_download');
    var ul = uci.get('myhelper', 'settings', 'speedtest_upload')
          || uci.get('myhelper', 'game_boost', 'speedtest_upload');
    var ts = uci.get('myhelper', 'settings', 'speedtest_timestamp')
          || uci.get('myhelper', 'game_boost', 'speedtest_timestamp');
    return { dl: dl, ul: ul, ts: ts };
};

var fmtSpeedtest = function(st) {
    if (!st || (!st.dl && !st.ul)) return null;
    var dlM = (Number(st.dl) > 0) ? (Number(st.dl) / 1000).toFixed(1) : '?';
    var ulM = (Number(st.ul) > 0) ? (Number(st.ul) / 1000).toFixed(1) : '?';
    var ago = '';
    if (st.ts) {
        var sec = Math.max(0, Math.floor(Date.now() / 1000) - Number(st.ts));
        if (Number.isFinite(sec)) {
            ago = (sec < 3600)
                ? ' (' + Math.floor(sec / 60) + ' min ago)'
                : ' (' + Math.floor(sec / 3600) + ' h ago)';
        }
    }
    return 'Auto: ↓' + dlM + ' ↑' + ulM + ' Mb/s' + ago;
};

return view.extend({
    speedChart: null,
    lastBytes: null,
    status: null,
    leases: null,
    wanIface: 'wan',
    callIfaceStatus: null,
    _pendingToggle: false,   // user toggled → Save & Apply not yet confirmed

    load: function() {
        var self = this;
        return Promise.all([
            uci.load('myhelper'),
            callStatus().then(function(r) { self.status = r || {}; }).catch(function() { self.status = {}; }),
            callDhcpLeases().then(function(r) { self.leases = r || {}; }).catch(function() { self.leases = {}; })
        ]).then(function() {
            // Dynamically bind WAN interface RPC — UCI may have renamed it.
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

        // Prefer daemon's real state, fall back to UCI.
        var daemonEn = parseDaemonEnabled(s);
        var gbEnabled = (daemonEn !== null)
            ? daemonEn
            : (uci.get('myhelper', 'settings', 'enabled') === '1');

        var preset   = uci.get('myhelper', 'settings', 'qos_preset')        || 'balanced';
        var bwDown   = uci.get('myhelper', 'settings', 'bandwidth_download')|| '0';
        var bwUp     = uci.get('myhelper', 'settings', 'bandwidth_upload')  || '0';
        var lastPing = parseLastPing(s);
        var autoStr  = fmtSpeedtest(readSpeedtest());

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
        `);

        var dashboard = E('div', { 'class': 'myhelper-dashboard' }, [
            E('div', { 'class': 'dashboard-grid' }, [
                // LEFT COLUMN
                E('div', {}, [
                    E('div', { 'class': 'panel' }, [
                        E('div', { 'class': 'panel-header' }, 'LIVE STATUS'),
                        E('div', { 'class': 'status-row' }, [
                            E('span', { 'class': 'label-internet' }, 'INTERNET'),
                            E('span', { 'class': 'badge-online' }, s.internet ? 'ONLINE' : 'OFFLINE')
                        ]),
                        E('div', { 'class': 'status-row' }, [
                            E('span', { 'class': 'label-ping' }, 'CURRENT PING'),
                            E('span', { 'id': 'dash-ping', 'class': 'text-yellow' }, lastPing)
                        ]),
                        E('div', { 'class': 'status-row' }, [
                            E('span', { 'style': 'color: var(--accent-blue);' }, 'LIVE SPEED'),
                            E('span', {}, [
                                E('span', { 'id': 'dash-down', 'style': 'color: #00d2ff; font-weight:bold;' }, '↓ 0.00 Mb/s'),
                                ' / ',
                                E('span', { 'id': 'dash-up',   'style': 'color: #ff3333; font-weight:bold;' }, '↑ 0.00 Mb/s')
                            ])
                        ]),
                        E('div', { 'class': 'chart-container' }, [
                            E('canvas', { 'id': 'speedChart' })
                        ])
                    ])
                ]),
                // RIGHT COLUMN
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
                                    self._pendingToggle = true;
                                    uci.set('myhelper', 'settings', 'enabled', willEnable ? '1' : '0');
                                    ui.addNotification(null, E('p', _('Game Boost change pending. Click Save & Apply.')), 'info');
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
                                        .then(function() { return callStatus(); })
                                        .then(function(res) {
                                            self.status = res || {};
                                            self._pendingToggle = false;
                                            syncToggleFromDaemon(parseDaemonEnabled(self.status));
                                            var pingEl = document.getElementById('dash-ping');
                                            if (pingEl) pingEl.innerText = parseLastPing(self.status);
                                            ui.addNotification(null, E('p', _('Configuration applied.')), 'info');
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
                                        callForceRecovery().then(function() {
                                            ui.addNotification(null, E('p', _('Recovery triggered.')), 'warning');
                                        }).catch(function(err) {
                                            ui.addNotification(null,
                                                E('p', _('Recovery failed: ') + (err && err.message ? err.message : err)),
                                                'danger');
                                        });
                                    }
                                })
                            }, 'FORCE RECOVERY')
                        ])
                    ])
                ])
            ])
        ]);

        var root = E('div', {}, [css, dashboard]);

        // Chart.js init — after canvas is committed to DOM.
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
            });
        });

        if (!_pollRegistered) {
            _pollRegistered = true;
            this.startPolling();
        }

        return root;
    },

    startPolling: function() {
        var self = this;

        // ---- FAST POLL: WAN rx/tx counters, 1s ----
        poll.add(function() {
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
                        // Counter wrap/reset → negative rate. Clamp to 0.
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
                            c.update();
                        }
                    }
                }
                self.lastBytes = { rx: rx, tx: tx, time: now };
            }).catch(function() { /* transient WAN down — ignore */ });
        }, POLL_STATS);

        // ---- SLOW POLL: daemon status, 5s ----
        poll.add(function() {
            return callStatus().then(function(res) {
                self.status = res || {};

                var pingEl = document.getElementById('dash-ping');
                if (pingEl) pingEl.innerText = parseLastPing(self.status);

                // Only sync toggle when user has no unapplied change.
                // Catches daemon self-recovery, watchdog rollback, external CLI.
                if (!self._pendingToggle) {
                    syncToggleFromDaemon(parseDaemonEnabled(self.status));
                }
            }).catch(function() { /* daemon temporarily unavailable */ });
        }, POLL_STATUS);
    }
}); 
