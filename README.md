# myhelper-openwrt
cat >> /etc/hosts << 'EOF'

# Block Xiaomi auto-update servers
127.0.0.1    otacdn.mi.com
127.0.0.1    api.miwifi.com
127.0.0.1    cdn.cnbj1.fds.api.mi-img.com
127.0.0.1    otadl.mi.com
127.0.0.1    rom.miui.com
EOF
cat /etc/hosts
