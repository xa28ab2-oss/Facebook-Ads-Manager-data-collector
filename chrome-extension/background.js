const API_PATTERNS = ['adsmanager-graph.facebook.com', 'act_', 'am_tabular', '/api/graphql', 'graphql'];

let isCollecting = false;
let collectedRecords = [];
let debuggerAttached = false;
let expectedGoogleDebuggerDetachTabId = null;
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
let expectedFacebookAccountId = '';
let expectedFacebookBusinessId = '';
let lastFacebookDataChangeAt = 0;
let actionContributionByDateKey = new Map();
let resultContributionByDateKey = new Map();
let facebookAccessToken = '';
let facebookAccountTimezone = null;

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

function extractFacebookAccessToken(value) {
  const text = String(value || '');
  if (!text) return '';
  const patterns = [
    /(?:^|[?&])access_token=([^&\s]+)/i,
    /["']access_token["']\s*:\s*["']([^"']+)["']/i,
    /access_token%22%3A%22([^%&]+)%22/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) continue;
    try {
      return decodeURIComponent(match[1].replace(/\+/g, '%20'));
    } catch (e) {
      return match[1];
    }
  }
  return '';
}

function formatGmtOffset(offset) {
  const numeric = Number(offset);
  if (!Number.isFinite(numeric)) return '';
  const normalized = Object.is(numeric, -0) ? 0 : numeric;
  return `GMT${normalized >= 0 ? '+' : ''}${normalized}`;
}

function getYesterdayForGmtOffset(offset) {
  const numeric = Number(offset);
  const accountNow = new Date(Date.now() + numeric * 60 * 60 * 1000);
  accountNow.setUTCDate(accountNow.getUTCDate() - 1);
  return `${accountNow.getUTCFullYear()}-${String(accountNow.getUTCMonth() + 1).padStart(2, '0')}-${String(accountNow.getUTCDate()).padStart(2, '0')}`;
}

async function loadFacebookAccountTimezone() {
  if (!expectedFacebookAccountId) throw new Error('无法识别 Facebook 广告账户 ID');
  if (!facebookAccessToken) throw new Error('尚未从 Facebook 登录会话获取账户时区凭据，请刷新报表后重试');
  if (!debuggerAttached || targetTabId == null) throw new Error('Facebook 页面调试会话尚未就绪');
  const fields = 'timezone_name,timezone_offset_hours_utc';
  const url = `https://adsmanager-graph.facebook.com/v16.0/act_${encodeURIComponent(expectedFacebookAccountId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(facebookAccessToken)}`;
  // Run the request in the open Ads Manager page so Facebook receives the same
  // origin, referer and logged-in browser context as its own requests.
  const expression = `fetch(${JSON.stringify(url)}, { method: 'GET', credentials: 'include' }).then(async (response) => ({ ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) }))`;
  const evaluated = await chromeDebuggerSendCommand(targetTabId, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  const result = evaluated && evaluated.result;
  if (!result || evaluated.exceptionDetails) throw new Error('Facebook 页面未能完成账户时区请求');
  const responseResult = result.value || {};
  const data = responseResult.data || {};
  if (!responseResult.ok || data.error) {
    const detail = data && data.error && data.error.message ? data.error.message : `HTTP ${responseResult.status || 0}`;
    throw new Error('获取 Facebook 账户时区失败: ' + detail);
  }
  const offset = Number(data.timezone_offset_hours_utc);
  const label = formatGmtOffset(offset);
  if (!Number.isFinite(offset) || !label) throw new Error('Facebook 账户未返回有效时区');
  facebookAccountTimezone = {
    timezone_name: String(data.timezone_name || ''),
    timezone_offset_hours_utc: offset,
    account_timezone: label
  };
  return facebookAccountTimezone;
}

function applyFacebookAccountTimezone(records, timezone) {
  return records.map((record) => {
    const raw = record && record.raw_fields ? record.raw_fields : {};
    return {
      ...record,
      account_timezone: timezone.account_timezone,
      timezone_name: timezone.timezone_name,
      timezone_offset_hours_utc: timezone.timezone_offset_hours_utc,
      raw_fields: {
        ...raw,
        account_timezone: timezone.account_timezone,
        timezone_name: timezone.timezone_name,
        timezone_offset_hours_utc: timezone.timezone_offset_hours_utc
      }
    };
  });
}

function googleRecordFingerprint(result) {
  const record = result && Array.isArray(result.data) ? result.data[0] : null;
  if (!record) return '';
  return JSON.stringify({
    account_id: record.ad_account_id || record.account_id || '',
    date_start: record.date_start || '',
    date_stop: record.date_stop || '',
    spend: Number(record.spend || 0),
    impressions: Number(record.impressions || 0),
    clicks: Number(record.clicks || 0),
    results: Number(record.results || 0),
    currency: record.currency || ''
  });
}

async function collectStableGoogleAdsData(tabId) {
  let lastError = '报表尚未加载完成';
  // 给首次刷新留出启动时间，避免立即读取到刷新前的旧汇总数据。
  await sleep(2500);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const first = await chromeTabsSendMessage(tabId, { action: 'collectGoogleAdsData' });
    if (!first || !first.success || !Array.isArray(first.data) || !first.data.length) {
      lastError = (first && first.error) || lastError;
      await sleep(1000);
      continue;
    }

    await sleep(1000);
    const second = await chromeTabsSendMessage(tabId, { action: 'collectGoogleAdsData' });
    if (second && second.success && googleRecordFingerprint(first) === googleRecordFingerprint(second)) {
      return second;
    }
    lastError = 'Google Ads 报表数据仍在变化';
  }
  return { success: false, error: '等待 Google Ads 报表稳定超时：' + lastError };
}

function facebookNetworkFingerprint(records) {
  return JSON.stringify((Array.isArray(records) ? records : []).map((record) => {
    const raw = record && record.raw_fields ? record.raw_fields : {};
    return {
      account_id: raw.ad_account_id || record.ad_account_id || record.account_id || '',
      date_start: raw.date_start || record.date_start || '',
      date_stop: raw.date_stop || record.date_stop || '',
      spend: raw.spend,
      results: raw.results,
      reach: raw.reach,
      impressions: raw.impressions,
      clicks: raw.clicks
    };
  }));
}

function facebookNetworkColumnPresent(key) {
  const atomicColumns = new Set(
    ((lastHeaders && Array.isArray(lastHeaders.atomic_columns)) ? lastHeaders.atomic_columns : [])
      .map((name) => normalizeMetricKey(name))
      .filter(Boolean)
  );
  const resultColumns = new Set(
    ((lastHeaders && Array.isArray(lastHeaders.result_columns)) ? lastHeaders.result_columns : [])
      .map((name) => normalizeMetricKey(name))
      .filter(Boolean)
  );
  const aliases = {
    spend: ['spend'],
    results: ['results'],
    reach: ['reach'],
    impressions: ['impressions', 'total_impressions'],
    clicks: ['clicks', 'unique_clicks', 'unique_link_clicks', 'link_clicks', 'outbound_clicks', 'unique_outbound_clicks']
  };
  const candidates = aliases[key] || [key];
  return candidates.some((name) => atomicColumns.has(normalizeMetricKey(name))) ||
    (key === 'results' && candidates.some((name) => resultColumns.has(normalizeMetricKey(name))));
}

function normalizeZeroSpendFacebookMetrics(records) {
  const zeroableFields = ['results', 'reach', 'impressions', 'clicks'];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const raw = record.raw_fields && typeof record.raw_fields === 'object'
      ? record.raw_fields
      : {};
    const spendValue = raw.spend !== undefined ? raw.spend : record.spend;
    if (toNumberValue(spendValue) !== 0) continue;
    for (const key of zeroableFields) {
      if (!facebookNetworkColumnPresent(key)) continue;
      const value = raw[key] !== undefined ? raw[key] : record[key];
      if (toNumberValue(value) !== null) continue;
      raw[key] = 0;
      record[key] = 0;
    }
    raw.zero_spend_empty_metrics_normalized = true;
    record.raw_fields = raw;
  }
}

function validateFacebookNetworkRecords(records) {
  if (!Array.isArray(records) || !records.length) return '尚未读取到 Facebook 广告汇总数据';
  normalizeZeroSpendFacebookMetrics(records);
  const required = [
    { key: 'spend', label: '消耗' },
    { key: 'results', label: '成效' },
    { key: 'reach', label: '覆盖人数' },
    { key: 'impressions', label: '展示次数' },
    { key: 'clicks', label: '点击次数' }
  ];
  for (const field of required) {
    if (!facebookNetworkColumnPresent(field.key)) {
      return `无法读取“${field.label}”，请在 Facebook 报表中显示该列并刷新后重试`;
    }
  }
  for (const record of records) {
    const raw = record && record.raw_fields ? record.raw_fields : {};
    const accountId = String(raw.ad_account_id || record.ad_account_id || record.account_id || '').replace(/\D/g, '');
    if (!accountId) return 'Facebook 广告数据缺少广告账户 ID';
    if (expectedFacebookAccountId && accountId !== expectedFacebookAccountId) return '捕获到的数据与当前广告账户不一致';
    const dateStart = raw.date_start || record.date_start || '';
    const dateStop = raw.date_stop || record.date_stop || '';
    if (!dateStart || !dateStop || dateStart !== dateStop) return 'Facebook Ads 只支持采集单日数据';
    for (const field of required) {
      if (toNumberValue(raw[field.key] !== undefined ? raw[field.key] : record[field.key]) === null) {
        return `无法读取“${field.label}”，请在 Facebook 报表中显示该列并刷新后重试`;
      }
    }
  }
  return '';
}

async function waitForStableFacebookNetworkData() {
  const deadline = Date.now() + 10000;
  let previousFingerprint = '';
  let stableReads = 0;
  let lastValidationError = '报表尚未加载完成';
  while (Date.now() < deadline) {
    const validationError = validateFacebookNetworkRecords(collectedRecords);
    if (!validationError) {
      const fingerprint = facebookNetworkFingerprint(collectedRecords);
      if (fingerprint && fingerprint === previousFingerprint && Date.now() - lastFacebookDataChangeAt >= 1500) {
        stableReads += 1;
        if (stableReads >= 2) return { success: true };
      } else {
        stableReads = 0;
      }
      previousFingerprint = fingerprint;
    } else {
      lastValidationError = validationError;
      stableReads = 0;
      previousFingerprint = '';
    }
    await sleep(750);
  }
  return { success: false, error: `等待 Facebook 广告报表刷新超时：${lastValidationError}` };
}

async function runFinalizeUploadTask(projectName, buyerName, uploadMode, apiEndpoint) {
  if (uploadTaskRunning) return;
  uploadTaskRunning = true;
  try {
    if (currentPlatform === 'google_ads' && targetTabId != null) {
      const googleResult = await collectStableGoogleAdsData(targetTabId);
      if (!googleResult || !googleResult.success) {
        setUploadTaskResult('error', '采集失败: ' + ((googleResult && googleResult.error) || '无法读取 Google Ads 报表'));
        return;
      }
      collectedRecords = Array.isArray(googleResult.data) ? googleResult.data : [];
      lastHeaders = googleResult.meta || null;
      recordCandidateCount = collectedRecords.length;
      recordKeptCount = collectedRecords.length;
    } else {
      const stableResult = await waitForStableFacebookNetworkData();
      if (!stableResult.success) {
        setUploadTaskResult('error', '采集失败: ' + stableResult.error);
        return;
      }
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
    let uploadData = data;
    if (currentPlatform === 'facebook_ads') {
      const timezone = await loadFacebookAccountTimezone();
      uploadData = applyFacebookAccountTimezone(data, timezone);
    }
    const payload = {
      operator: 'unknown',
      project_name: projectName || '',
      buyer_name: buyerName || '',
      upload_mode: uploadMode || '当日消耗',
      timestamp: Math.floor(Date.now() / 60000) * 60000,
      data: uploadData
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
      const timezoneDetail = currentPlatform === 'facebook_ads' && facebookAccountTimezone
        ? `（账户时区 ${facebookAccountTimezone.account_timezone}，账户昨天 ${getYesterdayForGmtOffset(facebookAccountTimezone.timezone_offset_hours_utc)}）`
        : '';
      setUploadTaskResult('success', '上传成功' + timezoneDetail);
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

function extractPageAdAccountId(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const value = new URL(url).searchParams.get('act') || '';
    return String(value).replace(/\D/g, '');
  } catch (e) {
    return '';
  }
}

function extractPageBusinessId(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const value = new URL(url).searchParams.get('business_id') || '';
    return String(value).replace(/\D/g, '');
  } catch (e) {
    return '';
  }
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
  let hasComputedResult = Boolean(aggregate.resultHasValue);
  if (!hasComputedResult && computedResult <= 0) {
    const indicator = aggregate.resultIndicator;
    if (indicator === 'actions:onsite_conversion.messaging_conversation_started_7d') {
      const fromActions = toNumberValue(raw['actions:onsite_conversion.messaging_conversation_started_7d']);
      const fromOnsite = toNumberValue(raw['onsite_conversion.messaging_conversation_started_7d']);
      if (fromActions !== null) {
        computedResult = fromActions;
        hasComputedResult = true;
      } else if (fromOnsite !== null) {
        computedResult = fromOnsite;
        hasComputedResult = true;
      }
    }
  }
  if (hasComputedResult) {
    raw.results = String(computedResult);
  } else if (aggregate.resultModeled) {
    raw.results = 'modeled';
  }
  if (aggregate.resultIndicator) {
    raw.result_indicator = aggregate.resultIndicator;
  }
}

function rebuildActionAggregate(dateKey) {
  const contributions = actionContributionByDateKey.get(dateKey);
  if (!contributions || !contributions.size) return;
  const aggregate = {
    actionCount: 0,
    actionCostTotal: 0,
    actionCostHasValue: false,
    actionCountModeled: false,
    actionCostModeled: false
  };
  for (const contribution of contributions.values()) {
    if (contribution.actionCount !== null) aggregate.actionCount += contribution.actionCount;
    if (contribution.actionCostTotal !== null) {
      aggregate.actionCostTotal += contribution.actionCostTotal;
      aggregate.actionCostHasValue = true;
    }
    aggregate.actionCountModeled = aggregate.actionCountModeled || contribution.actionCountModeled;
    aggregate.actionCostModeled = aggregate.actionCostModeled || contribution.actionCostModeled;
  }
  actionAggregateByDateKey.set(dateKey, aggregate);
}

function rebuildResultAggregate(dateKey) {
  const contributions = resultContributionByDateKey.get(dateKey);
  if (!contributions || !contributions.size) return;
  const aggregate = { resultCount: 0, resultHasValue: false, resultModeled: false, resultIndicator: null };
  for (const contribution of contributions.values()) {
    if (contribution.resultCount !== null) {
      aggregate.resultCount += contribution.resultCount;
      aggregate.resultHasValue = true;
    }
    aggregate.resultModeled = aggregate.resultModeled || contribution.resultModeled;
    aggregate.resultIndicator = aggregate.resultIndicator || contribution.resultIndicator;
  }
  resultAggregateByDateKey.set(dateKey, aggregate);
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
        const entityKey = `${campaignValue}__${adsetValue}__${adValue}__${objective}`;
        const actionKey = 'actions:onsite_conversion.messaging_conversation_started_7d';
        const costKey = 'cost_per_action_type:onsite_conversion.messaging_conversation_started_7d';
        const actionRaw = normalizeValue(actionByName[actionKey]);
        const costRaw = normalizeValue(actionByName[costKey]);
        const actionCount = toNumberValue(actionByName[actionKey]);
        const actionCost = toNumberValue(actionByName[costKey]);
        const actionContributions = actionContributionByDateKey.get(dateKey) || new Map();
        actionContributions.set(entityKey, {
          actionCount,
          actionCostTotal: actionCount !== null && actionCost !== null ? actionCount * actionCost : null,
          actionCountModeled: actionRaw === 'modeled',
          actionCostModeled: costRaw === 'modeled'
        });
        actionContributionByDateKey.set(dateKey, actionContributions);
        rebuildActionAggregate(dateKey);
        if (resultIndicator && resultIndicator !== 'null') {
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
          // Facebook 用空值/破折号表示该广告系列在当前成效指标下为 0。
          // 只在响应已经给出明确 result indicator 时转换，避免把尚未加载的结果误判为 0。
          if (numericResult === null && normalizeValue(resultValue) === null) {
            numericResult = 0;
          }
          const resultContributions = resultContributionByDateKey.get(dateKey) || new Map();
          resultContributions.set(entityKey, {
            resultCount: numericResult,
            resultModeled: normalizeValue(resultValue) === 'modeled',
            resultIndicator
          });
          resultContributionByDateKey.set(dateKey, resultContributions);
          rebuildResultAggregate(dateKey);
        }
        lastFacebookDataChangeAt = Date.now();
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
      if (expectedFacebookBusinessId) {
        rawFields.bm_id = expectedFacebookBusinessId;
        rawFields.business_id = expectedFacebookBusinessId;
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
  const before = facebookNetworkFingerprint(collectedRecords);
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
  if (facebookNetworkFingerprint(collectedRecords) !== before) {
    lastFacebookDataChangeAt = Date.now();
  }
}

async function startCollecting(tabId) {
  lastError = null;

  if (debuggerAttached && targetTabId != null) {
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
  actionContributionByDateKey = new Map();
  resultContributionByDateKey = new Map();
  expectedFacebookAccountId = '';
  expectedFacebookBusinessId = '';
  facebookAccessToken = '';
  facebookAccountTimezone = null;
  lastFacebookDataChangeAt = Date.now();
  uploadTaskRunning = false;
  lastUploadTaskResult = null;

  const activeTab = await chromeTabsGet(tabId);
  currentPlatform = activeTab && /^https:\/\/ads\.google\.com\/aw\//i.test(activeTab.url || '') ? 'google_ads' : 'facebook_ads';
  if (currentPlatform === 'google_ads') {
    await chromeDebuggerAttach(tabId, '1.3');
    debuggerAttached = true;
    isCollecting = true;
    collectingReady = true;
    return;
  }

  expectedFacebookAccountId = extractPageAdAccountId(activeTab && activeTab.url);
  if (!expectedFacebookAccountId) {
    throw new Error('无法从当前 Facebook Ads 页面识别广告账户 ID');
  }
  expectedFacebookBusinessId = extractPageBusinessId(activeTab && activeTab.url);

  await chromeDebuggerAttach(tabId, '1.3');
  debuggerAttached = true;
  await chromeDebuggerSendCommand(tabId, 'Network.enable');
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

async function clickGoogleRefreshTrusted(tabId) {
  if (currentPlatform !== 'google_ads' || targetTabId !== tabId) {
    throw new Error('Google Ads 采集会话尚未就绪');
  }
  if (!debuggerAttached) throw new Error('浏览器级点击尚未就绪');
  const rect = await chromeTabsSendMessage(tabId, { action: 'getRefreshButtonRect' });
  if (!rect || !rect.success || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
    throw new Error((rect && rect.error) || '无法定位 Google Ads 刷新按钮');
  }
  try {
    await chromeDebuggerSendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.x,
      y: rect.y
    });
    await chromeDebuggerSendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rect.x,
      y: rect.y,
      button: 'left',
      buttons: 1,
      clickCount: 1
    });
    await sleep(60);
    await chromeDebuggerSendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rect.x,
      y: rect.y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    });
  } finally {
    // Google 仅在点击瞬间需要调试连接；立即释放，避免持续连接影响报表渲染。
    expectedGoogleDebuggerDetachTabId = tabId;
    debuggerAttached = false;
    try {
      await chromeDebuggerDetach(tabId);
    } catch (e) {
      expectedGoogleDebuggerDetachTabId = null;
    }
  }
  return { success: true, click_count: 1, click_mode: 'browser_input' };
}

chrome.debugger.onEvent.addListener(async (source, eventName, params) => {
  if (!isCollecting) return;
  if (!debuggerAttached || targetTabId == null) return;
  if (!source || source.tabId !== targetTabId) return;

  if (eventName === 'Network.requestWillBeSent' && currentPlatform === 'facebook_ads') {
    const request = params && params.request;
    const requestUrl = request && request.url;
    if (requestUrl && requestUrl.includes('adsmanager-graph.facebook.com')) {
      const token = extractFacebookAccessToken(requestUrl) || extractFacebookAccessToken(request.postData || '');
      if (token) facebookAccessToken = token;
    }
    return;
  }

  if (eventName === 'Network.responseReceived') {
    const url = params && params.response && params.response.url;
    const requestId = params && params.requestId;
    const status = params && params.response && params.response.status;
    if (!requestId || !url || !shouldCapture(url)) return;
    if (typeof status === 'number' && (status < 200 || status >= 300)) return;
    const extractedAdAccountId = extractAdAccountIdFromUrl(url);
    if (extractedAdAccountId && expectedFacebookAccountId && extractedAdAccountId !== expectedFacebookAccountId) return;
    pendingResponseByRequestId.set(requestId, {
      url,
      adAccountId: extractedAdAccountId || expectedFacebookAccountId
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


  if (eventName === 'Network.loadingFailed') {
    const requestId = params && params.requestId;
    if (requestId) pendingResponseByRequestId.delete(requestId);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId === expectedGoogleDebuggerDetachTabId) {
    expectedGoogleDebuggerDetachTabId = null;
    debuggerAttached = false;
    return;
  }
  if (!source || source.tabId !== targetTabId) return;
  debuggerAttached = false;
  isCollecting = false;
  collectingReady = false;
  pendingResponseByRequestId = new Map();
  targetTabId = null;
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

  if (action === 'clickGoogleRefreshTrusted') {
    const tabId = request && request.tabId;
    Promise.resolve()
      .then(() => clickGoogleRefreshTrusted(tabId))
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ success: false, error: e && e.message ? e.message : String(e) }));
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
