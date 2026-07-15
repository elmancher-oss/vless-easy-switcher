#!/usr/bin/env python3
"""
Native messaging host для VLESS Switch.
Получает команды от Firefox-расширения через stdin/stdout (протокол Native Messaging)
и управляет процессом xray.exe (старт/стоп/статус).

Кладётся рядом с xray.exe и config.json (или пропиши полные пути ниже в XRAY_EXE / XRAY_CONFIG).
"""

import sys
import os
import json
import struct
import subprocess
import atexit
import logging
from datetime import datetime

import platform

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
XRAY_BIN_NAME = "xray.exe" if platform.system() == "Windows" else "xray"
XRAY_EXE = os.path.join(BASE_DIR, XRAY_BIN_NAME)
XRAY_CONFIG = os.path.join(BASE_DIR, "config.json")
LOG_FILE = os.path.join(BASE_DIR, "vless_switch_host.log")
XRAY_LOG_FILE = os.path.join(BASE_DIR, "xray_process.log")

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("vless_switch_host")

proc = None
xray_log_fp = None


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    message_length = struct.unpack("=I", raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode("utf-8")
    parsed = json.loads(message)
    logger.info("<- received: %s", parsed)
    return parsed


def send_message(obj):
    logger.info("-> sending: %s", obj)
    encoded = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def is_running():
    return proc is not None and proc.poll() is None


def start_xray():
    global proc, xray_log_fp
    if is_running():
        logger.info("start_xray: already running (pid=%s)", proc.pid)
        return {"status": "running", "pid": proc.pid}

    if not os.path.isfile(XRAY_EXE):
        logger.error("start_xray: %s not found at %s", XRAY_BIN_NAME, XRAY_EXE)
        return {"status": "error", "message": f"{XRAY_BIN_NAME} не найден: {XRAY_EXE}"}
    if not os.path.isfile(XRAY_CONFIG):
        logger.error("start_xray: config.json not found at %s", XRAY_CONFIG)
        return {"status": "error", "message": f"config.json не найден: {XRAY_CONFIG}"}

    try:
        creationflags = 0
        if os.name == "nt":
            creationflags = subprocess.CREATE_NO_WINDOW

        xray_log_fp = open(XRAY_LOG_FILE, "a", encoding="utf-8")
        xray_log_fp.write(f"\n--- xray started {datetime.now().isoformat()} ---\n")
        xray_log_fp.flush()

        proc = subprocess.Popen(
            [XRAY_EXE, "run", "-c", XRAY_CONFIG],
            cwd=BASE_DIR,
            stdout=xray_log_fp,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
        )
        logger.info("start_xray: started pid=%s", proc.pid)
        return {"status": "running", "pid": proc.pid, "port": get_saved_port()}
    except Exception as e:
        logger.exception("start_xray: failed to start")
        return {"status": "error", "message": str(e)}


def stop_xray():
    global proc, xray_log_fp
    if is_running():
        logger.info("stop_xray: terminating pid=%s", proc.pid)
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            logger.warning("stop_xray: terminate timed out, killing")
            try:
                proc.kill()
            except Exception:
                logger.exception("stop_xray: kill failed")
    else:
        logger.info("stop_xray: not running")
    proc = None
    if xray_log_fp:
        try:
            xray_log_fp.write(f"--- xray stopped {datetime.now().isoformat()} ---\n")
            xray_log_fp.close()
        except Exception:
            pass
        xray_log_fp = None
    return {"status": "stopped"}


def status_xray():
    if is_running():
        return {"status": "running", "pid": proc.pid, "port": get_saved_port()}
    return {"status": "stopped", "port": get_saved_port()}


@atexit.register
def cleanup():
    logger.info("cleanup: host exiting, stopping xray")
    stop_xray()


PORT_FILE = os.path.join(BASE_DIR, "port.txt")


def get_saved_port():
    try:
        with open(PORT_FILE, "r", encoding="utf-8") as f:
            val = f.read().strip()
            if val.isdigit():
                return int(val)
    except Exception:
        pass
    return 1080


def apply_config(config_obj):
    try:
        with open(XRAY_CONFIG, "w", encoding="utf-8") as f:
            json.dump(config_obj, f, ensure_ascii=False, indent=2)
        logger.info("apply_config: wrote new config.json")
    except Exception as e:
        logger.exception("apply_config: failed to write config")
        return {"status": "error", "message": f"Не удалось записать config.json: {e}"}

    was_running = is_running()
    if was_running:
        stop_xray()
    result = start_xray()
    if result.get("status") == "running":
        result["status"] = "config-applied"
    return result


def main():
    logger.info("=== native host started ===")
    while True:
        try:
            msg = read_message()
        except Exception:
            logger.exception("main: error reading message")
            break
        if msg is None:
            logger.info("main: stdin closed (Firefox disconnected)")
            break

        action = msg.get("action")
        if action == "start":
            send_message(start_xray())
        elif action == "stop":
            send_message(stop_xray())
        elif action == "status":
            send_message(status_xray())
        elif action == "apply-config":
            send_message(apply_config(msg.get("config", {})))
        elif action == "get-port":
            send_message({"status": "port", "port": get_saved_port()})
        elif action == "set-port":
            new_port = msg.get("port")
            try:
                with open(PORT_FILE, "w", encoding="utf-8") as f:
                    f.write(str(int(new_port)))
                logger.info("set-port: saved port=%s", new_port)
                send_message({"status": "port", "port": int(new_port)})
            except Exception as e:
                logger.exception("set-port: failed")
                send_message({"status": "error", "message": str(e)})
        else:
            logger.warning("main: unknown action received: %s", action)
            send_message({"status": "error", "message": f"unknown action: {action}"})

    # Firefox закрыл соединение (расширение выгружено / браузер закрыт) — гасим xray
    stop_xray()
    logger.info("=== native host exiting ===")


if __name__ == "__main__":
    main()
