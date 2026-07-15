#!/bin/bash
# VLESS Switch - удаление (linux)

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Останавливаю xray (если запущен) ..."
pkill -f "$DIR/xray" 2>/dev/null || echo "  xray не был запущен"

echo "Удаляю манифесты native messaging host ..."
rm -f "$HOME/.mozilla/native-messaging-hosts/vless_switch_host.json" 2>/dev/null
rm -f "$HOME/.config/google-chrome/NativeMessagingHosts/vless_switch_host.json" 2>/dev/null
echo "  Готово."

echo ""
echo "Осталось вручную:"
echo "  Firefox: about:addons -> VLESS Switch -> ... -> Удалить"
echo "  Chrome:  chrome://extensions -> VLESS Switch -> Удалить"
