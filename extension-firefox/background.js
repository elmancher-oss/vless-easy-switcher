// background.js
// Логика: если enabled=true и домен запроса матчит одно из правил (или mode="all"),
// заворачиваем через локальный SOCKS5 (127.0.0.1:1080, там слушает Xray-core с VLESS+Reality outbound).
// Иначе — direct.

const DEFAULT_STATE = {
  enabled: true,
  mode: "selective", // "selective" — только правила, "all" — вообще всё через прокси
  proxyHost: "127.0.0.1",
  proxyPort: 1080,
  proxyType: "socks", // "socks" | "http" (http использует порт 1081 из config.json)
  rules: [], // [{ domain: "instagram.com", enabled: true }]
  vlessConfigs: [], // [{ id, remark, uuid, address, port, security, sni, pbk, sid, fp, spx, type, flow, encryption }]
  activeConfigId: null,
  portManuallySet: false
};

async function getState() {
  const stored = await browser.storage.local.get(DEFAULT_STATE);
  return { ...DEFAULT_STATE, ...stored };
}

// --- Логирование ---
const MAX_LOGS = 200;
let logBuffer = [];

async function loadLogsFromStorage() {
  const stored = await browser.storage.local.get({ logs: [] });
  logBuffer = stored.logs || [];
}
loadLogsFromStorage();

let logSaveTimer = null;
function addLog(entry) {
  const item = { time: new Date().toISOString(), ...entry };
  logBuffer.push(item);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer = logBuffer.slice(logBuffer.length - MAX_LOGS);
  }
  console.log("[VLESS Switch]", item.time, item.type, item);
  // Дебаунс записи в storage, чтобы не долбить диск на каждый запрос
  if (logSaveTimer) clearTimeout(logSaveTimer);
  logSaveTimer = setTimeout(() => {
    browser.storage.local.set({ logs: logBuffer }).catch(() => {});
  }, 500);
}

async function clearLogs() {
  logBuffer = [];
  await browser.storage.local.set({ logs: [] });
}


function domainMatches(host, ruleDomain) {
  if (!host || !ruleDomain) return false;
  host = host.toLowerCase();
  ruleDomain = ruleDomain.toLowerCase().replace(/^\*\./, "");
  return host === ruleDomain || host.endsWith("." + ruleDomain);
}

let cachedState = null;
async function refreshCache() {
  const prevEnabled = cachedState ? cachedState.enabled : null;
  cachedState = await getState();
  if (prevEnabled !== null && prevEnabled !== cachedState.enabled) {
    addLog({ type: "toggle", enabled: cachedState.enabled });
    if (cachedState.enabled) {
      startNativeXray();
    } else {
      stopNativeXray();
    }
  }
}
refreshCache();
browser.storage.onChanged.addListener(refreshCache);

// --- Native messaging: старт/стоп xray.exe через host.py ---
let nativePort = null;
let nativeStatus = "unknown"; // "running" | "stopped" | "error" | "unknown"

// --- Парсинг vless:// ссылок и управление несколькими конфигами ---

function parseVlessLink(link) {
  // vless://uuid@host:port?params#remark
  const m = link.match(/^vless:\/\/([^@]+)@([^:]+):(\d+)\?([^#]*)#?(.*)$/);
  if (!m) throw new Error("Не похоже на vless:// ссылку");
  const [, uuid, address, port, query, remarkRaw] = m;
  const params = new URLSearchParams(query);
  return {
    id: `${address}-${port}-${Date.now()}`,
    remark: decodeURIComponent(remarkRaw || "") || `${address}:${port}`,
    uuid,
    address,
    port: parseInt(port, 10),
    encryption: params.get("encryption") || "none",
    flow: params.get("flow") || "",
    security: params.get("security") || "none",
    sni: params.get("sni") || "",
    fp: params.get("fp") || "chrome",
    pbk: params.get("pbk") || "",
    sid: params.get("sid") || "",
    spx: params.get("spx") ? decodeURIComponent(params.get("spx")) : "",
    type: params.get("type") || "tcp",
  };
}

function buildXrayConfig(cfg, proxyPort) {
  const outbound = {
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: cfg.address,
          port: cfg.port,
          users: [
            {
              id: cfg.uuid,
              encryption: cfg.encryption || "none",
              flow: cfg.flow || "",
            },
          ],
        },
      ],
    },
    streamSettings: {
      network: cfg.type || "tcp",
      security: cfg.security || "none",
    },
    tag: "vless-out",
  };
  // mux (мультиплексирование) снижает число TLS-хендшейков на высоколатентных
  // сетях (мобильный интернет и т.п.), но несовместим с XTLS flow-control
  if (!cfg.flow) {
    outbound.mux = { enabled: true, concurrency: 8 };
  }

  if (cfg.security === "reality") {
    outbound.streamSettings.realitySettings = {
      serverName: cfg.sni,
      fingerprint: cfg.fp || "chrome",
      publicKey: cfg.pbk,
      shortId: cfg.sid || "",
      spiderX: cfg.spx || "",
    };
  } else if (cfg.security === "tls") {
    outbound.streamSettings.tlsSettings = {
      serverName: cfg.sni,
      fingerprint: cfg.fp || "chrome",
    };
  }

  return {
    log: { loglevel: "warning" },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: proxyPort,
        protocol: "socks",
        settings: { auth: "noauth", udp: true },
        sniffing: { enabled: true, destOverride: ["http", "tls"] },
        tag: "socks-in",
      },
      {
        listen: "127.0.0.1",
        port: proxyPort + 1,
        protocol: "http",
        settings: {},
        tag: "http-in",
      },
    ],
    outbounds: [
      outbound,
      { protocol: "freedom", settings: {}, tag: "direct" },
      { protocol: "blackhole", settings: {}, tag: "block" },
    ],
    routing: {
      domainStrategy: "AsIs",
      rules: [
        {
          type: "field",
          inboundTag: ["socks-in", "http-in"],
          outboundTag: "vless-out",
        },
      ],
    },
  };
}

async function applyActiveConfig() {
  const state = await getState();
  const active = (state.vlessConfigs || []).find((c) => c.id === state.activeConfigId);
  if (!active) {
    addLog({ type: "config", event: "apply-failed", reason: "no active config" });
    return { ok: false, message: "Нет активного конфига" };
  }
  const xrayConfig = buildXrayConfig(active, state.proxyPort || 1080);
  ensureNativeConnected();
  if (!nativePort) {
    return { ok: false, message: "Нет соединения с native host" };
  }
  addLog({ type: "config", event: "apply", remark: active.remark });
  nativePort.postMessage({ action: "apply-config", config: xrayConfig });
  return { ok: true };
}

function connectNative() {
  try {
    nativePort = browser.runtime.connectNative("vless_switch_host");
    addLog({ type: "native", event: "connect" });
    nativePort.onMessage.addListener((msg) => {
      nativeStatus = msg.status || "unknown";
      addLog({ type: "native", event: "message", payload: msg });
      if (msg.status === "error") {
        console.error("VLESS Switch native host error:", msg.message);
      }
      if (typeof msg.port === "number") {
        adoptSuggestedPort(msg.port);
      }
      browser.runtime.sendMessage({ type: "native-status", payload: msg }).catch(() => {});
    });
    nativePort.onDisconnect.addListener(() => {
      const err = browser.runtime.lastError;
      addLog({ type: "native", event: "disconnect", error: err ? err.message : null });
      if (err) console.error("Native host disconnected:", err.message);
      nativePort = null;
      nativeStatus = "unknown";
    });
  } catch (e) {
    addLog({ type: "native", event: "connect-failed", error: String(e) });
    console.error("Failed to connect native host:", e);
    nativePort = null;
  }
}

function ensureNativeConnected() {
  if (!nativePort) connectNative();
}

function startNativeXray() {
  ensureNativeConnected();
  if (nativePort) nativePort.postMessage({ action: "start" });
}

function stopNativeXray() {
  ensureNativeConnected();
  if (nativePort) nativePort.postMessage({ action: "stop" });
}

function requestNativeStatus() {
  ensureNativeConnected();
  if (nativePort) nativePort.postMessage({ action: "status" });
}

let lastAdoptedPort = null;
async function adoptSuggestedPort(port) {
  if (port === lastAdoptedPort) return;
  const state = await getState();
  if (state.proxyPort === port) {
    lastAdoptedPort = port;
    return;
  }
  // Подхватываем порт, выбранный install.ps1 (port.txt), только если пользователь
  // ещё не задал свой собственный вручную (флаг portManuallySet)
  if (!state.portManuallySet) {
    state.proxyPort = port;
    await browser.storage.local.set({ proxyPort: port });
    addLog({ type: "config", event: "port-adopted", port });
    lastAdoptedPort = port;
  }
}

function setManualPort(port) {
  return browser.storage.local.set({ proxyPort: port, portManuallySet: true }).then(() => {
    ensureNativeConnected();
    if (nativePort) nativePort.postMessage({ action: "set-port", port });
    addLog({ type: "config", event: "port-set-manual", port });
  });
}

// При старте браузера — синхронизируем xray с сохранённым состоянием enabled
(async () => {
  const state = await getState();
  if (state.enabled) {
    startNativeXray();
  } else {
    requestNativeStatus();
  }
  ensureNativeConnected();
  if (nativePort) nativePort.postMessage({ action: "get-port" });
})();

// Popup может запросить текущий статус нативного хоста
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "get-native-status") {
    requestNativeStatus();
    sendResponse({ status: nativeStatus });
  }
  if (msg && msg.type === "get-logs") {
    sendResponse({ logs: logBuffer.slice().reverse() });
  }
  if (msg && msg.type === "clear-logs") {
    clearLogs().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  if (msg && msg.type === "parse-vless-link") {
    try {
      const parsed = parseVlessLink(msg.link);
      sendResponse({ ok: true, config: parsed });
    } catch (e) {
      sendResponse({ ok: false, message: e.message });
    }
  }
  if (msg && msg.type === "save-config") {
    (async () => {
      const state = await getState();
      state.vlessConfigs.push(msg.config);
      if (!state.activeConfigId) state.activeConfigId = msg.config.id;
      await browser.storage.local.set(state);
      addLog({ type: "config", event: "saved", remark: msg.config.remark });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg && msg.type === "delete-config") {
    (async () => {
      const state = await getState();
      state.vlessConfigs = state.vlessConfigs.filter((c) => c.id !== msg.id);
      if (state.activeConfigId === msg.id) {
        state.activeConfigId = state.vlessConfigs.length ? state.vlessConfigs[0].id : null;
      }
      await browser.storage.local.set(state);
      addLog({ type: "config", event: "deleted", id: msg.id });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg && msg.type === "set-active-config") {
    (async () => {
      const state = await getState();
      state.activeConfigId = msg.id;
      await browser.storage.local.set(state);
      const result = await applyActiveConfig();
      sendResponse(result);
    })();
    return true;
  }
  if (msg && msg.type === "apply-active-config") {
    applyActiveConfig().then((r) => sendResponse(r));
    return true;
  }
  if (msg && msg.type === "get-configs") {
    (async () => {
      const state = await getState();
      sendResponse({ configs: state.vlessConfigs || [], activeId: state.activeConfigId });
    })();
    return true;
  }
  if (msg && msg.type === "get-proxy-port") {
    getState().then((state) => sendResponse({ port: state.proxyPort || 1080 }));
    return true;
  }
  if (msg && msg.type === "set-proxy-port") {
    (async () => {
      await setManualPort(msg.port);
      const result = await applyActiveConfig();
      sendResponse({ ok: true, applyResult: result });
    })();
    return true;
  }
  if (msg && msg.type === "apply-profile") {
    ensureNativeConnected();
    addLog({ type: "profile", event: "apply-requested" });
    if (!nativePort) {
      sendResponse({ status: "error", message: "native host не подключен" });
      return;
    }
    const oneShotListener = (response) => {
      nativePort.onMessage.removeListener(oneShotListener);
      addLog({ type: "profile", event: "apply-result", result: response });
      sendResponse(response);
    };
    nativePort.onMessage.addListener(oneShotListener);
    nativePort.postMessage({ action: "apply_config", config: msg.config });
    return true; // async response
  }
});

function directResult() {
  return { type: "direct" };
}

function proxyResult(state) {
  return {
    type: state.proxyType === "http" ? "http" : "socks",
    host: state.proxyHost,
    port: state.proxyType === "http" ? 1081 : state.proxyPort
  };
}

const recentRouteLog = new Map(); // host -> timestamp of last log
const ROUTE_LOG_THROTTLE_MS = 5000;

function shouldLogRoute(host, decision) {
  const key = host + "|" + decision;
  const now = Date.now();
  const last = recentRouteLog.get(key);
  if (last && now - last < ROUTE_LOG_THROTTLE_MS) return false;
  recentRouteLog.set(key, now);
  return true;
}

function isPrivateOrLocalHost(host) {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local")) return true;
  // IPv4 private ranges + loopback + link-local
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = parseInt(ipv4[1], 10);
    const b = parseInt(ipv4[2], 10);
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  if (h === "::1") return true; // IPv6 loopback
  return false;
}

browser.proxy.onRequest.addListener(
  (requestInfo) => {
    const state = cachedState || DEFAULT_STATE;

    let host;
    try {
      host = new URL(requestInfo.url).hostname;
    } catch (e) {
      return directResult();
    }

    // Локальные/приватные адреса всегда напрямую, независимо от режима
    if (isPrivateOrLocalHost(host)) {
      return directResult();
    }

    if (!state.enabled) {
      if (shouldLogRoute(host, "direct")) {
        addLog({ type: "route", url_host: host, decision: "direct", reason: "disabled" });
      }
      return directResult();
    }

    if (state.mode === "all") {
      if (shouldLogRoute(host, "proxy")) {
        addLog({ type: "route", url_host: host, decision: "proxy", reason: "mode=all" });
      }
      return proxyResult(state);
    }

    // selective mode: только домены из списка с enabled=true
    const match = state.rules.some(
      (r) => r.enabled && domainMatches(host, r.domain)
    );
    if (match && shouldLogRoute(host, "proxy")) {
      addLog({ type: "route", url_host: host, decision: "proxy", reason: "rule-match" });
    }
    return match ? proxyResult(state) : directResult();
  },
  { urls: ["<all_urls>"] }
);

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return url;
  }
}

// Уведомление об ошибках прокси (например, Xray-core не запущен)
browser.proxy.onError.addListener((error) => {
  console.error("VLESS Switch proxy error:", error);
  addLog({ type: "proxy-error", message: String(error) });
});
