// background.js (Chrome MV3 вариант)
// В отличие от Firefox, у Chrome нет browser.proxy.onRequest (колбэк на каждый
// запрос) - MV3 требует либо fixed_servers (всё через прокси), либо
// pac_script. Чтобы получить точечную маршрутизацию по доменам, как в
// Firefox-версии, генерируем PAC-скрипт из правил и отдаём его через
// chrome.proxy.settings.set({ mode: "pac_script", ... }).

if (typeof browser === "undefined") { var browser = chrome; }

const DEFAULT_STATE = {
  enabled: true,
  mode: "selective",
  proxyHost: "127.0.0.1",
  proxyPort: 1080,
  proxyType: "socks",
  rules: [],
  vlessConfigs: [],
  activeConfigId: null,
  portManuallySet: false
};

async function getState() {
  const stored = await chrome.storage.local.get(DEFAULT_STATE);
  return { ...DEFAULT_STATE, ...stored };
}

// --- Логирование (как в Firefox-версии) ---
const MAX_LOGS = 200;
let logBuffer = [];
async function loadLogsFromStorage() {
  const stored = await chrome.storage.local.get({ logs: [] });
  logBuffer = stored.logs || [];
}
loadLogsFromStorage();

let logSaveTimer = null;
function addLog(entry) {
  const item = { time: new Date().toISOString(), ...entry };
  logBuffer.push(item);
  if (logBuffer.length > MAX_LOGS) logBuffer = logBuffer.slice(logBuffer.length - MAX_LOGS);
  console.log("[VLESS Switch]", item.time, item.type, item);
  if (logSaveTimer) clearTimeout(logSaveTimer);
  logSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ logs: logBuffer }).catch(() => {});
  }, 500);
}
async function clearLogs() {
  logBuffer = [];
  await chrome.storage.local.set({ logs: [] });
}

// --- Генерация PAC-скрипта из правил ---
function buildPacScript(state) {
  const proxyLine = state.proxyType === "http"
    ? `PROXY ${state.proxyHost}:${state.proxyPort + 1}`
    : `SOCKS5 ${state.proxyHost}:${state.proxyPort}`;

  const rulesJs = JSON.stringify(
    (state.rules || []).filter((r) => r.enabled).map((r) => r.domain.toLowerCase())
  );

  return `
function FindProxyForURL(url, host) {
  host = host.toLowerCase();

  // Local/private addresses - always direct
  if (host === "localhost" || dnsDomainIs(host, ".local")) return "DIRECT";
  if (isInNet(host, "127.0.0.0", "255.0.0.0")) return "DIRECT";
  if (isInNet(host, "10.0.0.0", "255.0.0.0")) return "DIRECT";
  if (isInNet(host, "192.168.0.0", "255.255.0.0")) return "DIRECT";
  if (isInNet(host, "172.16.0.0", "255.240.0.0")) return "DIRECT";
  if (isInNet(host, "169.254.0.0", "255.255.0.0")) return "DIRECT";

  ${state.enabled ? "" : "return \"DIRECT\";"}

  ${state.mode === "all" ? `return "${proxyLine}";` : `
  var rules = ${rulesJs};
  for (var i = 0; i < rules.length; i++) {
    var d = rules[i];
    if (host === d || host.endsWith("." + d)) {
      return "${proxyLine}";
    }
  }
  return "DIRECT";
  `}
}
`.trim();
}

async function applyProxySettings() {
  const state = await getState();
  const pacScript = buildPacScript(state);
  await chrome.proxy.settings.set({
    value: { mode: "pac_script", pacScript: { data: pacScript } },
    scope: "regular"
  });
  addLog({ type: "pac", event: "applied", mode: state.mode, rulesCount: (state.rules || []).length });
}

// Применяем PAC при любом изменении релевантных полей state
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled || changes.mode || changes.rules || changes.proxyPort || changes.proxyType || changes.proxyHost) {
    applyProxySettings();
  }
});

// Применяем один раз при старте service worker
applyProxySettings();

// --- Парсинг vless:// и сборка xray-конфига (идентично Firefox-версии) ---
function parseVlessLink(link) {
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
      vnext: [{ address: cfg.address, port: cfg.port, users: [{ id: cfg.uuid, encryption: cfg.encryption || "none", flow: cfg.flow || "" }] }]
    },
    streamSettings: { network: cfg.type || "tcp", security: cfg.security || "none" },
    tag: "vless-out"
  };
  // mux снижает число TLS-хендшейков на высоколатентных сетях, но несовместим с XTLS flow
  if (!cfg.flow) {
    outbound.mux = { enabled: true, concurrency: 8 };
  }
  if (cfg.security === "reality") {
    outbound.streamSettings.realitySettings = {
      serverName: cfg.sni, fingerprint: cfg.fp || "chrome", publicKey: cfg.pbk, shortId: cfg.sid || "", spiderX: cfg.spx || ""
    };
  } else if (cfg.security === "tls") {
    outbound.streamSettings.tlsSettings = { serverName: cfg.sni, fingerprint: cfg.fp || "chrome" };
  }
  return {
    log: { loglevel: "warning" },
    inbounds: [
      { listen: "127.0.0.1", port: proxyPort, protocol: "socks", settings: { auth: "noauth", udp: true }, sniffing: { enabled: true, destOverride: ["http", "tls"] }, tag: "socks-in" },
      { listen: "127.0.0.1", port: proxyPort + 1, protocol: "http", settings: {}, tag: "http-in" }
    ],
    outbounds: [outbound, { protocol: "freedom", settings: {}, tag: "direct" }, { protocol: "blackhole", settings: {}, tag: "block" }],
    routing: { domainStrategy: "AsIs", rules: [{ type: "field", inboundTag: ["socks-in", "http-in"], outboundTag: "vless-out" }] }
  };
}

async function applyActiveConfig() {
  const state = await getState();
  const active = (state.vlessConfigs || []).find((c) => c.id === state.activeConfigId);
  if (!active) return { ok: false, message: "Нет активного конфига" };
  const xrayConfig = buildXrayConfig(active, state.proxyPort || 1080);
  ensureNativeConnected();
  if (!nativePort) return { ok: false, message: "Нет соединения с native host" };
  addLog({ type: "config", event: "apply", remark: active.remark });
  nativePort.postMessage({ action: "apply-config", config: xrayConfig });
  return { ok: true };
}

// --- Native Messaging (Chrome требует allowed_origins с chrome-extension://ID/
//     в манифесте нативного хоста - см. native-host/vless_switch_host_chrome.json) ---
let nativePort = null;
let nativeStatus = "unknown";
let lastAdoptedPort = null;

function connectNative() {
  try {
    nativePort = chrome.runtime.connectNative("vless_switch_host");
    addLog({ type: "native", event: "connect" });
    nativePort.onMessage.addListener((msg) => {
      nativeStatus = msg.status || "unknown";
      addLog({ type: "native", event: "message", payload: msg });
      if (typeof msg.port === "number") adoptSuggestedPort(msg.port);
      chrome.runtime.sendMessage({ type: "native-status", payload: msg }).catch(() => {});
    });
    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      addLog({ type: "native", event: "disconnect", error: err ? err.message : null });
      nativePort = null;
      nativeStatus = "unknown";
    });
  } catch (e) {
    addLog({ type: "native", event: "connect-failed", error: String(e) });
    nativePort = null;
  }
}

function ensureNativeConnected() {
  if (!nativePort) connectNative();
}

async function adoptSuggestedPort(port) {
  if (port === lastAdoptedPort) return;
  const state = await getState();
  if (state.proxyPort === port) { lastAdoptedPort = port; return; }
  if (!state.portManuallySet) {
    await chrome.storage.local.set({ proxyPort: port });
    addLog({ type: "config", event: "port-adopted", port });
    lastAdoptedPort = port;
  }
}

function setManualPort(port) {
  return chrome.storage.local.set({ proxyPort: port, portManuallySet: true }).then(() => {
    ensureNativeConnected();
    if (nativePort) nativePort.postMessage({ action: "set-port", port });
    addLog({ type: "config", event: "port-set-manual", port });
  });
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

(async () => {
  const state = await getState();
  if (state.enabled) startNativeXray(); else requestNativeStatus();
  ensureNativeConnected();
  if (nativePort) nativePort.postMessage({ action: "get-port" });
})();

let cachedEnabled = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  const newVal = changes.enabled.newValue;
  if (cachedEnabled !== null && cachedEnabled !== newVal) {
    addLog({ type: "toggle", enabled: newVal });
    if (newVal) startNativeXray(); else stopNativeXray();
  }
  cachedEnabled = newVal;
});

// --- Сообщения от popup ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "get-native-status") {
    requestNativeStatus();
    sendResponse({ status: nativeStatus });
  }
  if (msg && msg.type === "get-logs") {
    sendResponse({ logs: logBuffer.slice().reverse() });
  }
  if (msg && msg.type === "clear-logs") {
    clearLogs().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg && msg.type === "parse-vless-link") {
    try {
      sendResponse({ ok: true, config: parseVlessLink(msg.link) });
    } catch (e) {
      sendResponse({ ok: false, message: e.message });
    }
  }
  if (msg && msg.type === "save-config") {
    (async () => {
      const state = await getState();
      state.vlessConfigs.push(msg.config);
      if (!state.activeConfigId) state.activeConfigId = msg.config.id;
      await chrome.storage.local.set(state);
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
      await chrome.storage.local.set(state);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg && msg.type === "set-active-config") {
    (async () => {
      const state = await getState();
      state.activeConfigId = msg.id;
      await chrome.storage.local.set(state);
      sendResponse(await applyActiveConfig());
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
      sendResponse({ ok: true, applyResult: await applyActiveConfig() });
    })();
    return true;
  }
});
