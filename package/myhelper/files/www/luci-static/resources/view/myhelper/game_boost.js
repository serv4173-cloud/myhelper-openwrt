'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require ui';
'require dom';

/* ============================================================
 *  RPC declarations
 * ============================================================ */

var callInit = rpc.declare({
    object: 'rc', method: 'init',
    params: [ 'name', 'action' ], expect: { result: false }
});

var callStatus = rpc.declare({
    object: 'myhelper', method: 'status'
});

var callForceRecovery = rpc.declare({
    object: 'myhelper', method: 'force_recovery'
});

var callQosReapply = rpc.declare({
    object: 'myhelper', method: 'qos_reapply'
});

var callDhcpLeases = rpc.declare({
    object: 'dhcp', method: 'ipv4leases'
});

/* ============================================================
 *  Helpers
 * ============================================================ */

var MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

function normalizeMac(v) {
    return String(v || '').trim().toLowerCase();
}

function fmtUptime(sec) {
    sec = parseInt(sec, 10) || 0;
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (d > 0) return '%dd %dh %dm'.format(d, h, m);
    if (h > 0) return '%dh %dm %ds'.format(h, m, s);
    return '%dm %ds'.format(m, s);
}

function fmtTimestamp(ts) {
    if (!ts) return _('never');
    try { return new Date(ts * 1000).toLocaleString(); }
    catch (e) { return String(ts); }
}

function flattenLeases(raw) {
    var out = [];
    if (!raw) return out;

    function push(lease) {
        if (!lease || !lease.mac) return;
        out.push({
            mac:      normalizeMac(lease.mac),
            ip:       lease.ip || '',
            hostname: (lease.hostname || '').trim(),
            online:   lease.valid !== false
        });
    }

    if (raw.device && typeof raw.device === 'object') {
        Object.keys(raw.device).forEach(function (dev) {
            var l = raw.device[dev] && raw.device[dev].leases;
            if (Array.isArray(l)) l.forEach(push);
        });
    } else if (Array.isArray(raw.leases)) {
        raw.leases.forEach(push);
    }
    return out;
}

function getTargetMacs() {
    var cur = uci.get('myhelper', 'settings', 'target_mac') || [];
    if (typeof cur === 'string') cur = [ cur ];
    return cur.map(normalizeMac).filter(Boolean);
}

function ipSortKey(ip) {
    if (!ip || ip === '-') return 0xffffffff;
    var p = String(ip).split('.').map(function (x) { return parseInt(x, 10) || 0; });
    if (p.length !== 4) return 0xfffffffe;
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/* ============================================================
 *  SVG graph rendering
 * ============================================================ */

var CAKE_PRESETS = [
    { value: 'balanced',       label: 'Balanced (diffserv4)' },
    { value: 'low_latency',    label: 'Low Latency (diffserv8 + dual-srchost)' },
    { value: 'max_throughput', label: 'Max Throughput (besteffort)' },
    { value: 'custom',         label: 'Custom' }
];

function renderSvgGraph(hist, opts) {
    opts = opts || {};
    var W = 600, H = 140, PAD = 12;
    var w = W - 2 * PAD, h = H - 2 * PAD;
    var n = hist.length;

    if (n === 0) {
        return E('div', { 'class': 'cbi-section' }, [
            E('h3', {}, opts.title || _('Ping History')),
            E('p', { 'style': 'color: #888' },
              opts.emptyText || _('No probe history yet.'))
        ]);
    }

    var maxRtt = 50;
    hist.forEach(function (s) {
        if (s.ok) maxRtt = Math.max(maxRtt, s.rtt_us / 1000);
    });

    var barW = Math.max(1, w / n - 1);
    var children = [
        E('rect', { x: 0, y: 0, width: W, height: H,
                    fill: '#fafafa', stroke: '#ddd' })
    ];

    hist.forEach(function (s, i) {
        var x = PAD + (i / n) * w;
        var barH, fill;
        if (!s.ok) { barH = h; fill = '#d9534f'; }
        else {
            barH = Math.max(2, (s.rtt_us / 1000 / maxRtt) * h);
            fill = '#5cb85c';
        }
        children.push(E('rect', {
            x: x, y: PAD + h - barH, width: barW, height: barH, fill: fill
        }));
    });

    return E('div', { 'class': 'cbi-section' }, [
        E('h3', {}, opts.title || _('Ping History')),
        E('svg', {
            viewBox: '0 0 %d %d'.format(W, H),
            width: '100%',
            height: H,
            preserveAspectRatio: 'none'
        }, children),
        E('div', { 'style': 'font-size: 11px; color: #666; margin-top: 4px' },
          (opts.subtitle || '') +
          ' \u2022 ' + _('Last %d probes').format(n) +
          ' \u2022 ' + _('scale 0..%d ms').format(Math.round(maxRtt)))
    ]);
}

/* ============================================================
 *  Main view
 * ============================================================ */

return view.extend({

    _sortKey: 'priority',
    _sortDir: 'desc',

    /* ---------------------------------------------------------------
     * Lifecycle
     * --------------------------------------------------------------- */

    load: function () {
        var self = this;
        self.status  = {};
        self.devices = [];

        return Promise.all([
            uci.load('myhelper'),
            uci.load('network'),
            callStatus().then(function (res) { self.status = res || {}; })
                        .catch(function () { self.status = {}; }),
            self.fetchDevices()
        ]);
    },

    fetchDevices: function () {
        var self = this;
        return callDhcpLeases().then(function (raw) {
            self.devices = flattenLeases(raw);
        }).catch(function () {
            self.devices = [];
        });
    },

    pollStatus: function () {
        var self = this;
        return Promise.all([
            callStatus().then(function (res) { self.status = res || {}; })
                        .catch(function () { self.status = {}; }),
            self.fetchDevices()
        ]);
    },

    /* ---------------------------------------------------------------
     * Status panel
     * --------------------------------------------------------------- */

    renderStatusPanel: function () {
        var self = this;
        var s = this.status || {};

        this.$fields = {
            internet: s.internet
                ? E('span', { 'class': 'label success' }, _('ONLINE'))
                : E('span', { 'class': 'label warning' }, _('OFFLINE')),
            fail:         E('span', {}, '%d / %d'.format(s.fail_count || 0, s.threshold || 0)),
            uptime:       E('span', {}, fmtUptime(s.uptime)),
            recoveries:   E('span', {}, String(s.recovery_count || 0)),
            lastRecovery: E('span', {}, fmtTimestamp(s.last_recovery)),
            gamingIp:     E('span', {}, s.gaming_ip || _('not resolved'))
        };

        var btnForce = E('button', {
            'class': 'cbi-button cbi-button-action',
            'click': ui.createHandlerFn(this, function () {
                if (!confirm(_('Trigger WAN recovery now?'))) return;
                return callForceRecovery().then(function () {
                    ui.addNotification(null, E('p', _('Recovery triggered.')), 'info');
                    return self.pollStatus().then(function () { self.refreshPanel(); });
                });
            })
        }, _('Force Recovery Now'));

        var btnQos = E('button', {
            'class': 'cbi-button cbi-button-apply',
            'click': ui.createHandlerFn(this, function () {
                return callQosReapply().then(function () {
                    ui.addNotification(null, E('p', _('QoS re-applied.')), 'info');
                });
            })
        }, _('Re-apply QoS'));

        var table = E('table', { 'class': 'table' }, [
            E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td left', 'width': '30%' }, _('Internet')),
                E('td', { 'class': 'td left' }, this.$fields.internet)
            ]),
            E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td left' }, _('Gaming device IP')),
                E('td', { 'class': 'td left', 'style': 'font-family: monospace' },
                  this.$fields.gamingIp)
            ]),
            E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td left' }, _('Failed probes')),
                E('td', { 'class': 'td left' }, this.$fields.fail)
            ]),
            E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td left' }, _('Uptime')),
                E('td', { 'class': 'td left' }, this.$fields.uptime)
            ]),
            E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td left' }, _('Recovery count')),
                E('td', { 'class': 'td left' }, this.$fields.recoveries)
            ]),
            E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td left' }, _('Last recovery')),
                E('td', { 'class': 'td left' }, this.$fields.lastRecovery)
            ]),
            E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td left' }, _('Actions')),
                E('td', { 'class': 'td left' }, [ btnForce, ' ', btnQos ])
            ])
        ]);

        return E('div', { 'class': 'cbi-section' }, [
            E('h3', {}, _('Live Status')),
            table
        ]);
    },

    refreshPanel: function () {
        var s = this.status || {};
        if (!this.$fields) return;

        var parent = this.$fields.internet.parentNode;
        if (parent) {
            var replacement = s.internet
                ? E('span', { 'class': 'label success' }, _('ONLINE'))
                : E('span', { 'class': 'label warning' }, _('OFFLINE'));
            parent.replaceChild(replacement, this.$fields.internet);
            this.$fields.internet = replacement;
        }
        this.$fields.fail.firstChild.nodeValue =
            '%d / %d'.format(s.fail_count || 0, s.threshold || 0);
        this.$fields.uptime.firstChild.nodeValue = fmtUptime(s.uptime);
        this.$fields.recoveries.firstChild.nodeValue = String(s.recovery_count || 0);
        this.$fields.lastRecovery.firstChild.nodeValue = fmtTimestamp(s.last_recovery);
        this.$fields.gamingIp.firstChild.nodeValue = s.gaming_ip || _('not resolved');
    },

    /* ============================================================
     *  Devices tab
     * ============================================================ */

    renderDevicesTable: function () {
        var self = this;
        this.$devicesContainer  = E('div', { 'id': 'myhelper-devices' });
        this.$devicesOnlyToggle = E('input', {
            type: 'checkbox',
            'click': function () { self.refreshDevicesTable(); }
        });

        var toolbar = E('div', { 'style': 'margin-bottom: 8px' }, [
            E('label', { 'style': 'margin-right: 16px' }, [
                this.$devicesOnlyToggle, ' ',
                _('Show only gaming devices')
            ]),
            E('button', {
                'class': 'cbi-button cbi-button-neutral',
                'click': ui.createHandlerFn(this, function () {
                    return self.pollStatus().then(function () {
                        self.refreshPanel();
                        self.refreshDevicesTable();
                    });
                })
            }, _('Refresh'))
        ]);

        setTimeout(function () { self.refreshDevicesTable(); }, 0);
        return E('div', {}, [ toolbar, this.$devicesContainer ]);
    },

    onHeaderClick: function (key) {
        if (this._sortKey === key) {
            this._sortDir = (this._sortDir === 'asc') ? 'desc' : 'asc';
        } else {
            this._sortKey = key;
            this._sortDir = (key === 'priority' || key === 'status') ? 'desc' : 'asc';
        }
        this.refreshDevicesTable();
    },

    makeHeader: function (key, label, width) {
        var self = this;
        var active = (this._sortKey === key);
        var arrow  = active ? (this._sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

        var attrs = {
            'class': 'th',
            'style': 'cursor: pointer; user-select: none;' +
                     (active ? ' color: #37a;' : '')
        };
        if (width) attrs.width = width;

        return E('th', attrs, [
            E('span', {
                'click': function (ev) {
                    ev.preventDefault();
                    self.onHeaderClick(key);
                }
            }, label + arrow)
        ]);
    },

    makeComparator: function () {
        var key = this._sortKey;
        var dir = (this._sortDir === 'asc') ? 1 : -1;

        return function (a, b) {
            var va, vb;
            switch (key) {
            case 'status':   va = a.online ? 1 : 0; vb = b.online ? 1 : 0; break;
            case 'hostname':
                return dir * String(a.hostname || '').toLowerCase()
                           .localeCompare(String(b.hostname || '').toLowerCase());
            case 'mac':      return dir * String(a.mac).localeCompare(String(b.mac));
            case 'ip':       va = ipSortKey(a.ip); vb = ipSortKey(b.ip); break;
            case 'priority': va = a.gaming ? 1 : 0; vb = b.gaming ? 1 : 0; break;
            default: return 0;
            }
            if (va < vb) return -1 * dir;
            if (va > vb) return  1 * dir;
            return 0;
        };
    },

    refreshDevicesTable: function () {
        var self = this;
        if (!this.$devicesContainer) return;

        var targets    = getTargetMacs();
        var onlyGaming = this.$devicesOnlyToggle && this.$devicesOnlyToggle.checked;

        var merged = [];
        var seen   = {};

        this.devices.forEach(function (d) {
            seen[d.mac] = true;
            merged.push({
                mac:      d.mac,
                ip:       d.ip || '-',
                hostname: d.hostname || '?',
                online:   d.online,
                gaming:   targets.indexOf(d.mac) >= 0
            });
        });

        targets.forEach(function (mac) {
            if (seen[mac]) return;
            merged.push({ mac: mac, ip: '-', hostname: '?',
                          online: false, gaming: true });
        });

        if (onlyGaming)
            merged = merged.filter(function (d) { return d.gaming; });

        var cmp = this.makeComparator();
        merged.sort(function (a, b) {
            var r = cmp(a, b);
            if (r !== 0) return r;
            return String(a.mac).localeCompare(String(b.mac));
        });

        var header = E('tr', { 'class': 'tr table-titles' }, [
            this.makeHeader('status',   _('Status'),   '70px'),
            this.makeHeader('hostname', _('Hostname')),
            this.makeHeader('mac',      _('MAC Address')),
            this.makeHeader('ip',       _('IP Address')),
            this.makeHeader('priority', _('Priority'), '90px'),
            E('th', { 'class': 'th', 'width': '140px' }, _('Actions'))
        ]);

        var rows = merged.map(function (d) {
            var dot = E('span', {
                'title': d.online ? _('Online') : _('Offline'),
                'style': 'display:inline-block; width:12px; height:12px;' +
                         ' border-radius:50%; background:' +
                         (d.online ? '#5cb85c' : '#d9534f') + ';'
            });

            var priorityBadge = d.gaming
                ? E('span', { 'class': 'label success' }, 'GAMING')
                : E('span', { 'class': 'label' }, '\u2014');

            var actionBtn = E('button', {
                'class': 'cbi-button cbi-button-' + (d.gaming ? 'remove' : 'add'),
                'click': ui.createHandlerFn(self, function () {
                    return self.toggleMacPriority(d.mac, !d.gaming);
                })
            }, d.gaming ? _('Remove') : _('Prioritize'));

            return E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td center' }, dot),
                E('td', { 'class': 'td' }, d.hostname),
                E('td', { 'class': 'td', 'style': 'font-family: monospace' }, d.mac),
                E('td', { 'class': 'td', 'style': 'font-family: monospace' }, d.ip),
                E('td', { 'class': 'td center' }, priorityBadge),
                E('td', { 'class': 'td center' }, actionBtn)
            ]);
        });

        if (rows.length === 0) {
            rows.push(E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td', 'colspan': 6,
                          'style': 'text-align:center; color:#888' },
                  onlyGaming
                    ? _('No gaming devices configured.')
                    : _('No active DHCP leases.'))
            ]));
        }

        var table = E('table', { 'class': 'table' }, [ header ].concat(rows));

        while (this.$devicesContainer.firstChild)
            this.$devicesContainer.removeChild(this.$devicesContainer.firstChild);
        this.$devicesContainer.appendChild(table);
    },

    toggleMacPriority: function (mac, add) {
        var self = this;
        mac = normalizeMac(mac);

        var cur = uci.get('myhelper', 'settings', 'target_mac') || [];
        if (typeof cur === 'string') cur = [ cur ];
        cur = cur.map(normalizeMac);

        if (add) { if (cur.indexOf(mac) < 0) cur.push(mac); }
        else     { cur = cur.filter(function (m) { return m !== mac; }); }

        uci.set('myhelper', 'settings', 'target_mac', cur);

        return uci.save().then(function () {
            return uci.apply();
        }).then(function () {
            return callInit('myhelper-watchdog', 'restart');
        }).then(function () {
            ui.addNotification(null,
                E('p', add
                    ? _('MAC %s is now prioritized.').format(mac)
                    : _('MAC %s removed from priority list.').format(mac)),
                'info');
            return self.pollStatus().then(function () {
                self.refreshDevicesTable();
            });
        }).catch(function (err) {
            ui.addNotification(null,
                E('p', _('Toggle failed: %s').format(err)), 'error');
        });
    },

    /* ---------------------------------------------------------------
     * Form builder
     * --------------------------------------------------------------- */

    buildForm: function () {
        var self = this;

        var m = new form.Map(
            'myhelper',
            _('MyHelper Game Boost'),
            _('Internet watchdog and gaming traffic prioritization for the Xiaomi Router BE3600.')
        );

        m.tab('watchdog',   _('Internet Watchdog'));
        m.tab('game_boost', _('Game Boost (QoS)'));
        m.tab('devices',    _('Devices'));
        m.tab('monitor',    _('Monitor'));

        /* ---- Tab 1: Watchdog ---- */
        var s = m.section(form.NamedSection, 'watchdog', 'myhelper', _('Watchdog'));
        s.tab = 'watchdog'; s.anonymous = true; s.addremove = false;

        var o = s.option(form.Flag, 'enabled', _('Enable Watchdog'));
        o.rmempty = false; o.default = '1';

        o = s.option(form.Value, 'check_interval', _('Check Interval'),
            _('Seconds between internet probes.'));
        o.datatype = 'uinteger'; o.placeholder = '60'; o.default = '60';
        o.depends('enabled', '1');

        o = s.option(form.Value, 'fail_threshold', _('Failure Threshold'),
            _('Consecutive failed probes before WAN recovery triggers.'));
        o.datatype = 'uinteger'; o.placeholder = '3'; o.default = '3';
        o.depends('enabled', '1');

        o = s.option(form.Value, 'wan_interface', _('WAN Interface'));
        o.placeholder = 'wan'; o.default = 'wan'; o.rmempty = false;
        o.depends('enabled', '1');

        o = s.option(form.Value, 'probe_host_1', _('Primary Probe Host'));
        o.datatype = 'hostname'; o.placeholder = '1.1.1.1'; o.default = '1.1.1.1';
        o.depends('enabled', '1');

        o = s.option(form.Value, 'probe_host_2', _('Secondary Probe Host'));
        o.datatype = 'hostname'; o.placeholder = '8.8.8.8'; o.default = '8.8.8.8';
        o.depends('enabled', '1');

        /* ---- Tab 2: Game Boost ---- */
        s = m.section(form.NamedSection, 'game_boost', 'settings', _('Game Boost'));
        s.tab = 'game_boost'; s.anonymous = true; s.addremove = false;

        o = s.option(form.Flag, 'enabled', _('Enable Game Boost'));
        o.rmempty = false; o.default = '0';

        o = s.option(form.ListValue, 'qos_preset', _('CAKE Preset'),
            _('Traffic shaping profile. Choose "Low Latency" for competitive gaming, ' +
              '"Balanced" for mixed home use, "Max Throughput" for pure bandwidth.'));
        CAKE_PRESETS.forEach(function (p) {
            o.value(p.value, _(p.label));
        });
        o.default = 'balanced';
        o.rmempty = false;
        o.depends('enabled', '1');

        o = s.option(form.DynamicList, 'target_mac', _('Gaming Device MACs'),
            _('Traffic to/from these MACs is marked DSCP CS6.'));
        o.datatype = 'macaddr'; o.placeholder = 'aa:bb:cc:dd:ee:ff';
        o.depends('enabled', '1');
        var origWrite = o.write;
        o.write = function (sid, v) {
            return origWrite.call(this, sid, normalizeMac(v));
        };
        o.validate = function (sid, value) {
            if (!value) return true;
            var norm = normalizeMac(value);
            if (!MAC_RE.test(norm))
                return _('Invalid MAC address: "%s"').format(value);
            if (norm === 'ff:ff:ff:ff:ff:ff' || norm === '00:00:00:00:00:00')
                return _('Special MAC not allowed: %s').format(norm);
            var cur = uci.get('myhelper', sid, 'target_mac') || [];
            if (typeof cur === 'string') cur = [ cur ];
            var matches = 0;
            cur.forEach(function (m) { if (normalizeMac(m) === norm) matches++; });
            if (matches > 1)
                return _('Duplicate MAC: %s').format(norm);
            return true;
        };

        o = s.option(form.Value, 'ports', _('Gaming Ports'),
            _('Comma-separated TCP/UDP ports, e.g. 3074,27015,27016.'));
        o.placeholder = '3074,27015,27016';
        o.depends('enabled', '1');
        o.validate = function (sid, value) {
            if (!value) return true;
            var parts = String(value).split(',');
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i].trim();
                if (!/^[0-9]+$/.test(p) ||
                    parseInt(p, 10) < 1 || parseInt(p, 10) > 65535)
                    return _('Invalid port: "%s"').format(p);
            }
            return true;
        };

        o = s.option(form.Value, 'bandwidth_upload', _('Upload Bandwidth'),
            _('CAKE egress rate, e.g. "20mbit". "0" disables.'));
        o.placeholder = '0'; o.depends('enabled', '1');

        o = s.option(form.Value, 'bandwidth_download', _('Download Bandwidth'),
            _('CAKE ingress rate via IFB, e.g. "200mbit". "0" disables.'));
        o.placeholder = '0'; o.depends('enabled', '1');

        /* ---- Tab 3: Devices ---- */
        s = m.section(form.NamedSection, 'game_boost', 'settings', _('Devices'));
        s.tab = 'devices'; s.anonymous = true; s.addremove = false;

        o = s.option(form.DummyValue, '_devices');
        o.rawhtml  = false;
        o.cfgvalue = function () { return ''; };
        o.render   = function () { return self.renderDevicesTable(); };

        return m;
    },

    /* ---------------------------------------------------------------
     * Render
     * --------------------------------------------------------------- */

    render: function () {
        var self = this;

        this.formMap = this.buildForm();
        var root = this.formMap.render();

        root.insertBefore(this.renderStatusPanel(), root.firstChild);

        setTimeout(function () {
            var panel = root.querySelector('.cbi-tab-descr[id$="monitor"],' +
                                          ' .cbi-tab[id$="monitor"]');
            var host  = panel || root;
            var container = E('div', { id: 'myhelper-graphs' });

            container.style.display = 'flex';
            container.style.gap = '16px';
            container.style.flexWrap = 'wrap';

            var s = self.status || {};
            var gInternet = E('div', { style: 'flex: 1 1 45%; min-width: 320px;' });
            var gDevice   = E('div', { style: 'flex: 1 1 45%; min-width: 320px;' });

            gInternet.appendChild(renderSvgGraph(s.history || [], {
                title:    _('Latency to Internet'),
                subtitle: _('Targets: 1.1.1.1 / 8.8.8.8')
            }));
            gDevice.appendChild(renderSvgGraph(s.history_device || [], {
                title:     _('Latency to Gaming Device'),
                subtitle:  s.gaming_ip
                    ? _('Target: %s').format(s.gaming_ip)
                    : _('No gaming device resolved'),
                emptyText: _('No gaming device configured or no active lease.')
            }));

            container.appendChild(gInternet);
            container.appendChild(gDevice);
            host.appendChild(container);

            self.$graphs = { root: container, internet: gInternet, device: gDevice };
        }, 100);

        this.startPolling();
        return root;
    },

    refreshGraphs: function () {
        if (!this.$graphs) return;
        var s = this.status || {};

        while (this.$graphs.internet.firstChild)
            this.$graphs.internet.removeChild(this.$graphs.internet.firstChild);
        while (this.$graphs.device.firstChild)
            this.$graphs.device.removeChild(this.$graphs.device.firstChild);

        this.$graphs.internet.appendChild(renderSvgGraph(s.history || [], {
            title:    _('Latency to Internet'),
            subtitle: _('Targets: 1.1.1.1 / 8.8.8.8')
        }));
        this.$graphs.device.appendChild(renderSvgGraph(s.history_device || [], {
            title:     _('Latency to Gaming Device'),
            subtitle:  s.gaming_ip
                ? _('Target: %s').format(s.gaming_ip)
                : _('No gaming device resolved'),
            emptyText: _('No gaming device configured or no active lease.')
        }));
    },

    startPolling: function () {
        var self = this;
        this._pollTimer = window.setInterval(function () {
            self.pollStatus().then(function () {
                self.refreshPanel();
                self.refreshDevicesTable();
                self.refreshGraphs();
            });
        }, 5000);
    },

    handleSaveApply: function (ev, mode) {
        var self = this;
        return this.formMap.handleSaveApply(ev, mode).then(function () {
            return callInit('myhelper-watchdog', 'restart');
        }).then(function () {
            ui.addNotification(null,
                E('p', _('Configuration saved and service restarted.')), 'info');
            return self.pollStatus().then(function () {
                self.refreshPanel();
                self.refreshDevicesTable();
                self.refreshGraphs();
            });
        }).catch(function (err) {
            ui.addNotification(null,
                E('p', _('Restart failed: %s').format(err)), 'error');
        });
    },

    handleReset: function (ev, mode) {
        return this.formMap.handleReset(ev, mode);
    },

    destroy: function () {
        if (this._pollTimer) {
            window.clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        return this.super('destroy');
    }
});
