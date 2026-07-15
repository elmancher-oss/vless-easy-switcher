# VLESS Switch

Расширение по образцу Browsec: переключение отдельных сайтов (или всего
трафика) через локальный VLESS+Reality туннель (Xray-core).

## Установка в один шаг

Просто запусти файл для своей ОС в корне архива — он сам скачает всё
необходимое, спросит браузер (Firefox/Chrome) и откроет нужную страницу
браузера + папку с расширением, чтобы оставалось только нажать "Загрузить".

| ОС | Файл |
|---|---|
| Windows | `Установка.bat` (двойной клик) |
| macOS | `Install.command` (двойной клик) |
| Linux | `install.sh` (`chmod +x install.sh && ./install.sh`, либо просто открыть через файловый менеджер, если он поддерживает запуск .sh) |

Дальше на экране появится:
1. Вопрос "Firefox или Chrome?" (Enter = Firefox).
2. Автоматическая загрузка `xray` и (если нужно) Python.
3. Проверка занятости порта 1080, при конфликте - предложит сменить.
4. Откроется нужная страница браузера и папка с расширением - остаётся
   выбрать её один раз.
5. Открой popup расширения, вставь свою `vless://` ссылку, включи тумблер.

Всё. Дальше и запуск, и остановка `xray` расширение делает само по тумблеру.

## Ограничение по Safari

Safari не поддерживается напрямую - Apple требует конвертацию через Xcode
(`safari-web-extension-converter`), возможную только на Mac с установленным
Xcode и Apple Developer аккаунтом. Вне рамок этого архива.

## Структура (для тех, кому интересно, что внутри)

```
Установка.bat / Install.command / install.sh   <- то, что запускаешь
extension-firefox/     расширение для Firefox (Manifest V2)
extension-chrome/       расширение для Chrome (Manifest V3, PAC-скрипт)
native-host/
  windows/ macos/ linux/     нативный хост под каждую ОС
config.example.json     шаблон конфига Xray-core (без реальных данных)
```

Ключ Chrome-расширения (`extension-chrome/manifest.json` -> `"key"`) закреплён
намертво, поэтому ID расширения всегда одинаковый и не нужно копировать его
руками между окнами при установке.

## Ручная установка (если нужно больше контроля)

Вместо корневого лаунчера можно зайти в `native-host/<windows|macos|linux>/`
и запустить `install.ps1`/`install.sh` напрямую с флагами:
```
# Windows
powershell -ExecutionPolicy Bypass -File native-host\windows\install.ps1 -Browser chrome

# macOS / Linux
./native-host/macos/install.sh --browser chrome
./native-host/linux/install.sh --browser firefox
```

## Логи и диагностика

- `native-host/<os>/vless_switch_host.log` - лог нативного хоста
- `native-host/<os>/xray_process.log` - stdout/stderr самого xray
- Раздел "Журнал событий" в popup расширения - маршрутизация, старт/стоп,
  ошибки

## Безопасность

`config.example.json` - шаблон без реальных данных. Реальный `config.json`
с твоим UUID/сервером создаётся автоматически после первого добавления
`vless://` ссылки через popup и не должен попадать в публичные репозитории.
