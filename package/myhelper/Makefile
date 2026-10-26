include $(TOPDIR)/rules.mk

PKG_NAME:=myhelper
PKG_VERSION:=1.0
PKG_RELEASE:=1

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)

include $(INCLUDE_DIR)/package.mk

define Package/myhelper
    SECTION:=utils
    CATEGORY:=Utilities
    TITLE:=Internet watchdog + Game Boost for Xiaomi BE3600
    DEPENDS:=+ubus +libubus +libubox
    MAINTAINER:=you@example.com
endef

define Package/myhelper/description
  User-space watchdog that probes the internet every N seconds,
  restarts WAN on sustained connectivity loss, and applies
  MAC-based DSCP prioritization for gaming traffic.
endef

define Build/Prepare
    mkdir -p $(PKG_BUILD_DIR)
    $(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Build/Compile
    $(TARGET_CC) $(TARGET_CFLAGS) -Wall -Wextra -O2 \
        -o $(PKG_BUILD_DIR)/myhelper_wd \
        $(PKG_BUILD_DIR)/watchdog.c \
        $(TARGET_LDFLAGS) -lubus -lubox -lblobmsg_json
endef

define Package/myhelper/install
    $(INSTALL_DIR) $(1)/usr/bin
    $(INSTALL_BIN) $(PKG_BUILD_DIR)/myhelper_wd $(1)/usr/bin/myhelper_wd

    $(INSTALL_DIR) $(1)/etc/init.d
    $(INSTALL_BIN) ./files/etc/init.d/myhelper-watchdog \
        $(1)/etc/init.d/myhelper-watchdog

    $(INSTALL_DIR) $(1)/etc/config
    $(INSTALL_CONF) ./files/etc/config/myhelper \
        $(1)/etc/config/myhelper

    $(INSTALL_DIR) $(1)/usr/share/luci/menu.d
    $(INSTALL_DATA) ./files/usr/share/luci/menu.d/luci-app-myhelper.json \
        $(1)/usr/share/luci/menu.d/luci-app-myhelper.json

    $(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
    $(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/luci-app-myhelper.json \
        $(1)/usr/share/rpcd/acl.d/luci-app-myhelper.json

    $(INSTALL_DIR) $(1)/www/luci-static/resources/view/myhelper
    $(INSTALL_DATA) ./files/www/luci-static/resources/view/myhelper/game_boost.js \
        $(1)/www/luci-static/resources/view/myhelper/game_boost.js
    $(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/etc/uci-defaults/99-myhelper-boot-success \
		$(1)/etc/uci-defaults/99-myhelper-boot-success
    # --- Установка библиотеки Chart.js ---
    $(INSTALL_DATA) ./files/www/luci-static/resources/view/myhelper/chart.umd.min.js \
        $(1)/www/luci-static/resources/view/myhelper/chart.umd.min.js
    # --- Custom Files (sysauth, fail2ban) ---
	# 1. Неоновая страница логина
	$(INSTALL_DIR) $(1)/usr/share/ucode/luci/template/themes/argon
	$(INSTALL_DATA) ./files/usr/share/ucode/luci/template/themes/argon/sysauth.ut $(1)/usr/share/ucode/luci/template/themes/argon/

	# 2. Скрипт fail2ban
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/luci-fail2ban.sh $(1)/usr/bin/

	# 3. Init-скрипт fail2ban
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/luci-fail2ban $(1)/etc/init.d/

	# 4. Автозапуск (симлинк)
	$(INSTALL_DIR) $(1)/etc/rc.d
	$(LN) ../init.d/luci-fail2ban $(1)/etc/rc.d/S99luci-fail2ban

endef

$(eval $(call BuildPackage,myhelper))
