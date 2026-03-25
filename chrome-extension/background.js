const API_PATTERNS = [/adsmanager-graph\\.facebook\\.com/, /act_\\d+/, /am_tabular/];

let isCollecting = false;
let collectedRecords = [];
let debuggerAttached = false;
let targetTabId = null;
let lastError = null;
let pendingResponseByRequestId = new Map();

function log(...args) {
  console.log('[Facebook Ads Collector BG]', ...args);
}

function shouldCapture(url) {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  for (const pattern of API_PATTERNS) {
    if (pattern.test(lowerUrl)) return true;
  }
  return false;
}

function chromeDebuggerAttach(tabId, protocolVersion) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, protocolVersion, () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    });
  });
}

function chromeDebuggerDetach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach({ tabId }, () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    });
  });
}

function chromeDebuggerSendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(result);
    });
  });
}

function decodeBody(body, base64Encoded) {
  if (!base64Encoded) return body;
  try {
    return atob(body);
  } catch (e) {
    return body;
  }
}

function extractFacebookInsightsData(data) {
  const records = [];
  if (!data || !data.data || !Array.isArray(data.data)) return records;

  for (const dataset of data.data) {
    if (!dataset || !dataset.headers || !dataset.rows) continue;

    const headers = dataset.headers;
    const dimensions = headers.dimensions || [];
    const atomicColumns = headers.atomic_columns || [];

    const dimensionIndex = {};
    for (let i = 0; i < dimensions.length; i++) {
      dimensionIndex[dimensions[i]] = i;
    }

    const atomicIndex = {};
    for (let i = 0; i < atomicColumns.length; i++) {
      const name = atomicColumns[i] && atomicColumns[i].name;
      if (name) atomicIndex[name] = i;
    }

    for (const row of dataset.rows) {
      const dimensionValues = row.dimension_values || [];
      const atomicValues = row.atomic_values || [];

      const campaignId = dimensionValues[dimensionIndex.campaign_id] || '';
      const objective = dimensionValues[dimensionIndex.objective] || '';
      const dateStart = dimensionValues[dimensionIndex.date_start] || '';
      const dateStop = dimensionValues[dimensionIndex.date_stop] || '';

      const spend = atomicValues[atomicIndex.spend] ?? '0';
      const impressions = atomicValues[atomicIndex.impressions] ?? '0';

      if (!campaignId) continue;

      records.push({
        campaign_name: `${objective} (${campaignId})`,
        spend: String(spend === 'null' || spend === null ? '0' : spend),
        impressions: String(impressions === 'null' || impressions === null ? '0' : impressions),
        clicks: '0',
        date_start: String(dateStart),
        date_stop: String(dateStop),
      });
    }
  }

  return records;
}

function extractAdData(data) {
  const records = [];

  function processObject(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      for (const item of obj) processObject(item);
      return;
    }

    if (obj.data && Array.isArray(obj.data) && obj.data.length && obj.data[0] && obj.data[0].headers && obj.data[0].rows) {
      const fbRecords = extractFacebookInsightsData(obj);
      for (const r of fbRecords) records.push(r);
      return;
    }

    for (const key of Object.keys(obj)) {
      processObject(obj[key]);
    }
  }

  processObject(data);
  return records;
}

function upsertRecords(records) {
  for (const record of records) {
    const exists = collectedRecords.some(
      (r) => r.campaign_name === record.campaign_name && r.spend === record.spend && r.date_start === record.date_start
    );
    if (!exists) collectedRecords.push(record);
  }
}

async function startCollecting(tabId) {
  lastError = null;

  if (debuggerAttached && targetTabId != null && targetTabId !== tabId) {
    await stopCollecting();
  }

  targetTabId = tabId;
  collectedRecords = [];
  pendingResponseByRequestId = new Map();

  await chromeDebuggerAttach(tabId, '1.3');
  debuggerAttached = true;
  await chromeDebuggerSendCommand(tabId, 'Network.enable');
  isCollecting = true;
}

async function stopCollecting() {
  isCollecting = false;
  pendingResponseByRequestId = new Map();

  if (!debuggerAttached || targetTabId == null) return;

  const tabId = targetTabId;
  targetTabId = null;
  debuggerAttached = false;

  try {
    await chromeDebuggerSendCommand(tabId, 'Network.disable');
  } catch (e) {}

  await chromeDebuggerDetach(tabId);
}

chrome.debugger.onEvent.addListener(async (source, eventName, params) => {
  if (!isCollecting) return;
  if (!debuggerAttached || targetTabId == null) return;
  if (!source || source.tabId !== targetTabId) return;

  if (eventName === 'Network.responseReceived') {
    const url = params && params.response && params.response.url;
    const requestId = params && params.requestId;
    const status = params && params.response && params.response.status;
    if (!requestId || !url || !shouldCapture(url)) return;
    if (typeof status === 'number' && (status < 200 || status >= 300)) return;
    pendingResponseByRequestId.set(requestId, url);
    return;
  }

  if (eventName === 'Network.loadingFinished') {
    const requestId = params && params.requestId;
    if (!requestId) return;
    const url = pendingResponseByRequestId.get(requestId);
    if (!url) return;

    pendingResponseByRequestId.delete(requestId);

    try {
      const bodyResult = await chromeDebuggerSendCommand(targetTabId, 'Network.getResponseBody', { requestId });
      const body = decodeBody(bodyResult && bodyResult.body, bodyResult && bodyResult.base64Encoded);
      if (!body || typeof body !== 'string') return;
      if (!body.trim().startsWith('{')) return;

      const json = JSON.parse(body);
      const records = extractAdData(json);
      if (records.length) upsertRecords(records);
    } catch (e) {
      lastError = e.message || String(e);
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request && request.action;

  if (action === 'startCollection') {
    const tabId = request && request.tabId;
    Promise.resolve()
      .then(() => startCollecting(tabId))
      .then(() => sendResponse({ success: true }))
      .catch((e) => {
        lastError = e && e.message ? e.message : String(e);
        sendResponse({ success: false, error: lastError });
      });
    return true;
  }

  if (action === 'stopCollection') {
    Promise.resolve()
      .then(() => stopCollecting())
      .then(() => sendResponse({ success: true }))
      .catch((e) => {
        lastError = e && e.message ? e.message : String(e);
        sendResponse({ success: false, error: lastError });
      });
    return true;
  }

  if (action === 'getData') {
    sendResponse({
      success: true,
      data: collectedRecords,
      error: lastError,
    });
    return true;
  }
});

log('Service worker loaded');
