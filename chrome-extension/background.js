const API_PATTERNS = [/adsmanager-graph\.facebook\.com/, /act_\d+/, /am_tabular/, /\/api\/graphql/, /graphql/];

let isCollecting = false;
let collectedRecords = [];
let debuggerAttached = false;
let targetTabId = null;
let lastError = null;
let pendingResponseByRequestId = new Map();
let lastHeaders = null;
let campaignNameById = new Map();
let captureCount = 0;
let parsedCount = 0;
let datasetRowCount = 0;
let recordCandidateCount = 0;
let recordKeptCount = 0;
let collectingReady = false;

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

function sanitizeJsonText(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  if (s.startsWith('for (;;);')) {
    s = s.slice('for (;;);'.length).trim();
  }
  if (s.startsWith(")]}'")) {
    const idx = s.indexOf('\n');
    s = (idx === -1 ? '' : s.slice(idx + 1)).trim();
  }
  return s || null;
}

function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s === 'null' || s === '-' || s === '—') return null;
  return s;
}

function pickAtomicValue(atomicByName, candidates) {
  for (const name of candidates) {
    if (!Object.prototype.hasOwnProperty.call(atomicByName, name)) continue;
    const v = normalizeValue(atomicByName[name]);
    if (v !== null) return v;
  }
  return null;
}

function maybeStoreCampaignName(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const id = obj.id || obj.campaign_id || obj.campaignId;
  const name = obj.name;
  if (!id || !name) return false;
  const idStr = String(id);
  if (!/^\d{6,20}$/.test(idStr)) return false;
  if (typeof name !== 'string' || !name.trim()) return false;
  campaignNameById.set(idStr, name.trim());
  return true;
}

function extractCampaignNames(data) {
  let found = false;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (maybeStoreCampaignName(node)) found = true;
    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const v = node[key];
      if (v && typeof v === 'object') walk(v);
    }
  }
  walk(data);
  if (found) {
    for (let i = 0; i < collectedRecords.length; i++) {
      const rec = collectedRecords[i];
      if (!rec) continue;
      const cid = rec.campaign_id
        ? String(rec.campaign_id)
        : (rec.campaign_name && /\((\d+)\)$/.exec(rec.campaign_name) ? /\((\d+)\)$/.exec(rec.campaign_name)[1] : null);
      if (!cid) continue;
      const friendly = campaignNameById.get(cid);
      if (friendly) {
        collectedRecords[i] = { ...rec, campaign_id: cid, campaign_name: `${friendly} (${cid})` };
      }
    }
  }
  return found;
}

function hasAnyMetricColumn(atomicColumns) {
  for (const col of atomicColumns) {
    const name = col && col.name;
    if (!name) continue;
    if (
      name === 'spend' ||
      name === 'impressions' ||
      name === 'reach' ||
      name === 'clicks' ||
      name === 'unique_link_clicks' ||
      name === 'results' ||
      name === 'cost_per_result'
    ) {
      return true;
    }
  }
  return false;
}

function extractFacebookInsightsData(data) {
  const records = [];
  if (!data || !data.data || !Array.isArray(data.data)) return records;

  for (const dataset of data.data) {
    if (!dataset || !dataset.headers || !dataset.rows) continue;

    const headers = dataset.headers;
    const dimensions = headers.dimensions || [];
    const atomicColumns = headers.atomic_columns || [];
    datasetRowCount += Array.isArray(dataset.rows) ? dataset.rows.length : 0;

    if (!lastHeaders && hasAnyMetricColumn(atomicColumns)) {
      lastHeaders = {
        dimensions: dimensions.slice(0),
        atomic_columns: atomicColumns.map((c) => (c && c.name) || null).filter(Boolean)
      };
    }

    const dimensionIndex = {};
    for (let i = 0; i < dimensions.length; i++) {
      dimensionIndex[dimensions[i]] = i;
    }

    for (const row of dataset.rows) {
      const dimensionValues = row.dimension_values || [];
      const atomicValues = row.atomic_values || [];

      const atomicByName = {};
      for (let i = 0; i < atomicColumns.length; i++) {
        const name = atomicColumns[i] && atomicColumns[i].name;
        if (!name) continue;
        atomicByName[name] = atomicValues[i];
      }

      const campaignId =
        dimensionValues[dimensionIndex.campaign_id] ||
        dimensionValues[dimensionIndex.adset_id] ||
        dimensionValues[dimensionIndex.ad_id] ||
        '';
      const objective = dimensionValues[dimensionIndex.objective] || '';
      const dateStart = dimensionValues[dimensionIndex.date_start] || '';
      const dateStop = dimensionValues[dimensionIndex.date_stop] || '';

      if (!campaignId) continue;
      recordCandidateCount += 1;

      const reach = pickAtomicValue(atomicByName, ['reach']);
      const spend = pickAtomicValue(atomicByName, ['spend', 'amount_spent', 'total_spend', 'cost']);
      const impressions = pickAtomicValue(atomicByName, ['impressions', 'total_impressions']);
      const clicks = pickAtomicValue(atomicByName, [
        'unique_link_clicks',
        'unique_outbound_clicks',
        'unique_clicks',
        'link_clicks',
        'outbound_clicks',
        'clicks'
      ]);
      const budget = pickAtomicValue(atomicByName, ['budget', 'campaign_budget', 'daily_budget', 'lifetime_budget']);
      const results = pickAtomicValue(atomicByName, ['results']);
      const costPerResult = pickAtomicValue(atomicByName, ['cost_per_result']);
      const completeRegistrations = pickAtomicValue(atomicByName, [
        'complete_registration',
        'omni_complete_registration',
        'registrations',
        'complete_registrations'
      ]);

      const hasMetricColumns = hasAnyMetricColumn(atomicColumns);
      if (!hasMetricColumns) continue;

      recordKeptCount += 1;
      const friendly = campaignNameById.get(String(campaignId));
      records.push({
        campaign_id: String(campaignId),
        campaign_name: (friendly ? `${friendly}` : `${objective}`) + ` (${campaignId})`,
        reach: reach,
        spend: spend,
        budget: budget,
        impressions: impressions,
        clicks: clicks,
        results: results,
        cost_per_result: costPerResult,
        complete_registrations: completeRegistrations,
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
    const idx = collectedRecords.findIndex(
      (r) => r.campaign_id === record.campaign_id && r.date_start === record.date_start && r.date_stop === record.date_stop
    );
    if (idx === -1) {
      collectedRecords.push(record);
    } else {
      collectedRecords[idx] = { ...collectedRecords[idx], ...record };
    }
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
  lastHeaders = null;
  campaignNameById = new Map();
  captureCount = 0;
  parsedCount = 0;
  datasetRowCount = 0;
  recordCandidateCount = 0;
  recordKeptCount = 0;
  collectingReady = false;

  await chromeDebuggerAttach(tabId, '1.3');
  debuggerAttached = true;
  await chromeDebuggerSendCommand(tabId, 'Network.enable');
  try {
    await chromeDebuggerSendCommand(tabId, 'Network.setCacheDisabled', { cacheDisabled: true });
  } catch (e) {}
  isCollecting = true;
  collectingReady = true;
}

async function stopCollecting() {
  isCollecting = false;
  pendingResponseByRequestId = new Map();
  collectingReady = false;

  if (!debuggerAttached || targetTabId == null) return;

  const tabId = targetTabId;
  targetTabId = null;
  debuggerAttached = false;

  try {
    await chromeDebuggerSendCommand(tabId, 'Network.setCacheDisabled', { cacheDisabled: false });
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
    captureCount += 1;
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
      const jsonText = sanitizeJsonText(body);
      if (!jsonText) return;
      if (!(jsonText.startsWith('{') || jsonText.startsWith('['))) return;

      const json = JSON.parse(jsonText);
      parsedCount += 1;
      extractCampaignNames(json);
      const records = extractAdData(json);
      if (records.length) upsertRecords(records);
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      if (message && message.includes('No resource with given identifier found')) {
        return;
      }
      lastError = message;
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request && request.action;

  if (action === 'startCollection') {
    const tabId = request && request.tabId;
    try {
      Promise.resolve()
        .then(() => startCollecting(tabId))
        .catch((e) => {
          lastError = e && e.message ? e.message : String(e);
        });
      sendResponse({ success: true });
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      sendResponse({ success: false, error: lastError });
    }
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

  if (action === 'ping') {
    sendResponse({ success: true, status: 'ok' });
    return true;
  }

  if (action === 'getStatus') {
    sendResponse({
      success: true,
      ready: collectingReady,
      attached: debuggerAttached,
      collecting: isCollecting
    });
    return true;
  }

  if (action === 'getData') {
    const nameSample = Array.from(campaignNameById.entries()).slice(0, 5).map(([campaign_id, name]) => ({
      campaign_id,
      name
    }));
    sendResponse({
      success: true,
      data: collectedRecords,
      error: lastError,
      meta: {
        ...lastHeaders,
        name_cache_size: campaignNameById.size,
        name_sample: nameSample,
        capture_count: captureCount,
        parsed_count: parsedCount,
        dataset_row_count: datasetRowCount,
        record_candidate_count: recordCandidateCount,
        record_kept_count: recordKeptCount
      },
    });
    return true;
  }
});

log('Service worker loaded');
