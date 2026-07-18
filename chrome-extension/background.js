const API_PATTERNS = ['adsmanager-graph.facebook.com', 'act_', 'am_tabular', '/api/graphql', 'graphql'];

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
let actionAggregateByDateKey = new Map();
let resultAggregateByDateKey = new Map();
let uploadTaskRunning = false;
let lastUploadTaskResult = null;
let currentPlatform = 'facebook_ads';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setUploadTaskResult(type, message) {
  lastUploadTaskResult = {
    type,
    message,
    at: Date.now()
  };
}

function parseUploadErrorMessage(responseStatus, responseText) {
  const text = String(responseText || '').trim();
  if (!text) {
    return '上传失败: HTTP ' + responseStatus;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {}
  const errorText = parsed && typeof parsed.error === 'string' ? parsed.error : text;
  const uploadMode = parsed && typeof parsed.upload_mode === 'string' ? parsed.upload_mode : '';
  if (errorText.includes('date_start and date_stop must be the same date')) {
    return '上传失败: 日期范围错误（' + (uploadMode || '当前模式') + '要求开始/结束日期为同一天）';
  }
  if (errorText.includes('all records must use the same date')) {
    return '上传失败: 日期范围错误（' + (uploadMode || '当前模式') + '只允许单日数据）';
  }
  if (errorText.includes('Invalid date range')) {
    return '上传失败: 日期选择错误';
  }
  let detail = text.replace(/\s+/g, ' ').trim();
  if (detail.length > 180) detail = detail.slice(0, 180) + '...';
  return '上传失败: HTTP ' + responseStatus + (detail ? '，' + detail : '');
}

function normalizeMetricKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .trim();
}

function collectMissingFieldLabels(records) {
  const headerAtomicColumns = new Set(
    ((lastHeaders && Array.isArray(lastHeaders.atomic_columns)) ? lastHeaders.atomic_columns : [])
      .map((name) => normalizeMetricKey(name))
      .filter(Boolean)
  );
  const headerResultColumns = new Set(
    ((lastHeaders && Array.isArray(lastHeaders.result_columns)) ? lastHeaders.result_columns : [])
      .map((name) => normalizeMetricKey(name))
      .filter(Boolean)
  );
  const isGoogleAds = currentPlatform === 'google_ads' || records.some((record) => record && record.platform === 'google_ads');
  const required = isGoogleAds ? [
    { label: '消耗', keys: ['spend'] },
    { label: '展示次数', keys: ['impressions'] },
    { label: '点击次数', keys: ['clicks'] },
    { label: '转化次数', keys: ['results', 'conversions'] }
  ] : [
    { label: '消耗', keys: ['spend'] },
    { label: '成效', keys: ['results'], headerResultKeys: ['results'] },
    { label: '覆盖人数', keys: ['reach'] },
    { label: '展示量', keys: ['impressions'] },
    { label: '点击量（全部）', keys: ['clicks'] }
  ];
  const missing = [];
  for (const field of required) {
    let found = false;
    for (const record of records) {
      const raw = record && record.raw_fields ? record.raw_fields : {};
      for (const key of field.keys) {
        const hasRecordField = record && Object.prototype.hasOwnProperty.call(record, key);
        const hasRawField = raw && Object.prototype.hasOwnProperty.call(raw, key);
        if (hasRecordField || hasRawField) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found && Array.isArray(field.headerAtomicKeys)) {
      for (const key of field.headerAtomicKeys) {
        if (headerAtomicColumns.has(normalizeMetricKey(key))) {
          found = true;
          break;
        }
      }
    }
    if (!found && Array.isArray(field.headerResultKeys)) {
      for (const key of field.headerResultKeys) {
        if (headerResultColumns.has(normalizeMetricKey(key))) {
          found = true;
          break;
        }
      }
    }
    if (!found) missing.push(field.label);
  }
  return missing;
}

async function runFinalizeUploadTask(projectName, buyerName, uploadMode, apiEndpoint) {
  if (uploadTaskRunning) return;
  uploadTaskRunning = true;
  try {
    await sleep(5000);
    if (currentPlatform === 'google_ads' && targetTabId != null) {
      const googleResult = await chromeTabsSendMessage(targetTabId, { action: 'collectGoogleAdsData' });
      if (!googleResult || !googleResult.success) {
        setUploadTaskResult('error', '采集失败: ' + ((googleResult && googleResult.error) || '无法读取 Google Ads 报表'));
        return;
      }
      collectedRecords = Array.isArray(googleResult.data) ? googleResult.data : [];
      lastHeaders = googleResult.meta || null;
      recordCandidateCount = collectedRecords.length;
      recordKeptCount = collectedRecords.length;
    }
    const data = Array.isArray(collectedRecords) ? collectedRecords.slice(0) : [];
    if (!data.length) {
      const detail = `抓包${captureCount}次，解析${parsedCount}次，候选${recordCandidateCount}条，保留${recordKeptCount}条`;
      setUploadTaskResult('error', '采集失败: 未检测到广告数据（' + detail + '）');
      return;
    }
    const missingLabels = collectMissingFieldLabels(data);
    if (missingLabels.length) {
      setUploadTaskResult('error', '上传失败: 缺少字段：' + missingLabels.join('、'));
      return;
    }
    const payload = {
      operator: 'unknown',
      project_name: projectName || '',
      buyer_name: buyerName || '',
      upload_mode: uploadMode || '当日消耗',
      timestamp: Math.floor(Date.now() / 60000) * 60000,
      data
    };
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      let text = '';
      try {
        text = await response.text();
      } catch (e) {}
      setUploadTaskResult('error', parseUploadErrorMessage(response.status, text));
      return;
    }
    let resultData = null;
    try {
      resultData = await response.json();
    } catch (e) {}
    const uploaded = resultData && typeof resultData.uploaded === 'number' ? resultData.uploaded : 0;
    const failed = resultData && typeof resultData.failed === 'number' ? resultData.failed : 0;
    if (failed > 0) {
      const firstError = resultData && Array.isArray(resultData.errors) && resultData.errors[0]
        ? (resultData.errors[0].error || resultData.errors[0].msg || '')
        : '';
      const detail = firstError ? '，首条错误: ' + firstError : '';
      setUploadTaskResult('error', '上传失败: 成功 ' + uploaded + ' 条，失败 ' + failed + ' 条' + detail);
    } else {
      setUploadTaskResult('success', '上传成功');
    }
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    setUploadTaskResult('error', '上传失败: ' + message);
  } finally {
    try {
      await stopCollecting();
    } catch (e) {}
    uploadTaskRunning = false;
  }
}

function log(...args) {
  console.log('[Facebook Ads Collector BG]', ...args);
}

function shouldCapture(url) {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  for (const pattern of API_PATTERNS) {
    if (lowerUrl.includes(pattern)) return true;
  }
  return false;
}

function extractAdAccountIdFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const match = url.match(/act_(\d{6,})/i);
  return match && match[1] ? match[1] : '';
}

function isAllowedAdsPage(url) {
  if (!url || typeof url !== 'string') return false;
  let u = null;
  try {
    u = new URL(url);
  } catch (e) {
    return false;
  }
  const host = (u.hostname || '').toLowerCase();
  const path = (u.pathname || '').toLowerCase();
  if (host === 'ads.google.com' && path.startsWith('/aw/')) return true;
  if (host.endsWith('adsmanager.facebook.com')) return true;
  if (host.endsWith('business.facebook.com') && path.includes('/adsmanager')) return true;
  if (host.endsWith('facebook.com') && path.includes('/adsmanager')) return true;
  return false;
}

function syncActionEnabledForTab(tabId, url) {
  if (typeof tabId !== 'number') return;
  if (isAllowedAdsPage(url)) {
    chrome.action.enable(tabId);
    return;
  }
  chrome.action.disable(tabId);
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

function toNumberValue(value) {
  const s = normalizeValue(value);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function buildActionMetricName(actionColumnName, metricTypeName) {
  if (!metricTypeName) return null;
  if (String(metricTypeName).includes(':')) return String(metricTypeName);
  if (!actionColumnName) return String(metricTypeName);
  if (actionColumnName === 'actions') return `actions:${metricTypeName}`;
  if (actionColumnName === 'cost_per_action_type') return `cost_per_action_type:${metricTypeName}`;
  return String(metricTypeName);
}

function applyActionAggregate(raw, aggregate) {
  if (!raw || !aggregate) return;
  let computedCount = aggregate.actionCount;
  if (computedCount <= 0) {
    const fallbackCount = toNumberValue(raw['onsite_conversion.messaging_conversation_started_7d']);
    if (fallbackCount !== null) computedCount = fallbackCount;
  }
  if (computedCount > 0) {
    raw['actions:onsite_conversion.messaging_conversation_started_7d'] = String(computedCount);
  } else if (aggregate.actionCountModeled) {
    raw['actions:onsite_conversion.messaging_conversation_started_7d'] = 'modeled';
  }
  if (computedCount > 0) {
    const spend = toNumberValue(raw.spend);
    if (spend !== null) {
      const avgCost = spend / computedCount;
      raw['cost_per_action_type:onsite_conversion.messaging_conversation_started_7d'] = String(avgCost);
    }
  } else if (aggregate.actionCostHasValue && aggregate.actionCount > 0) {
    const avgCost = aggregate.actionCostTotal / aggregate.actionCount;
    raw['cost_per_action_type:onsite_conversion.messaging_conversation_started_7d'] = String(avgCost);
  } else if (aggregate.actionCostModeled) {
    raw['cost_per_action_type:onsite_conversion.messaging_conversation_started_7d'] = 'modeled';
  }
}

function applyResultAggregate(raw, aggregate) {
  if (!raw || !aggregate) return;
  let computedResult = aggregate.resultCount;
  if (computedResult <= 0) {
    const indicator = aggregate.resultIndicator;
    if (indicator === 'actions:onsite_conversion.messaging_conversation_started_7d') {
      const fromActions = toNumberValue(raw['actions:onsite_conversion.messaging_conversation_started_7d']);
      const fromOnsite = toNumberValue(raw['onsite_conversion.messaging_conversation_started_7d']);
      if (fromActions !== null) computedResult = fromActions;
      else if (fromOnsite !== null) computedResult = fromOnsite;
    }
  }
  if (computedResult > 0) {
    raw.results = String(computedResult);
  } else if (aggregate.resultModeled) {
    raw.results = 'modeled';
  }
  if (aggregate.resultIndicator) {
    raw.result_indicator = aggregate.resultIndicator;
  }
}

function updateSummaryRecordsByDateKey(dateKey) {
  if (!dateKey) return;
  const aggregate = actionAggregateByDateKey.get(dateKey);
  const resultAggregate = resultAggregateByDateKey.get(dateKey);
  if (!aggregate && !resultAggregate) return;
  for (let i = 0; i < collectedRecords.length; i++) {
    const record = collectedRecords[i];
    if (!record || !record.raw_fields) continue;
    const raw = record.raw_fields;
    const recordKey = `${raw.date_start || ''}__${raw.date_stop || ''}`;
    if (recordKey !== dateKey) continue;
    if (aggregate) applyActionAggregate(raw, aggregate);
    if (resultAggregate) applyResultAggregate(raw, resultAggregate);
    collectedRecords[i] = { ...record, raw_fields: raw };
  }
}

function isAllDigits(value) {
  if (!value) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function extractIdFromName(name) {
  if (!name) return null;
  const end = name.lastIndexOf(')');
  const start = name.lastIndexOf('(');
  if (start === -1 || end !== name.length - 1 || start >= end - 1) return null;
  const id = name.slice(start + 1, end);
  if (!isAllDigits(id)) return null;
  return id;
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
  if (idStr.length < 6 || idStr.length > 20) return false;
  if (!isAllDigits(idStr)) return false;
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
        : extractIdFromName(rec.campaign_name);
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

function extractFacebookInsightsData(data, adAccountId) {
  const records = [];
  const accountId = adAccountId || '';
  if (!data || !data.data || !Array.isArray(data.data)) return records;

  for (const dataset of data.data) {
    if (!dataset || !dataset.headers || !dataset.rows) continue;

    const headers = dataset.headers;
    const dimensions = headers.dimensions || [];
    const atomicColumns = headers.atomic_columns || [];
    const actionColumns = headers.action_columns || [];
    const resultColumns = headers.result_columns || [];
    datasetRowCount += Array.isArray(dataset.rows) ? dataset.rows.length : 0;

    if (!lastHeaders && hasAnyMetricColumn(atomicColumns)) {
      lastHeaders = {
        dimensions: dimensions.slice(0),
        atomic_columns: atomicColumns.map((c) => (c && c.name) || null).filter(Boolean),
        action_columns: actionColumns.map((c) => (c && c.name) || null).filter(Boolean),
        result_columns: resultColumns.map((c) => (c && c.name) || null).filter(Boolean)
      };
    }

    const dimensionIndex = {};
    for (let i = 0; i < dimensions.length; i++) {
      dimensionIndex[dimensions[i]] = i;
    }
    let hasMultipleObjectiveSummary = false;
    if (typeof dimensionIndex.objective === 'number' && Array.isArray(dataset.rows)) {
      for (const row of dataset.rows) {
        const dimensionValues = row && row.dimension_values ? row.dimension_values : [];
        const objectiveRaw = normalizeValue(dimensionValues[dimensionIndex.objective]);
        if (objectiveRaw && objectiveRaw.toUpperCase() === 'MULTIPLE') {
          hasMultipleObjectiveSummary = true;
          break;
        }
      }
    }

    for (const row of dataset.rows) {
      const dimensionValues = row.dimension_values || [];
      const atomicValues = row.atomic_values || [];

      const dimensionByName = {};
      for (let i = 0; i < dimensions.length; i++) {
        const name = dimensions[i];
        if (!name) continue;
        dimensionByName[name] = dimensionValues[i];
      }

      const atomicByName = {};
      for (let i = 0; i < atomicColumns.length; i++) {
        const name = atomicColumns[i] && atomicColumns[i].name;
        if (!name) continue;
        atomicByName[name] = atomicValues[i];
      }
      const actionByName = {};
      const actionValues = row.action_values || [];
      for (let i = 0; i < actionValues.length; i++) {
        const entry = actionValues[i];
        if (!entry || typeof entry !== 'object') continue;
        const actionColumnName = actionColumns[i] && actionColumns[i].name;
        const types = entry.types;
        const values = entry.values;
        if (Array.isArray(types) && Array.isArray(values) && types.length === values.length) {
          for (let j = 0; j < types.length; j++) {
            const typeName = types[j];
            if (!typeName) continue;
            const canonicalName = buildActionMetricName(actionColumnName, typeName);
            if (canonicalName) actionByName[canonicalName] = values[j];
            if (!Object.prototype.hasOwnProperty.call(actionByName, typeName)) {
              actionByName[typeName] = values[j];
            }
          }
        }
      }
      const resultValues = row.result_values || [];
      const resultValueByColumn = {};
      const resultIndicatorByColumn = {};
      for (let i = 0; i < resultValues.length && i < resultColumns.length; i++) {
        const entry = resultValues[i];
        const columnName = resultColumns[i] && resultColumns[i].name;
        if (!columnName || !entry || typeof entry !== 'object') continue;
        if (Object.prototype.hasOwnProperty.call(entry, 'value')) {
          resultValueByColumn[columnName] = entry.value;
        }
        if (Object.prototype.hasOwnProperty.call(entry, 'indicator')) {
          resultIndicatorByColumn[columnName] = entry.indicator;
        }
      }
      const resultIndicator =
        normalizeValue(resultIndicatorByColumn.results) ||
        normalizeValue(resultIndicatorByColumn.cost_per_result) ||
        null;

      const campaignValue = dimensionValues[dimensionIndex.campaign_id] || '';
      const adsetValue = dimensionValues[dimensionIndex.adset_id] || '';
      const adValue = dimensionValues[dimensionIndex.ad_id] || '';
      const hasEntityValue = Boolean(campaignValue || adsetValue || adValue);
      const campaignId = campaignValue || adsetValue || adValue || '';
      const objective = dimensionValues[dimensionIndex.objective] || '';
      const dateStart = dimensionValues[dimensionIndex.date_start] || '';
      const dateStop = dimensionValues[dimensionIndex.date_stop] || '';

      const dateKey = `${dateStart}__${dateStop}`;
      if (hasEntityValue) {
        const existing = actionAggregateByDateKey.get(dateKey) || {
          actionCount: 0,
          actionCostTotal: 0,
          actionCostHasValue: false,
          actionCountModeled: false,
          actionCostModeled: false
        };
        const actionKey = 'actions:onsite_conversion.messaging_conversation_started_7d';
        const costKey = 'cost_per_action_type:onsite_conversion.messaging_conversation_started_7d';
        const actionRaw = normalizeValue(actionByName[actionKey]);
        const costRaw = normalizeValue(actionByName[costKey]);
        const actionCount = toNumberValue(actionByName[actionKey]);
        if (actionCount !== null) {
          existing.actionCount += actionCount;
        } else if (actionRaw === 'modeled') {
          existing.actionCountModeled = true;
        }
        const actionCost = toNumberValue(actionByName[costKey]);
        if (actionCount !== null && actionCost !== null) {
          existing.actionCostTotal += actionCount * actionCost;
          existing.actionCostHasValue = true;
        } else if (costRaw === 'modeled') {
          existing.actionCostModeled = true;
        }
        actionAggregateByDateKey.set(dateKey, existing);
        if (resultIndicator && resultIndicator !== 'null') {
          const resultExisting = resultAggregateByDateKey.get(dateKey) || {
            resultCount: 0,
            resultModeled: false,
            resultIndicator: null
          };
          resultExisting.resultIndicator = resultExisting.resultIndicator || resultIndicator;
          let resultValue = resultValueByColumn.results;
          if (resultValue === undefined && typeof resultIndicator === 'string') {
            resultValue = actionByName[resultIndicator];
            if (resultValue === undefined && resultIndicator === 'actions:onsite_conversion.messaging_conversation_started_7d') {
              resultValue = actionByName[resultIndicator] || actionByName['actions:onsite_conversion.messaging_conversation_started_7d'];
            }
          }
          let numericResult = toNumberValue(resultValue);
          if (numericResult === null && resultIndicator === 'actions:onsite_conversion.messaging_conversation_started_7d') {
            numericResult = toNumberValue(atomicByName['onsite_conversion.messaging_conversation_started_7d']);
          }
          if (numericResult !== null) {
            resultExisting.resultCount += numericResult;
          } else if (normalizeValue(resultValue) === 'modeled') {
            resultExisting.resultModeled = true;
          }
          resultAggregateByDateKey.set(dateKey, resultExisting);
        }
        updateSummaryRecordsByDateKey(dateKey);
        continue;
      }
      if (!campaignId) {
        if (!dateStart && !dateStop) continue;
      }
      const objectiveValue = normalizeValue(objective);
      if (typeof dimensionIndex.objective === 'number') {
        if (hasMultipleObjectiveSummary) {
          if (!objectiveValue || objectiveValue.toUpperCase() !== 'MULTIPLE') continue;
        } else if (!objectiveValue) {
          continue;
        }
      }
      recordCandidateCount += 1;

      const reach = pickAtomicValue(atomicByName, ['reach']);
      const spend = normalizeValue(atomicByName.spend);
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
      const aggregate = actionAggregateByDateKey.get(dateKey);
      const resultAggregate = resultAggregateByDateKey.get(dateKey);
      const rawFields = { ...dimensionByName, ...atomicByName, ...actionByName, ...resultValueByColumn };
      if (accountId) {
        rawFields.ad_account_id = accountId;
      }
      if (
        completeRegistrations !== null &&
        !Object.prototype.hasOwnProperty.call(rawFields, 'omni_complete_registration')
      ) {
        rawFields.omni_complete_registration = completeRegistrations;
      }
      if (resultIndicator) {
        rawFields.result_indicator = resultIndicator;
      }
      if (aggregate) {
        applyActionAggregate(rawFields, aggregate);
      }
      if (resultAggregate) {
        applyResultAggregate(rawFields, resultAggregate);
      }
      records.push({
        raw_fields: rawFields
      });
    }
  }

  return records;
}

function extractAdData(data, adAccountId) {
  const records = [];

  function processObject(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      for (const item of obj) processObject(item);
      return;
    }

    if (obj.data && Array.isArray(obj.data) && obj.data.length && obj.data[0] && obj.data[0].headers && obj.data[0].rows) {
      const fbRecords = extractFacebookInsightsData(obj, adAccountId);
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
    const raw = record && record.raw_fields ? record.raw_fields : {};
    const dateStart = record.date_start || raw.date_start || '';
    const dateStop = record.date_stop || raw.date_stop || '';
    const key = `${dateStart}__${dateStop}`;
    const idx = collectedRecords.findIndex((r) => {
      const rRaw = r && r.raw_fields ? r.raw_fields : {};
      const rDateStart = r.date_start || rRaw.date_start || '';
      const rDateStop = r.date_stop || rRaw.date_stop || '';
      return `${rDateStart}__${rDateStop}` === key;
    });
    if (idx === -1) {
      collectedRecords.push(record);
    } else {
      const prev = collectedRecords[idx] || {};
      const prevRaw = prev && prev.raw_fields ? prev.raw_fields : {};
      const nextRaw = record && record.raw_fields ? record.raw_fields : {};
      collectedRecords[idx] = { ...prev, ...record, raw_fields: { ...prevRaw, ...nextRaw } };
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
  actionAggregateByDateKey = new Map();
  resultAggregateByDateKey = new Map();
  uploadTaskRunning = false;
  lastUploadTaskResult = null;

  const activeTab = await chromeTabsGet(tabId);
  currentPlatform = activeTab && /^https:\/\/ads\.google\.com\/aw\//i.test(activeTab.url || '') ? 'google_ads' : 'facebook_ads';
  if (currentPlatform === 'google_ads') {
    isCollecting = true;
    collectingReady = true;
    return;
  }

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

  const tabId = targetTabId;
  targetTabId = null;
  if (!debuggerAttached || tabId == null) return;

  debuggerAttached = false;

  try {
    await chromeDebuggerSendCommand(tabId, 'Network.setCacheDisabled', { cacheDisabled: false });
    await chromeDebuggerSendCommand(tabId, 'Network.disable');
  } catch (e) {}

  await chromeDebuggerDetach(tabId);
}

function chromeTabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(tab);
    });
  });
}

function chromeTabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response);
    });
  });
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
    const extractedAdAccountId = extractAdAccountIdFromUrl(url);
    pendingResponseByRequestId.set(requestId, {
      url,
      adAccountId: extractedAdAccountId
    });
    captureCount += 1;
    return;
  }

  if (eventName === 'Network.loadingFinished') {
    const requestId = params && params.requestId;
    if (!requestId) return;
    const requestInfo = pendingResponseByRequestId.get(requestId);
    if (!requestInfo || !requestInfo.url) return;
    const url = requestInfo.url;
    const adAccountId = requestInfo.adAccountId || '';

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
      const records = extractAdData(json, adAccountId);
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

  if (action === 'previewCollection') {
    if (currentPlatform !== 'google_ads' || targetTabId == null) {
      sendResponse({ success: false, error: '仅支持在 Google Ads 报表页面预览' });
      return true;
    }
    Promise.resolve()
      .then(() => chromeTabsSendMessage(targetTabId, { action: 'collectGoogleAdsData' }))
      .then((result) => sendResponse(result || { success: false, error: '未读取到数据' }))
      .catch((e) => sendResponse({ success: false, error: e && e.message ? e.message : String(e) }));
    return true;
  }

  if (action === 'finalizeCollectionUpload') {
    const projectName = request && request.project_name;
    const buyerName = request && request.buyer_name;
    const uploadMode = request && request.upload_mode;
    const apiEndpoint = request && request.api_endpoint;
    if (!apiEndpoint) {
      sendResponse({ success: false, error: 'api_endpoint required' });
      return true;
    }
    if (uploadTaskRunning) {
      sendResponse({ success: false, error: 'upload task running' });
      return true;
    }
    lastUploadTaskResult = null;
    Promise.resolve()
      .then(() => runFinalizeUploadTask(projectName, buyerName, uploadMode, apiEndpoint))
      .catch((e) => {
        const message = e && e.message ? e.message : String(e);
        setUploadTaskResult('error', '上传失败: ' + message);
      });
    sendResponse({ success: true, started: true });
    return true;
  }

  if (action === 'getUploadTaskState') {
    sendResponse({
      success: true,
      running: uploadTaskRunning,
      result: lastUploadTaskResult
    });
    return true;
  }

  if (action === 'clearUploadTaskResult') {
    lastUploadTaskResult = null;
    sendResponse({ success: true });
    return true;
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    syncActionEnabledForTab(tabId, tab && tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const nextUrl = (changeInfo && changeInfo.url) || (tab && tab.url);
  if (!nextUrl) return;
  syncActionEnabledForTab(tabId, nextUrl);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
    for (const tab of tabs) {
      syncActionEnabledForTab(tab.id, tab.url);
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
    for (const tab of tabs) {
      syncActionEnabledForTab(tab.id, tab.url);
    }
  });
});

chrome.tabs.query({}, (tabs) => {
  if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
  for (const tab of tabs) {
    syncActionEnabledForTab(tab.id, tab.url);
  }
});

log('Service worker loaded');
