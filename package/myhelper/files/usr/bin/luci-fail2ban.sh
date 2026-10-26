#!/bin/sh
nft add table inet fw4 2>/dev/null
nft add set inet fw4 luci_bruteforce { type ipv4_addr\; flags dynamic,timeout\; timeout 5m\; } 2>/dev/null
nft add rule inet fw4 input ip saddr @luci_bruteforce counter drop 2>/dev/null

logger -t luci-fail2ban "Started monitoring LuCI failed logins (5 fails / 60s -> block 5m)"

logread -f | while read -r line; do
    case "$line" in
        *"luci: failed login"*)
            IP=$(echo "$line" | sed -n 's/.*from \([0-9a-f:.]*\).*/\1/p')
            if [ -n "$IP" ]; then
                NOW=$(date +%s)
                FILE="/tmp/luci_fail_$(echo $IP | tr ':' '_')"
                
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
