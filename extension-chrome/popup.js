if (typeof browser === "undefined") { var browser = chrome; }

const DEFAULT_STATE = {
  enabled: true,
  mode: "selective",
  proxyHost: "127.0.0.1",
  proxyPort: 1080,
  proxyType: "socks",
  rules: []
};

let state = { ...DEFAULT_STATE };
let currentHost = null;

async function loadState() {
  const stored = await browser.storage.local.get(DEFAULT_STATE);
  state = { ...DEFAULT_STATE, ...stored };
}

async function saveState() {
  await browser.storage.local.set(state);
}

function domainMatches(host, ruleDomain) {
  host = host.toLowerCase();
  ruleDomain = ruleDomain.toLowerCase().replace(/^\*\./, "");
  return host === ruleDomain || host.endsWith("." + ruleDomain);
}

function isCurrentActive() {
  if (!state.enabled) return false;
  if (state.mode === "all") return true;
  if (!currentHost) return false;
  return state.rules.some((r) => r.enabled && domainMatches(currentHost, r.domain));
}

// --- Навигация между экранами ---
function navigateTo(view) {
  document.querySelectorAll(".view").forEach((el) => el.classList.remove("active"));
  document.getElementById("view-" + view).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach((el) => {
    el.classList.toggle("active", el.dataset.nav === view);
  });
  if (view === "configs") { loadConfigs(); loadPort(); }
  if (view === "log") loadLogs();
}

function setupNavigation() {
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.addEventListener("click", () => navigateTo(el.dataset.nav));
  });
  document.querySelectorAll("[data-back]").forEach((el) => {
    el.addEventListener("click", () => navigateTo("home"));
  });
}

function render() {
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const enabledToggle = document.getElementById("enabledToggle");

  enabledToggle.checked = state.enabled;

  document.getElementById("modeSelectiveBtn").classList.toggle("active", state.mode === "selective");
  document.getElementById("modeAllBtn").classList.toggle("active", state.mode === "all");

  const active = isCurrentActive();
  statusDot.className = "dot " + (active ? "on" : "off");
  statusText.className = "status-text " + (active ? "on" : "off");
  statusText.textContent = active ? "Защита включена" : "Защита отключена";

  const ruleCount = state.rules.length;
  document.getElementById("sitesSummary").textContent =
    state.mode === "all" ? "Режим: все сайты" :
    ruleCount === 0 ? "Нет правил" : `${ruleCount} сайт(ов) в списке`;

  document.getElementById("currentDomain").textContent = currentHost || "-";
  document.getElementById("addCurrent").disabled =
    !currentHost || state.rules.some((r) => domainMatches(currentHost, r.domain));

  const rulesEl = document.getElementById("rules");
  rulesEl.innerHTML = "";
  document.getElementById("emptyRulesMsg").style.display = state.rules.length ? "none" : "block";
  state.rules.forEach((r, idx) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent = r.domain;
    const del = document.createElement("span");
    del.className = "item-del";
    del.textContent = "\u2715";
    del.addEventListener("click", async () => {
      state.rules.splice(idx, 1);
      await saveState();
      render();
    });
    li.appendChild(name);
    li.appendChild(del);
    rulesEl.appendChild(li);
  });
}

function renderNativeStatus(status) {
  const el = document.getElementById("nativeStatus");
  if (!el) return;
  const map = {
    running: "Xray: запущен",
    stopped: "Xray: остановлен",
    error: "Xray: ошибка",
    unknown: "Xray: проверка..."
  };
  el.textContent = map[status] || "Xray: -";
}

// --- Конфиги ---
async function loadConfigs() {
  const resp = await browser.runtime.sendMessage({ type: "get-configs" });
  const configs = (resp && resp.configs) || [];
  const activeId = resp && resp.activeId;

  document.getElementById("configsSummary").textContent =
    configs.length === 0 ? "Не добавлено" :
    `${configs.length} конфиг(ов)` + (activeId ? " · активен выбран" : "");

  const listEl = document.getElementById("configList");
  listEl.innerHTML = "";
  document.getElementById("emptyConfigsMsg").style.display = configs.length ? "none" : "block";

  configs.forEach((cfg) => {
    const li = document.createElement("li");
    if (cfg.id === activeId) li.classList.add("active");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "activeConfig";
    radio.checked = cfg.id === activeId;
    radio.addEventListener("change", async () => {
      const r = await browser.runtime.sendMessage({ type: "set-active-config", id: cfg.id });
      if (!r || !r.ok) showCfgError((r && r.message) || "Не удалось применить конфиг");
      loadConfigs();
    });
    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent = cfg.remark;
    const del = document.createElement("span");
    del.className = "item-del";
    del.textContent = "\u2715";
    del.addEventListener("click", async () => {
      await browser.runtime.sendMessage({ type: "delete-config", id: cfg.id });
      loadConfigs();
    });
    li.appendChild(radio);
    li.appendChild(name);
    li.appendChild(del);
    listEl.appendChild(li);
  });
}

function showCfgError(msg) {
  const el = document.getElementById("cfgError");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

function setupConfigManager() {
  document.getElementById("addConfigBtn").addEventListener("click", async () => {
    const input = document.getElementById("vlessInput");
    const link = input.value.trim();
    showCfgError("");
    if (!link) return;
    const parseResp = await browser.runtime.sendMessage({ type: "parse-vless-link", link });
    if (!parseResp || !parseResp.ok) {
      showCfgError((parseResp && parseResp.message) || "Ошибка парсинга ссылки");
      return;
    }
    const saveResp = await browser.runtime.sendMessage({ type: "save-config", config: parseResp.config });
    if (!saveResp || !saveResp.ok) {
      showCfgError("Не удалось сохранить конфиг");
      return;
    }
    input.value = "";
    await loadConfigs();
    const applyResp = await browser.runtime.sendMessage({ type: "apply-active-config" });
    if (applyResp && !applyResp.ok) {
      showCfgError(applyResp.message || "Не удалось применить конфиг к xray");
    }
  });
}

async function loadPort() {
  const resp = await browser.runtime.sendMessage({ type: "get-proxy-port" });
  document.getElementById("portInput").value = (resp && resp.port) || 1080;
}

function setupPortSettings() {
  document.getElementById("savePortBtn").addEventListener("click", async () => {
    const port = parseInt(document.getElementById("portInput").value, 10);
    const msgEl = document.getElementById("portMsg");
    msgEl.style.display = "none";
    if (!port || port < 1 || port > 65535) {
      showCfgError("Некорректный порт");
      return;
    }
    showCfgError("");
    const resp = await browser.runtime.sendMessage({ type: "set-proxy-port", port });
    if (resp && resp.ok) {
      msgEl.style.display = "inline";
      setTimeout(() => { msgEl.style.display = "none"; }, 3000);
    } else {
      showCfgError("Не удалось сохранить порт");
    }
  });
}

// --- Логи ---
function formatLogEntry(entry) {
  const time = entry.time ? entry.time.slice(11, 19) : "";
  let text = "";
  let cls = "";
  if (entry.type === "route") {
    cls = entry.decision === "proxy" ? "proxy" : "direct";
    text = `${entry.decision === "proxy" ? "-> прокси" : "-> direct"} ${entry.url_host} (${entry.reason})`;
  } else if (entry.type === "toggle") {
    text = `тумблер: ${entry.enabled ? "включен" : "выключен"}`;
  } else if (entry.type === "native") {
    cls = entry.event === "connect-failed" || entry.error ? "error" : "";
    text = `native: ${entry.event}${entry.payload ? " " + JSON.stringify(entry.payload) : ""}${entry.error ? " (" + entry.error + ")" : ""}`;
  } else if (entry.type === "proxy-error") {
    cls = "error";
    text = `ошибка прокси: ${entry.message}`;
  } else if (entry.type === "config") {
    text = `config: ${entry.event}${entry.remark ? " " + entry.remark : ""}${entry.port ? " port=" + entry.port : ""}`;
  } else {
    text = JSON.stringify(entry);
  }
  return { time, text, cls };
}

async function loadLogs() {
  try {
    const resp = await browser.runtime.sendMessage({ type: "get-logs" });
    const logs = (resp && resp.logs) || [];
    const listEl = document.getElementById("logList");
    listEl.innerHTML = "";
    if (logs.length === 0) {
      const li = document.createElement("li");
      li.textContent = "Пока пусто";
      listEl.appendChild(li);
      return;
    }
    logs.slice(0, 100).forEach((entry) => {
      const { time, text, cls } = formatLogEntry(entry);
      const li = document.createElement("li");
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = time;
      const body = document.createElement("span");
      if (cls) body.className = cls;
      body.textContent = text;
      li.appendChild(t);
      li.appendChild(body);
      listEl.appendChild(li);
    });
  } catch (e) {
    console.error("loadLogs failed", e);
  }
}

function setupLogPanel() {
  document.getElementById("refreshLogs").addEventListener("click", loadLogs);
  document.getElementById("clearLogs").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "clear-logs" });
    loadLogs();
  });
}

async function init() {
  await loadState();

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) currentHost = new URL(tab.url).hostname;
  } catch (e) {
    currentHost = null;
  }

  render();
  setupNavigation();

  try {
    const resp = await browser.runtime.sendMessage({ type: "get-native-status" });
    if (resp) renderNativeStatus(resp.status);
  } catch (e) {
    renderNativeStatus("unknown");
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "native-status") renderNativeStatus(msg.payload.status);
  });

  document.getElementById("enabledToggle").addEventListener("change", async (e) => {
    state.enabled = e.target.checked;
    await saveState();
    render();
  });

  document.getElementById("modeSelectiveBtn").addEventListener("click", async () => {
    state.mode = "selective";
    await saveState();
    render();
  });

  document.getElementById("modeAllBtn").addEventListener("click", async () => {
    state.mode = "all";
    await saveState();
    render();
  });

  document.getElementById("addCurrent").addEventListener("click", async () => {
    if (!currentHost) return;
    state.rules.push({ domain: currentHost, enabled: true });
    await saveState();
    render();
  });

  setupConfigManager();
  setupPortSettings();
  setupLogPanel();
  loadConfigs();
}

init();
