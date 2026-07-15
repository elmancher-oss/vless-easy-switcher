#Requires -Version 5.0
<#
  VLESS Switch - автоматическая установка.
  Скачивает xray.exe (GitHub releases) и, если нужно, портативный Python
  (python.org embeddable package), затем регистрирует Native Messaging host
  для Firefox. Требует интернет на этой машине (сам скрипт запускается
  на компьютере пользователя, не в песочнице).

  Запуск: правый клик -> "Выполнить с помощью PowerShell"
  либо:  powershell -ExecutionPolicy Bypass -File install.ps1
#>

param(
    [string]$PythonVersion = "3.12.7",
    [switch]$SkipPython,
    [switch]$SkipXray,
    [string]$Browser = "",
    [string]$ChromeId = ""
)

$ErrorActionPreference = "Stop"
$DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$JsonPath = Join-Path $DIR "vless_switch_host.json"
$BatPath  = Join-Path $DIR "host.bat"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    ВНИМАНИЕ: $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    ОШИБКА: $msg" -ForegroundColor Red }

Write-Host "============================================"
Write-Host "   VLESS Switch - автоматическая установка"
Write-Host "============================================"
Write-Host ""

if (-not $Browser) {
    Write-Host "Для какого браузера установить?"
    Write-Host "  [1] Firefox"
    Write-Host "  [2] Chrome"
    $browserChoice = Read-Host "Выбор (1/2, по умолчанию 1)"
    if ($browserChoice -eq "2") { $Browser = "chrome" } else { $Browser = "firefox" }
}
Write-Host "Браузер: $Browser"
Write-Host ""

# --- 1. xray.exe ---
$xrayExe = Join-Path $DIR "xray.exe"
if ((Test-Path $xrayExe) -and -not $SkipXray) {
    Write-Step "xray.exe"
    Write-Ok "уже есть: $xrayExe"
}
elseif (-not $SkipXray) {
    Write-Step "Скачиваю xray.exe с GitHub (XTLS/Xray-core) ..."
    try {
        $releaseInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/XTLS/Xray-core/releases/latest" -UseBasicParsing
        $asset = $releaseInfo.assets | Where-Object { $_.name -match "windows-64\.zip$" -and $_.name -notmatch "win7" } | Select-Object -First 1
        if (-not $asset) {
            throw "Не нашёл подходящий asset Xray-windows-64.zip в последнем релизе"
        }
        Write-Host "    Версия: $($releaseInfo.tag_name), файл: $($asset.name)"
        $tmpZip = Join-Path $env:TEMP "xray-windows-64.zip"
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmpZip -UseBasicParsing

        $tmpExtract = Join-Path $env:TEMP "xray-extract"
        if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force }
        Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force

        Copy-Item (Join-Path $tmpExtract "xray.exe") $xrayExe -Force
        $geoip = Join-Path $tmpExtract "geoip.dat"
        $geosite = Join-Path $tmpExtract "geosite.dat"
        if (Test-Path $geoip)   { Copy-Item $geoip   (Join-Path $DIR "geoip.dat")   -Force }
        if (Test-Path $geosite) { Copy-Item $geosite (Join-Path $DIR "geosite.dat") -Force }

        Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
        Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue

        Write-Ok "xray.exe установлен ($($releaseInfo.tag_name))"
    }
    catch {
        Write-Err "Не удалось скачать xray.exe автоматически: $($_.Exception.Message)"
        Write-Warn2 "Скачай вручную: https://github.com/XTLS/Xray-core/releases (Xray-windows-64.zip) и положи xray.exe сюда: $DIR"
    }
}
else {
    Write-Step "xray.exe - пропущено (-SkipXray)"
}

Write-Host ""

# --- 2. Python (portable, embeddable) ---
$pyEmbedDir = Join-Path $DIR "python-embed"
$pyEmbedExe = Join-Path $pyEmbedDir "python.exe"

$systemPython = $null
try { $systemPython = (Get-Command python -ErrorAction SilentlyContinue).Source } catch {}

if ((Test-Path $pyEmbedExe) -and -not $SkipPython) {
    Write-Step "Python"
    Write-Ok "уже есть портативный python-embed"
}
elseif ($systemPython -and -not $SkipPython) {
    Write-Step "Python"
    Write-Ok "найден системный python: $systemPython (портативный не нужен)"
}
elseif (-not $SkipPython) {
    Write-Step "Скачиваю портативный Python $PythonVersion (embeddable package) ..."
    try {
        $pyUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
        $tmpZip = Join-Path $env:TEMP "python-embed.zip"
        Invoke-WebRequest -Uri $pyUrl -OutFile $tmpZip -UseBasicParsing

        if (Test-Path $pyEmbedDir) { Remove-Item $pyEmbedDir -Recurse -Force }
        New-Item -ItemType Directory -Path $pyEmbedDir | Out-Null
        Expand-Archive -Path $tmpZip -DestinationPath $pyEmbedDir -Force
        Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue

        # Embeddable python по умолчанию не подхватывает site-packages/скрипты вне zip -
        # для наших нужд (только stdlib: json, struct, subprocess, logging) это не требуется,
        # но на всякий случай раскомментируем "import site" в ._pth файле.
        $pthFile = Get-ChildItem -Path $pyEmbedDir -Filter "python*._pth" | Select-Object -First 1
        if ($pthFile) {
            (Get-Content $pthFile.FullName) -replace '^#import site', 'import site' | Set-Content $pthFile.FullName
        }

        Write-Ok "python-embed установлен: $pyEmbedExe"
    }
    catch {
        Write-Err "Не удалось скачать embeddable Python: $($_.Exception.Message)"
        Write-Warn2 "Установи Python вручную с python.org (отметь 'Add to PATH') либо положи embeddable package в $pyEmbedDir"
    }
}
else {
    Write-Step "Python - пропущено (-SkipPython)"
}

Write-Host ""

# --- 3. Проверка/выбор порта ---
function Test-PortFree($port) {
    $busy = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    return -not $busy
}

function Find-FreePort($startPort) {
    $p = $startPort
    while (-not (Test-PortFree $p) -and $p -lt ($startPort + 200)) { $p += 10 }
    return $p
}

Write-Step "Проверка порта ..."
$desiredPort = 1080
$portFile = Join-Path $DIR "port.txt"
if (Test-Path $portFile) {
    $saved = Get-Content $portFile -Raw
    if ($saved -match '^\d+$') { $desiredPort = [int]$saved }
}

if (Test-PortFree $desiredPort) {
    Write-Ok "порт $desiredPort свободен"
}
else {
    $newPort = Find-FreePort ($desiredPort + 10)
    Write-Warn2 "порт $desiredPort занят - использую свободный порт $newPort"
    $desiredPort = $newPort
}

Set-Content -Path $portFile -Value $desiredPort -Encoding ASCII
Write-Ok "порт сохранён в $portFile - расширение подхватит его автоматически"

Write-Host ""

# --- 4. config.json ---
$configPath = Join-Path $DIR "config.json"
$configExample = Join-Path (Split-Path (Split-Path $DIR -Parent) -Parent) "config.example.json"
Write-Step "config.json"
if (Test-Path $configPath) {
    Write-Ok "уже есть: $configPath"
}
elseif (Test-Path $configExample) {
    $tpl = Get-Content $configExample -Raw
    $tpl = $tpl -replace '"port":\s*1080', "`"port`": $desiredPort"
    $tpl = $tpl -replace '"port":\s*1081', "`"port`": $($desiredPort + 1)"
    Set-Content -Path $configPath -Value $tpl -Encoding UTF8
    Write-Warn2 "создан из шаблона config.example.json (порты $desiredPort/$($desiredPort+1)) - добавь свою VLESS-ссылку через popup расширения, конфиг перезапишется автоматически"
}
else {
    Write-Warn2 "config.json не найден, но это нормально - создастся автоматически при первом добавлении vless:// ссылки в popup расширения"
}

Write-Host ""

Write-Host ""

# --- 5. Регистрация Native Messaging host ---
Write-Step "Регистрация native messaging host ($Browser) ..."
$escapedPath = $BatPath -replace '\\', '\\\\'

if ($Browser -eq "chrome") {
    # ID закреплён через поле "key" в extension-chrome/manifest.json - всегда
    # одинаковый, независимо от того, как расширение загружено в Chrome.
    $ChromeId = "ideebniacigmfjjmmacnjligjgclgfif"
    $originLine = "`"allowed_origins`": [`"chrome-extension://$ChromeId/`"]"
    $regRoot = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\vless_switch_host"
} else {
    $originLine = "`"allowed_extensions`": [`"vless-switch@boris.local`"]"
    $regRoot = "HKCU:\Software\Mozilla\NativeMessagingHosts\vless_switch_host"
}

$manifest = @"
{
  "name": "vless_switch_host",
  "description": "Native host for VLESS Switch extension - controls xray.exe",
  "path": "$escapedPath",
  "type": "stdio",
  $originLine
}
"@
Set-Content -Path $JsonPath -Value $manifest -Encoding UTF8
Write-Ok "манифест: $JsonPath"

New-Item -Path $regRoot -Force | Out-Null
Set-ItemProperty -Path $regRoot -Name "(default)" -Value $JsonPath
Write-Ok "зарегистрировано в реестре ($regRoot, без прав администратора)"

Write-Host ""
Write-Host "============================================"
Write-Host "   Установка завершена"
Write-Host "============================================"
Write-Host ""

$rootDir = Split-Path (Split-Path $DIR -Parent) -Parent

function Get-BrowserExePath($exeName) {
    $regPaths = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exeName",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\$exeName",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exeName"
    )
    foreach ($p in $regPaths) {
        try {
            $val = (Get-ItemProperty -Path $p -ErrorAction Stop).'(default)'
            if ($val -and (Test-Path $val)) { return $val }
        } catch {}
    }
    return $null
}

if ($Browser -eq "chrome") {
    $exePath = Get-BrowserExePath "chrome.exe"
    # Chrome с версии 55 блокирует переход на chrome:// страницы через
    # аргумент командной строки (защита от вредоносных программ) - просто
    # запускаем сам браузер, а адрес просим ввести вручную.
    $url = $null
    $urlToType = "chrome://extensions"
    $folder = Join-Path $rootDir "extension-chrome"
    $instructions = @(
        "Открой Chrome и вставь в адресную строку: $urlToType",
        "Включи 'Режим разработчика' (переключатель справа вверху),",
        "  затем 'Загрузить распакованное расширение' и выбери открывшуюся папку."
    )
} else {
    $exePath = Get-BrowserExePath "firefox.exe"
    $url = "about:debugging#/runtime/this-firefox"
    $folder = Join-Path $rootDir "extension-firefox"
    $instructions = @(
        "Firefox: нажми 'Загрузить временное дополнение' и выбери manifest.json",
        "  из открывшейся папки."
    )
}

Write-Step "Открываю браузер ..."
if ($exePath) {
    if ($url) {
        Start-Process -FilePath $exePath -ArgumentList $url
        Write-Ok "открыт $Browser -> $url"
    } else {
        Start-Process -FilePath $exePath
        Write-Ok "открыт $Browser (адрес нужно ввести вручную - см. инструкцию ниже)"
    }
} else {
    Write-Warn2 "не нашёл $Browser автоматически - открой вручную"
}

# Копируем путь к папке с расширением в буфер обмена вместо открытия Explorer
Set-Clipboard -Value $folder
Write-Ok "путь к папке расширения скопирован в буфер обмена: $folder"

Write-Host ""
Write-Host "================================================"
Write-Host "  ЧТО ДЕЛАТЬ ДАЛЬШЕ"
Write-Host "================================================"
Write-Host ""
$step = 1
foreach ($line in $instructions) {
    if ($line -notmatch "^  ") {
        Write-Host "  $step. $line"
        $step++
    } else {
        Write-Host "     $($line.Trim())"
    }
}
Write-Host "  $step. В открывшемся диалоге выбора файла/папки нажми Ctrl+V,"
Write-Host "     чтобы вставить скопированный путь, и подтверди выбор."
$step++
Write-Host "  $step. Открой popup расширения (иконка в панели браузера),"
Write-Host "     вставь свою vless:// ссылку и включи тумблер."
Write-Host ""
Read-Host "Нажми Enter для выхода"
