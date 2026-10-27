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
var callSpeedtest     = rpc.declare({ object: 'myhelper', method: 'speedtest' });
var callDhcpLeases    = rpc.declare({ object: 'dhcp', method: 'ipv4leases' });

var POLL_STATS  = 1;
var POLL_STATUS = 5;

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

var fmtClock = function(ts) {
    ts = Number(ts) || 0;
    if (ts <= 0) return '—';
    var d = new Date(ts * 1000);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
};

var RECOVERY_STATE_LABEL = ['idle', 'down', 'delay', 'up', 'ifup'];
var EVENT_TYPE_LABEL = {
    1: { txt: 'PROBE OK',   cls: 'ev-ok' },
    2: { txt: 'PROBE FAIL', cls: 'ev-fail' },
    3: { txt: 'RECOVERY',   cls: 'ev-warn' },
    4: { txt: 'RECOVERED',  cls: 'ev-ok' },
    5: { txt: 'QOS OK',     cls: 'ev-ok' },
    6: { txt: 'QOS FAIL',   cls: 'ev-fail' },
    7: { txt: 'SPEEDTEST',  cls: 'ev-info' },
    8: { txt: 'SPEED OK',   cls: 'ev-ok' },
    9: { txt: 'SPEED FAIL', cls: 'ev-fail' }
};

var getGbEnabled = function() {
    var v = uci.get('myhelper', 'settings', 'game_boost_enabled');
    if (v === null || v === undefined) v = uci.get('myhelper', 'settings', 'enabled');
    return v === '1';
};

var readSpeedtest = function() {
    return {
        dl: uci.get('myhelper', 'settings', 'speedtest_download'),
        ul: uci.get('myhelper', 'settings', 'speedtest_upload'),
        ts: uci.get('myhelper', 'settings', 'speedtest_timestamp')
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
    chartMode: 'speed',
    lastBytes: null,
    status: null,
    leases: null,
    wanIface: 'wan',
    callIfaceStatus: null,
    _pollingStarted: false,

    load: function() {
        var self = this;
        return Promise.all([
            uci.load('myhelper'),
            callStatus().then(function(r) { self.status = r || {}; }).catch(function() { self.status = {}; }),
            callDhcpLeases().then(function(r) { self.leases = r || {}; }).catch(function() { self.leases = {}; })
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

        var gbEnabled = getGbEnabled();
        var preset    = uci.get('myhelper', 'settings', 'qos_preset') || 'balanced';
        var autoStr   = fmtSpeedtest(readSpeedtest());

        // Подсчет устройств из DHCP
        var deviceCount = 0;
        var deviceRows = [];
        if (self.leases && self.leases.device) {
            Object.keys(self.leases.device).forEach(function(dev) {
                if (self.leases.device[dev].leases) {
                    self.leases.device[dev].leases.forEach(function(l) {
                        deviceCount++;
                        deviceRows.push(E('tr', {}, [
                            E('td', {}, E('span', { 'class': 'dot dot-green' })),
                            E('td', {}, l.hostname || '?'),
                            E('td', {}, l.macaddr),
                            E('td', { 'class': 'text-blue' }, l.ipaddr)
                        ]));
                    });
                }
            });
        }
        if (deviceRows.length === 0) {
            deviceRows.push(E('tr', {}, [E('td', { 'colspan': 4, 'style': 'text-align:center; color:#94a3b8;' }, 'No active leases')]));
        }

        var internetBadgeTxt = Number(s.internet) === 1 ? 'ONLINE (' + deviceCount + ')' : 'OFFLINE';

        var css = E('style', {}, `
            .myhelper-dashboard {
                --space-bg: #0b001a;
                --bg-panel: rgba(14, 16, 24, 0.7);
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
                    radial-gradient(circle at 50% 10%, rgba(236, 72, 153, 0.2) 0%, transparent 35%),
                    linear-gradient(135deg, #05050a 0%, #1e0b36 50%, #05050a 100%);
                background-attachment: fixed;
                color: var(--text-main);
                padding: 20px;
                border-radius: 8px;
                font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                position: relative;
                overflow: hidden;
                min-height: 80vh;
            }
            /* Звезды на фоне */
            .myhelper-dashboard::before {
                content: ""; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                background-image: 
                    radial-gradient(1px 1px at 10% 20%, #fff, transparent),
                    radial-gradient(1px 1px at 30% 60%, #fff, transparent),
                    radial-gradient(1px 1px at 50% 10%, #fff, transparent),
                    radial-gradient(1.5px 1.5px at 75% 15%, #ec4899, transparent);
                background-size: 200px 200px, 300px 300px, 250px 250px, 450px 450px;
                opacity: 0.6; z-index: 0; pointer-events: none;
            }
            .myhelper-dashboard .content-wrapper { position: relative; z-index: 1; }
            
            .myhelper-dashboard .dashboard-grid { display: grid; grid-template-columns: 1fr; gap: 15px; }
            @media (min-width: 900px) { .myhelper-dashboard .dashboard-grid { grid-template-columns: 1.5fr 1fr; } }
            
            .myhelper-dashboard .col { display: flex; flex-direction: column; gap: 15px; }
            
            .myhelper-dashboard .panel {
                background: var(--bg-panel); backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px;
                padding: 15px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            }
            .myhelper-dashboard .panel-header {
                display: flex; align-items: center; gap: 8px; margin-bottom: 15px;
                font-size: 14px; font-weight: bold; color: var(--accent-gold); text-transform: uppercase;
                letter-spacing: 1px; text-shadow: 0 0 8px rgba(245, 196, 81, 0.4);
            }
            .myhelper-dashboard .status-row {
                display: flex; justify-content: space-between; padding: 6px 0;
                border-bottom: 1px solid rgba(255,255,255,0.08); align-items: center; font-size: 12px;
            }
            
            .myhelper-dashboard .label-internet { color: #00ffcc; font-weight: bold; }
            .myhelper-dashboard .label-cake { color: #d946ef; font-weight: bold; }
            .myhelper-dashboard .label-ping { color: var(--accent-gold); font-weight: bold; }
            .myhelper-dashboard .label-speed { color: var(--accent-blue); font-weight: bold; }
            
            .myhelper-dashboard .badge-online { background: rgba(34, 197, 94, 0.15); color: var(--accent-green); padding: 2px 6px; border-radius: 4px; font-size: 10px; border: 1px solid rgba(34,197,94,0.3);}
            .myhelper-dashboard .badge-offline { background: rgba(255, 51, 51, 0.15); color: var(--accent-red); padding: 2px 6px; border-radius: 4px; font-size: 10px; border: 1px solid rgba(255,51,51,0.3);}
            
            .myhelper-dashboard .chart-header {
                display: flex; justify-content: space-between; align-items: center;
                font-size: 10px; color: var(--text-muted); text-transform: uppercase; margin-top: 10px; margin-bottom: 4px;
            }
            .myhelper-dashboard .chart-modes { display: flex; gap: 4px; }
            .myhelper-dashboard .chart-mode-btn {
                padding: 2px 6px; font-size: 9px; border-radius: 3px; background: transparent;
                border: 1px solid rgba(255,255,255,0.15); color: var(--text-muted); cursor: pointer;
            }
            .myhelper-dashboard .chart-mode-btn.active { background: rgba(0,210,255,0.15); border-color: var(--accent-blue); color: var(--accent-blue); }
            .myhelper-dashboard .chart-container { height: 100px; width: 100%; background: rgba(0,0,0,0.5); border-radius: 4px; border: 1px solid rgba(255,255,255,0.05); }
            
            .myhelper-dashboard table { width: 100%; border-collapse: collapse; font-size: 11px; }
            .myhelper-dashboard th, .myhelper-dashboard td { padding: 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
            .myhelper-dashboard th { color: var(--accent-blue); font-weight: bold; text-transform: uppercase; }
            .myhelper-dashboard .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
            .myhelper-dashboard .dot-green { background: var(--accent-green); box-shadow: 0 0 5px var(--accent-green); }

            .myhelper-dashboard .btn {
                padding: 8px 12px; border-radius: 4px; border: none; font-weight: bold; cursor: pointer; font-size: 11px; text-transform: uppercase; transition: 0.2s;
            }
            .myhelper-dashboard .btn-primary { background: var(--accent-red); color: #fff; box-shadow: 0 0 10px rgba(255, 51, 51, 0.4); }
            .myhelper-dashboard .btn-outline { background: transparent; border: 1px solid var(--accent-blue); color: var(--accent-blue); }
            .myhelper-dashboard .btn-auto { background: transparent; border: 1px solid var(--accent-gold); color: var(--accent-gold); }
            
            .myhelper-dashboard .toggle-switch {
                position: relative; width: 36px; height: 18px; background: rgba(255,255,255,0.15); border-radius: 18px; cursor: pointer; transition: 0.3s;
            }
            .myhelper-dashboard .toggle-switch::after {
                content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: white; border-radius: 50%; transition: 0.3s;
            }
            .myhelper-dashboard .toggle-switch.active { background: var(--accent-green); box-shadow: 0 0 10px rgba(34, 197, 94, 0.6); }
            .myhelper-dashboard .toggle-switch.active::after { transform: translateX(18px); }

            .myhelper-dashboard .game-on-banner {
                position: relative; background: linear-gradient(180deg, rgba(14, 16, 24, 0) 0%, rgba(14, 16, 24, 0.9) 100%);
                border: 1px solid var(--accent-gold); text-align: center; padding: 30px 10px 15px;
                border-radius: 8px; overflow: hidden; box-shadow: inset 0 0 20px rgba(245, 196, 81, 0.1);
            }
            .myhelper-dashboard .cityscape { position: absolute; bottom: 0; left: 0; width: 100%; height: 75%; z-index: 0; opacity: 1; }
            .myhelper-dashboard .game-on-content { position: relative; z-index: 1; }
            .myhelper-dashboard .game-on-title { font-size: 28px; font-weight: 900; color: var(--accent-gold); text-shadow: 0 0 10px rgba(245, 196, 81, 0.8), 0 0 20px var(--accent-red); letter-spacing: 2px; line-height: 1; }
            .myhelper-dashboard .game-on-sub { font-size: 8px; color: var(--accent-gold); letter-spacing: 1px; margin-top: 5px; font-weight: bold; opacity: 0.8; }

            .myhelper-dashboard .watchdog-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; font-size: 10px; color: var(--text-muted); border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px; margin-top: 10px; }
            .myhelper-dashboard .watchdog-grid b { color: var(--text-main); }
            .myhelper-dashboard details.events-block { font-size: 10px; color: var(--text-muted); border-top: 1px solid rgba(255,255,255,0.08); padding-top: 8px; margin-top: 8px; }
            .myhelper-dashboard .events-list { max-height: 120px; overflow-y: auto; font-family: monospace; margin-top: 6px; }
        `);

        var dashboard = E('div', { 'class': 'myhelper-dashboard' }, [
            E('div', { 'class': 'content-wrapper' }, [
                E('div', { 'class': 'dashboard-grid' }, [
                    // ЛЕВАЯ КОЛОНКА
                    E('div', { 'class': 'col' }, [
                        E('div', { 'class': 'panel' }, [
                            E('div', { 'class': 'panel-header' }, 'LIVE STATUS'),
                            E('div', { 'class': 'status-row' }, [
                                E('span', { 'class': 'label-internet' }, 'INTERNET'),
                                E('span', { 'class': Number(s.internet) === 1 ? 'badge-online' : 'badge-offline', 'id': 'dash-badge' }, internetBadgeTxt)
                            ]),
                            E('div', { 'class': 'status-row' }, [
                                E('span', { 'class': 'label-cake' }, 'CAKE PRESET'),
                                E('span', { 'style': 'font-size:10px; color:var(--accent-blue);' }, preset.toUpperCase())
                            ]),
                            E('div', { 'class': 'status-row' }, [
                                E('span', { 'class': 'label-ping' }, 'CURRENT PING'),
                                E('span', { 'id': 'dash-ping', 'class': 'text-yellow', 'style': 'font-weight:bold;' }, parseLastPing(s, 'history'))
                            ]),
                            E('div', { 'class': 'status-row' }, [
                                E('span', { 'class': 'label-speed' }, 'LIVE SPEED'),
                                E('span', {}, [
                                    E('span', { 'id': 'dash-down', 'style': 'color: #00d2ff; font-weight:bold;' }, '↓ 0.00 Mb/s'),
                                    ' / ',
                                    E('span', { 'id': 'dash-up', 'style': 'color: #ff3333; font-weight:bold;' }, '↑ 0.00 Mb/s')
                                ])
                            ]),
                            E('div', { 'class': 'chart-header' }, [
                                E('span', {}, 'TRAFFIC'),
                                E('div', { 'class': 'chart-modes' }, [
                                    E('button', { 'class': 'chart-mode-btn active', 'data-mode': 'speed', 'click': ui.createHandlerFn(this, function(ev) { self.switchChartMode('speed', ev.target); }) }, 'SPEED'),
                                    E('button', { 'class': 'chart-mode-btn', 'data-mode': 'ping_wan', 'click': ui.createHandlerFn(this, function(ev) { self.switchChartMode('ping_wan', ev.target); }) }, 'WAN'),
                                    E('button', { 'class': 'chart-mode-btn', 'data-mode': 'ping_dev', 'click': ui.createHandlerFn(this, function(ev) { self.switchChartMode('ping_dev', ev.target); }) }, 'DEVICE')
                                ])
                            ]),
                            E('div', { 'class': 'chart-container', 'id': 'dash-chart-container' }, [
                                E('canvas', { 'id': 'speedChart' })
                            ])
                        ]),
                        // ПАНЕЛЬ DEVICES
                        E('div', { 'class': 'panel' }, [
                            E('div', { 'class': 'panel-header' }, 'DEVICES'),
                            E('div', { 'class': 'table-wrapper', 'id': 'devices-table-container' }, [
                                E('table', {}, [
                                    E('thead', {}, [
                                        E('tr', {}, [
                                            E('th', {}, 'STATUS'),
                                            E('th', {}, 'HOSTNAME'),
                                            E('th', {}, 'MAC'),
                                            E('th', {}, 'IP')
                                        ])
                                    ]),
                                    E('tbody', {}, deviceRows)
                                ])
                            ])
                        ])
                    ]),
                    // ПРАВАЯ КОЛОНКА
                    E('div', { 'class': 'col' }, [
                        E('div', { 'class': 'panel' }, [
                            E('div', { 'class': 'panel-header' }, 'GAME BOOST'),
                            E('div', { 'style': 'font-size: 10px; color: var(--accent-blue); margin-bottom: 15px; letter-spacing: 0.5px;' }, 'TRAFFIC SHAPING FOR GAMING DEVICES.'),
                            E('div', { 'style': 'display:flex; align-items:center; gap:10px; margin-bottom: 15px;' }, [
                                E('div', {
                                    'class': 'toggle-switch ' + (gbEnabled ? 'active' : ''),
                                    'id': 'dash-toggle',
                                    'click': ui.createHandlerFn(this, function(ev) {
                                        var el = ev.target;
                                        var willEnable = !el.classList.contains('active');
                                        el.classList.toggle('active');
                                        uci.set('myhelper', 'settings', 'game_boost_enabled', willEnable ? '1' : '0');
                                        ui.addNotification(null, E('p', _('Game Boost change pending. Click Save & Apply.')), 'info');
                                    })
                                }),
                                E('span', { 'style': 'font-size: 11px; font-weight: bold;' }, 'ENABLE GAME BOOST')
                            ]),
                            E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 15px;' }, [
                                E('button', {
                                    'class': 'btn btn-primary',
                                    'click': ui.createHandlerFn(this, function() {
                                        uci.save().then(function() { return callQosReapply(); }).then(function(r) {
                                            if (!r || Number(r.ok) !== 1) throw new Error('qos_reapply failed');
                                            return callStatus();
                                        }).then(function(res) {
                                            self.status = res || {};
                                            ui.addNotification(null, E('p', _('Configuration saved and applied.')), 'info');
                                        }).catch(function(err) {
                                            ui.addNotification(null, E('p', _('Apply failed: ') + err.message), 'danger');
                                        });
                                    })
                                }, 'SAVE & APPLY'),
                                E('button', {
                                    'class': 'btn btn-outline',
                                    'click': ui.createHandlerFn(this, function() {
                                        if (confirm(_('Force WAN Recovery?'))) {
                                            callForceRecovery().then(function() {
                                                ui.addNotification(null, E('p', _('Recovery triggered.')), 'warning');
                                            });
                                        }
                                    })
                                }, 'FORCE RECOVERY'),
                                E('button', {
                                    'class': 'btn btn-auto',
                                    'id': 'dash-speedtest-btn',
                                    'click': ui.createHandlerFn(this, function(ev) {
                                        var btn = ev.target;
                                        btn.disabled = true; btn.innerText = 'RUNNING...';
                                        callSpeedtest().then(function(r) {
                                            if (!r || Number(r.ok) !== 1) throw new Error('Busy or failed');
                                            ui.addNotification(null, E('p', _('Speedtest started. Takes up to 2 min.')), 'info');
                                        }).catch(function(err) {
                                            btn.disabled = false; btn.innerText = 'AUTO SPEEDTEST';
                                            ui.addNotification(null, E('p', _('Speedtest error: ') + err.message), 'danger');
                                        });
                                    })
                                }, 'AUTO SPEEDTEST')
                            ]),
                            E('div', { 'style': 'font-size: 10px; color: var(--accent-gold); margin-bottom: 5px;' }, autoStr || ''),
                            E('div', { 'class': 'watchdog-grid' }, [
                                E('span', {}, ['Interval: ', E('b', {}, Number(s.interval) + 's')]),
                                E('span', {}, ['Uptime: ', E('b', {}, fmtUptime(s.uptime))]),
                                E('span', {}, ['Recoveries: ', E('b', {}, String(Number(s.recovery_count) || 0))])
                            ]),
                            E('details', { 'class': 'events-block' }, [
                                E('summary', {}, 'RECENT EVENTS'),
                                E('div', { 'class': 'events-list', 'id': 'dash-events-list' }, [
                                    Array.isArray(s.events) && s.events.length > 0 
                                        ? s.events.map(function(ev) { return E('div', {}, fmtClock(ev.ts) + ' - ' + ev.detail); })
                                        : E('div', {}, 'No events yet')
                                ])
                            ])
                        ]),
                        
                        // GAME ON BANNER
                        E('div', { 'class': 'game-on-banner' }, [
                            E('div', {}, { 'innerHTML': `
                                <svg class="cityscape" viewBox="0 0 600 100" preserveAspectRatio="none">
                                    <g fill="#0a0000" stroke="#ff3333" stroke-width="0.6">
                                        <path d="M0,100 V50 H15 V70 H30 V40 H45 V100" opacity="0.5"/>
                                        <path d="M560,100 V60 H580 V30 H595 V100" opacity="0.5"/>
                                        <path d="M15,100 V70 H25 V80 H35 V55 L38,55 L38,15 L40,15 L40,55 H50 V100" />
                                        <path d="M60,100 V45 H70 V60 H80 V30 L85,30 L85,10 L87,10 L87,30 H90 V100" />
                                        <path d="M110,100 V65 H125 V75 H135 V50 H145 V85 H160 V100" />
                                        <path d="M180,100 V35 H195 V50 H205 V20 L210,20 L210,5 L212,5 L212,20 H215 V100" />
                                        <path d="M240,100 V70 H255 V80 H265 V55 L275,55 L275,35 L277,35 L277,55 H280 V100" />
                                        <path d="M300,100 V25 H315 V45 H325 V15 L330,15 L330,0 L332,0 L332,15 H335 V100" />
                                        <path d="M360,100 V60 H375 V75 H385 V40 L390,40 L390,20 L392,20 L392,40 H395 V100" />
                                        <path d="M420,100 V80 H435 V65 H445 V90 H455 V45 L465,45 L465,30 L467,30 L467,45 H470 V100" />
                                        <path d="M500,100 V55 H515 V70 H525 V35 L530,35 L530,15 L532,15 L532,35 H535 V100" />
                                    </g>
                                    <g fill="#ff0000" opacity="0.9" filter="drop-shadow(0 0 2px #ff0000)">
                                        <rect x="20" y="75" width="3" height="3" /><rect x="28" y="65" width="3" height="5" /><rect x="42" y="60" width="4" height="4" />
                                        <rect x="65" y="50" width="2" height="4" /><rect x="75" y="40" width="2" height="6" /><rect x="85" y="35" width="3" height="3" />
                                        <rect x="115" y="70" width="4" height="3" /><rect x="130" y="60" width="2" height="2" /><rect x="140" y="55" width="3" height="8" />
                                        <rect x="185" y="40" width="4" height="4" /><rect x="195" y="45" width="2" height="2" /><rect x="208" y="25" width="3" height="6" />
                                        <rect x="245" y="75" width="3" height="3" /><rect x="260" y="65" width="4" height="4" /><rect x="272" y="60" width="2" height="2" />
                                        <rect x="305" y="30" width="3" height="5" /><rect x="318" y="35" width="3" height="3" /><rect x="328" y="25" width="4" height="4" />
                                        <rect x="365" y="65" width="2" height="3" /><rect x="378" y="70" width="3" height="3" /><rect x="388" y="50" width="4" height="5" />
                                        <rect x="425" y="85" width="3" height="3" /><rect x="440" y="75" width="3" height="3" /><rect x="460" y="55" width="4" height="4" />
                                        <rect x="505" y="60" width="3" height="4" /><rect x="518" y="65" width="2" height="2" /><rect x="528" y="45" width="4" height="3" />
                                    </g>
                                </svg>
                            `}),
                            E('div', { 'class': 'game-on-content' }, [
                                E('div', { 'class': 'game-on-title' }, 'GAME ON'),
                                E('div', { 'class': 'game-on-sub' }, 'LOW LATENCY. MAX PERFORMANCE.')
                            ])
                        ])
                    ])
                ])
            ])
        ]);

        var root = E('div', {}, [css, dashboard]);

        requestAnimationFrame(function() {
            loadChartScript().then(function() {
                self.createChart('speed');
            }).catch(function(err) {
                console.error('[myhelper] Chart.js load failed:', err);
                var container = document.getElementById('dash-chart-container');
                if (container) {
                    container.innerHTML = '';
                    container.appendChild(E('div', { 'style': 'display:flex; align-items:center; justify-content:center; height:100%; color:#ff3333; font-size:10px; text-align:center;' }, 'Chart unavailable (chart.umd.min.js not found)'));
                }
            });
        });

        if (!this._pollingStarted) {
            this._pollingStarted = true;
            this.startPolling();
        }

        return root;
    },

    createChart: function(mode) {
        var cv = document.getElementById('speedChart');
        if (!cv || !window.Chart) return;
        
        var config;
        if (mode === 'speed') {
            var MAX = 30;
            config = {
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
            };
        } else {
            var s = this.status || {};
            var key = (mode === 'ping_wan') ? 'history' : 'history_device';
            var hist = Array.isArray(s[key]) ? s[key] : [];
            config = {
                type: 'line',
                data: {
                    labels: hist.map(function(_, i) { return String(i); }),
                    datasets: [{
                        data: hist.map(function(sample) { return isOk(sample.ok) ? (Number(sample.rtt_us) / 1000) : null; }),
                        borderColor: (mode === 'ping_wan') ? '#f5c451' : '#00d2ff',
                        backgroundColor: (mode === 'ping_wan') ? 'rgba(245,196,81,0.1)' : 'rgba(0,210,255,0.1)',
                        borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: false, fill: true
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
                    plugins: { legend: { display: false } },
                    scales: { x: { display: false }, y: { display: true, min: 0, ticks: { color: '#94a3b8', font: { size: 9 } } } },
                    layout: { padding: 0 }
                }
            };
        }
        this.speedChart = new Chart(cv.getContext('2d'), config);
    },

    switchChartMode: function(mode, btn) {
        if (this.chartMode === mode) return;
        this.chartMode = mode;
        var btns = document.querySelectorAll('.myhelper-dashboard .chart-mode-btn');
        for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].dataset.mode === mode);
        if (this.speedChart) { this.speedChart.destroy(); this.speedChart = null; }
        this.createChart(mode);
    },

    startPolling: function() {
        var self = this;

        // Быстрый опрос скорости каждую 1 сек
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

                        if (self.chartMode === 'speed' && self.speedChart) {
                            var c = self.speedChart;
                            c.data.datasets[0].data.shift(); c.data.datasets[0].data.push(rxMbps);
                            c.data.datasets[1].data.shift(); c.data.datasets[1].data.push(txMbps);
                            
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
            }).catch(function() {});
        }, POLL_STATS);

        // Опрос статуса раз в 5 сек
        poll.add(function() {
            if (!document.getElementById('speedChart')) return Promise.resolve();
            return callStatus().then(function(res) {
                self.status = res || {};
                
                var pingEl = document.getElementById('dash-ping');
                if (pingEl) pingEl.innerText = parseLastPing(self.status, 'history');
                
                // Обновляем график пинга, если открыт соответствующий режим
                if (self.chartMode !== 'speed' && self.speedChart) {
                    var key = (self.chartMode === 'ping_wan') ? 'history' : 'history_device';
                    var hist = Array.isArray(self.status[key]) ? self.status[key] : [];
                    self.speedChart.data.labels = hist.map(function(_, i) { return String(i); });
                    self.speedChart.data.datasets[0].data = hist.map(function(sample) {
                        return isOk(sample.ok) ? (Number(sample.rtt_us) / 1000) : null;
                    });
                    self.speedChart.update();
                }
            }).catch(function() {});
        }, POLL_STATUS);
    }
});
