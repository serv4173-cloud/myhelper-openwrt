cat > /usr/bin/luci-fail2ban.sh <<'EOF'
#!/bin/sh
# Создаем set в nftables (если его нет)
nft add table inet fw4 2>/dev/null
nft add set inet fw4 luci_bruteforce { type ipv4_addr\; flags dynamic,timeout\; timeout 5m\; } 2>/dev/null

# Добавляем правило блокировки в цепочку input (если его нет)
nft add rule inet fw4 input ip saddr @luci_bruteforce counter drop 2>/dev/null

logger -t luci-fail2ban "Started monitoring LuCI failed logins..."

# Слушаем системный лог
logread -f | while read -r line; do
    # LuCI пишет: luci: failed login on /cgi-bin/luci/ for root from 192.168.1.100
    case "$line" in
        *"luci: failed login"*)
            # Вытаскиваем IP-адрес
            IP=$(echo "$line" | sed -n 's/.*from \([0-9a-f:.]*\).*/\1/p')
            if [ -n "$IP" ]; then
                # Добавляем IP в set на 5 минут (300 секунд)
                nft add element inet fw4 luci_bruteforce { "$IP" timeout 300s } 2>/dev/null
                logger -t luci-fail2ban "Blocked $IP for 5 min due to failed login"
            fi
            ;;
    esac
done
EOF
chmod +x /usr/bin/luci-fail2ban.sh
