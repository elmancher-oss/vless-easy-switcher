#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$DIR/native-host/linux/install.sh"
"$DIR/native-host/linux/install.sh" "$@"
read -p "Нажми Enter для выхода..."
