# myhelper-openwrt
be3600 rd16 
mkdir -p /tmp/backup
for i in 0 2 3 11 13 14 17 21; do
  echo "=== Backing up mtd$i ==="
  dd if=/dev/mtdblock$i of=/tmp/backup/mtd$i.bin 2>&1 | tail -1
done
ls -la /tmp/backup/
