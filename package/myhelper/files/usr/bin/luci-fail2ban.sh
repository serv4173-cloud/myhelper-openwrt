#!/bin/sh
# Use the fw4 table managed by firewall4; do not create/delete the table itself.
# The set and rule are named so startup is safe across procd restarts.
nft list table inet fw4 >/dev/null 2>&1 || {
    logger -t luci-fail2ban "firewall4 table inet fw4 is not available"
    exit 1
}

if ! nft list set inet fw4 luci_bruteforce >/dev/null 2>&1; then
    nft add set inet fw4 luci_bruteforce { type ipv4_addr\; flags dynamic,timeout\; timeout 5m\; } || exit 1
fi

if ! nft -a list chain inet fw4 input 2>/dev/null | grep -q 'ip saddr @luci_bruteforce.*drop'; then
    nft add rule inet fw4 input ip saddr @luci_bruteforce counter drop || exit 1
fi

logger -t luci-fail2ban "Started monitoring LuCI failed logins (5 fails / 60s -> block 5m)"

logread -f | while read -r line; do
    case "$line" in
        *"luci: failed login"*)
            IP=$(echo "$line" | sed -n 's/.*from \([0-9a-f:.]*\).*/\1/p')
            # The nft set is IPv4-only. Reject IPv6 and malformed tokens.
            case "$IP" in
                *[!0-9.]*|*.*.*.*.*) continue ;;
                *.*.*.*) ;;
                *) continue ;;
            esac
            if [ -n "$IP" ]; then
                NOW=$(date +%s)
                FILE="/tmp/luci_fail_$(echo "$IP" | tr '.' '_')"
                
                if [ -f "$FILE" ]; then
                    read COUNT OLD_TIME < "$FILE"
                    if [ $((NOW - OLD_TIME)) -le 60 ]; then
                        COUNT=$((COUNT + 1))
                    else
                        COUNT=1
                    fi
                else
                    COUNT=1
                fi
                
                echo "$COUNT $NOW" > "$FILE"
                
                if [ "$COUNT" -ge 5 ]; then
                    nft add element inet fw4 luci_bruteforce { "$IP" timeout 300s } 2>/dev/null
                    logger -t luci-fail2ban "Blocked $IP for 5m (5 fails in 60s)"
                    rm -f "$FILE"
                fi
            fi
            ;;
    esac
done
