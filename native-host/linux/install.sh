#!/bin/bash
# VLESS Switch - установка на Ubuntu/Linux.
# Использование:
#   ./install.sh                          - спросит браузер интерактивно
#   ./install.sh --browser firefox        - без вопросов, сразу Firefox
#   ./install.sh --browser chrome         - сразу Chrome (ID уже зашит)

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BROWSER=""
CHROME_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --browser) BROWSER="$2"; shift 2 ;;
    --chrome-id) CHROME_ID="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$BROWSER" ]; then
  echo "Для какого браузера установить?"
  echo "  [1] Firefox"
  echo "  [2] Chrome"
  read -p "Выбор (1/2, по умолчанию 1): " BROWSER_CHOICE
  if [ "$BROWSER_CHOICE" == "2" ]; then
    BROWSER="chrome"
  else
    BROWSER="firefox"
  fi
fi

echo "============================================"
echo "  VLESS Switch - установка (Linux, $BROWSER)"
echo "============================================"
echo ""

# --- 1. xray ---
if [ -f "$DIR/xray" ]; then
  echo "[OK] xray уже есть: $DIR/xray"
else
  echo "Скачиваю xray с GitHub (XTLS/Xray-core) ..."
  ARCH="$(uname -m)"
  if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
    ASSET_PATTERN="linux-arm64-v8a"
  else
    ASSET_PATTERN="linux-64"
  fi

  RELEASE_JSON=$(curl -s https://api.github.com/repos/XTLS/Xray-core/releases/latest)
  DOWNLOAD_URL=$(echo "$RELEASE_JSON" | grep "browser_download_url" | grep "$ASSET_PATTERN" | head -1 | cut -d '"' -f 4)

  if [ -z "$DOWNLOAD_URL" ]; then
    echo "[ВНИМАНИЕ] Не удалось найти подходящий релиз для $ASSET_PATTERN"
    echo "  Скачай вручную: https://github.com/XTLS/Xray-core/releases и положи xray в $DIR"
  else
    TMP_ZIP=$(mktemp --suffix=.zip)
    curl -L -o "$TMP_ZIP" "$DOWNLOAD_URL"
    TMP_DIR=$(mktemp -d)
    unzip -o "$TMP_ZIP" -d "$TMP_DIR" >/dev/null
    cp "$TMP_DIR/xray" "$DIR/xray"
    chmod +x "$DIR/xray"
    rm -rf "$TMP_ZIP" "$TMP_DIR"
    echo "[OK] xray установлен"
  fi
fi

echo ""

# --- 2. Python3 ---
if command -v python3 >/dev/null 2>&1; then
  echo "[OK] python3 найден: $(command -v python3)"
else
  echo "[ВНИМАНИЕ] python3 не найден."
  echo "  Поставь: sudo apt update && sudo apt install -y python3"
fi

echo ""

# --- 3. config.json ---
CONFIG_EXAMPLE="$DIR/../../config.example.json"
if [ -f "$DIR/config.json" ]; then
  echo "[OK] config.json уже есть"
elif [ -f "$CONFIG_EXAMPLE" ]; then
  cp "$CONFIG_EXAMPLE" "$DIR/config.json"
  echo "[ВНИМАНИЕ] config.json создан из шаблона - добавь свою vless:// ссылку через popup расширения"
else
  echo "[INFO] config.json создастся автоматически при первом добавлении vless:// ссылки"
fi

echo ""

# --- 4. Порт ---
DESIRED_PORT=1080
PORT_FILE="$DIR/port.txt"
[ -f "$PORT_FILE" ] && DESIRED_PORT=$(cat "$PORT_FILE")

PORT_BUSY=0
if command -v ss >/dev/null 2>&1; then
  ss -ltn | grep -q ":$DESIRED_PORT " && PORT_BUSY=1
elif command -v netstat >/dev/null 2>&1; then
  netstat -ltn | grep -q ":$DESIRED_PORT " && PORT_BUSY=1
fi

if [ "$PORT_BUSY" == "1" ]; then
  NEW_PORT=$((DESIRED_PORT + 10))
  is_port_busy() {
    if command -v ss >/dev/null 2>&1; then
      ss -ltn | grep -q ":$1 "
    elif command -v netstat >/dev/null 2>&1; then
      netstat -ltn | grep -q ":$1 "
    else
      return 1
    fi
  }
  while is_port_busy "$NEW_PORT"; do
    NEW_PORT=$((NEW_PORT + 10))
  done
  echo "[ВНИМАНИЕ] Порт $DESIRED_PORT занят - использую свободный порт $NEW_PORT"
  DESIRED_PORT="$NEW_PORT"
else
  echo "[OK] порт $DESIRED_PORT свободен"
fi
echo "$DESIRED_PORT" > "$PORT_FILE"

echo ""

# --- 5. Регистрация Native Messaging host ---
HOST_SCRIPT="$DIR/host.sh"
chmod +x "$HOST_SCRIPT"

if [ "$BROWSER" == "chrome" ]; then
  MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  if [ ! -d "$HOME/.config/google-chrome" ] && [ -d "$HOME/.config/chromium" ]; then
    MANIFEST_DIR="$HOME/.config/chromium/NativeMessagingHosts"
  fi
  # ID закреплён через поле "key" в extension-chrome/manifest.json - всегда
  # одинаковый, независимо от того, как расширение загружено в Chrome.
  if [ -z "$CHROME_ID" ]; then
    CHROME_ID="ideebniacigmfjjmmacnjligjgclgfif"
  fi
  ORIGIN_LINE="\"allowed_origins\": [\"chrome-extension://$CHROME_ID/\"]"
else
  MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
  ORIGIN_LINE="\"allowed_extensions\": [\"vless-switch@boris.local\"]"
fi

mkdir -p "$MANIFEST_DIR"
MANIFEST_PATH="$MANIFEST_DIR/vless_switch_host.json"

cat > "$MANIFEST_PATH" << JSON
{
  "name": "vless_switch_host",
  "description": "Native host for VLESS Switch extension - controls xray",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  $ORIGIN_LINE
}
JSON

echo "[OK] манифест зарегистрирован: $MANIFEST_PATH"

echo ""
echo "============================================"
echo "  Установка завершена"
echo "============================================"
echo ""

ROOT_DIR="$(cd "$DIR/../.." && pwd)"

open_url() {
  xdg-open "$1" >/dev/null 2>&1 && return 0
  "$2" "$1" >/dev/null 2>&1 &
  return $?
}

if [ "$BROWSER" == "firefox" ]; then
  URL="about:debugging#/runtime/this-firefox"
  FOLDER="$ROOT_DIR/extension-firefox"
  open_url "$URL" firefox || echo "[ВНИМАНИЕ] Не нашёл Firefox - открой вручную: $URL"
  STEP1="Открой $URL (уже открыто, если Firefox найден)"
  STEP2="Нажми 'Загрузить временное дополнение'"
  STEP3="В диалоге выбора файла вставь путь (Ctrl+V) и открой manifest.json"
else
  # Chrome с версии 55 блокирует переход на chrome:// страницы через
  # аргумент командной строки (защита от вредоносных программ) - просто
  # запускаем сам браузер, адрес вводим вручную.
  FOLDER="$ROOT_DIR/extension-chrome"
  (google-chrome >/dev/null 2>&1 &) || echo "[ВНИМАНИЕ] Не нашёл Chrome - открой вручную"
  STEP1="Открой Chrome и вставь в адресную строку: chrome://extensions"
  STEP2="Включи 'Режим разработчика' (переключатель справа вверху), затем 'Загрузить распакованное расширение'"
  STEP3="В диалоге выбора папки вставь путь (Ctrl+V) и подтверди"
fi

COPIED=0
if command -v xclip >/dev/null 2>&1; then
  echo -n "$FOLDER" | xclip -selection clipboard && COPIED=1
elif command -v xsel >/dev/null 2>&1; then
  echo -n "$FOLDER" | xsel --clipboard && COPIED=1
elif command -v wl-copy >/dev/null 2>&1; then
  echo -n "$FOLDER" | wl-copy && COPIED=1
fi

if [ "$COPIED" == "1" ]; then
  echo "[OK] путь к папке расширения скопирован в буфер обмена: $FOLDER"
else
  echo "[INFO] Не нашёл xclip/xsel/wl-copy - вот путь вручную:"
  echo "       $FOLDER"
fi

echo ""
echo "================================================"
echo "  ЧТО ДЕЛАТЬ ДАЛЬШЕ"
echo "================================================"
echo ""
echo "  1. $STEP1"
echo "  2. $STEP2"
echo "  3. $STEP3"
echo "  4. Открой popup расширения (иконка в панели браузера),"
echo "     вставь свою vless:// ссылку и включи тумблер."
echo ""
