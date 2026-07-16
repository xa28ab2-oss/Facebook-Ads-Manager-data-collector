const fetch = require('node-fetch');

const LARK_APP_TOKEN = process.env.LARK_APP_TOKEN || '';
const LARK_APP_ID = process.env.LARK_APP_ID || '';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || '';
const LARK_TABLE_ID = process.env.LARK_TABLE_ID || '';
const LARK_TABLE_ID_EXTRA = process.env.LARK_TABLE_ID_EXTRA || '';
const LARK_REFLUX_TABLE_ID = process.env.LARK_REFLUX_TABLE_ID || '';
const API_TOKEN = process.env.API_TOKEN || '';
const ENFORCE_DATE_VALIDATION = true;

function normalizeFieldName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .trim();
}

function buildFieldNameIndex(fields) {
  const index = new Map();
  for (const f of fields) {
    if (!f) continue;
    const fieldName = f.field_name || f.fieldName || f.name;
    const fieldId = f.field_id || f.fieldId || f.id;
    const fieldType = f.type;
    if (!fieldName) continue;
    index.set(normalizeFieldName(fieldName), { fieldName, fieldId, fieldType });
  }
  return index;
}

function pickField(fieldsIndex, candidates) {
  for (const candidate of candidates) {
    const hit = fieldsIndex.get(normalizeFieldName(candidate));
    if (hit) return hit;
  }
  return null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toDateTimeValue(value) {
  if (!value) return Date.now();
  const t = Date.parse(value);
  if (Number.isFinite(t)) return t;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  return Date.now();
}

function setBitableFieldValue(fields, fieldInfo, value, kind) {
  if (!fieldInfo || !fieldInfo.fieldName) return;
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s || s === '-' || s === '—' || s === 'null') return;
  }
  const type = fieldInfo.fieldType;

  if (type === 1) {
    fields[fieldInfo.fieldName] = value == null ? '' : String(value);
    return;
  }

  if (type === 2) {
    fields[fieldInfo.fieldName] = kind === 'datetime' ? toNumber(toDateTimeValue(value)) : toNumber(value);
    return;
  }

  if (type === 5) {
    fields[fieldInfo.fieldName] = toDateTimeValue(value);
    return;
  }

  if (kind === 'number') {
    fields[fieldInfo.fieldName] = toNumber(value);
    return;
  }

  if (kind === 'datetime') {
    fields[fieldInfo.fieldName] = toDateTimeValue(value);
    return;
  }

  fields[fieldInfo.fieldName] = value == null ? '' : String(value);
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function getBeijingNowShiftedDate() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
  return new Date(utcMs + BEIJING_OFFSET_MS);
}

function formatDate(value) {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getYesterdayDateString() {
  const beijingNow = getBeijingNowShiftedDate();
  beijingNow.setUTCDate(beijingNow.getUTCDate() - 1);
  return formatDate(beijingNow);
}

function getTodayDateString() {
  return formatDate(getBeijingNowShiftedDate());
}

function extractDateRange(record) {
  const raw = record && record.raw_fields ? record.raw_fields : {};
  return {
    date_start: record.date_start || raw.date_start || '',
    date_stop: record.date_stop || raw.date_stop || ''
  };
}

function buildSourceValueMap(record) {
  const map = new Map();
  if (!record || typeof record !== 'object') return map;
  for (const key of Object.keys(record)) {
    if (key === 'raw_fields') continue;
    map.set(normalizeFieldName(key), record[key]);
  }
  const rawFields = record.raw_fields;
  if (rawFields && typeof rawFields === 'object') {
    for (const key of Object.keys(rawFields)) {
      map.set(normalizeFieldName(key), rawFields[key]);
    }
  }
  return map;
}

function guessKind(value) {
  if (value === null || value === undefined) return 'text';
  if (typeof value === 'number') {
    return value > 10000000000 ? 'datetime' : 'number';
  }
  const s = String(value).trim();
  if (!s) return 'text';
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed) && (s.includes('-') || s.includes('/') || s.includes(':'))) {
    return 'datetime';
  }
  const n = Number(s);
  if (Number.isFinite(n)) return 'number';
  return 'text';
}

async function getTenantAccessToken() {
  const response = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      app_id: LARK_APP_ID,
      app_secret: LARK_APP_SECRET
    })
  });

  const data = await response.json();
  return data.tenant_access_token || '';
}

async function listBitableFields(tenantAccessToken, tableId) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${tableId}/fields?page_size=200`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + tenantAccessToken
    }
  });
  return await response.json();
}

function buildFieldMapping(fieldsItems) {
  const fieldsIndex = buildFieldNameIndex(fieldsItems);

  const mapping = {
    campaign_name: pickField(fieldsIndex, ['campaign_name', 'campaignname', 'campaign', '广告系列', '广告系列名称', '系列名称']),
    spend: pickField(fieldsIndex, ['spend', 'cost', 'amountspent', '已花费金额', '花费', '花费金额', '消耗', '回流消耗']),
    budget: pickField(fieldsIndex, ['budget', '预算', '日预算', '总预算', 'lifetimebudget', 'dailybudget']),
    impressions: pickField(fieldsIndex, ['impressions', '展示次数', '展示', '展现次数']),
    clicks: pickField(fieldsIndex, ['clicks', '点击量（全部）', '点击量', '点击次数', '点击']),
    ctr: pickField(fieldsIndex, ['ctr', '点击率（全部）', '点击率']),
    unique_link_clicks: pickField(fieldsIndex, ['unique_link_clicks', '链接点击量-独立用户', '链接点击量', '链接点击量（独立用户）']),
    results: pickField(fieldsIndex, ['results', '成效', '结果']),
    cost_per_result: pickField(fieldsIndex, ['cost_per_result', '单次成效费用', '单次结果费用', '每结果费用']),
    complete_registrations: pickField(fieldsIndex, ['complete_registrations', 'complete_registration', '完成注册次数', '注册完成次数']),
    omni_complete_registration: pickField(fieldsIndex, ['omni_complete_registration', '完成注册次数']),
    upload_mode: pickField(fieldsIndex, ['upload_mode', 'uploadmode', '上传模式', '模式']),
    operator: pickField(fieldsIndex, ['operator', '操作人', '操作者', '采集人']),
    username: pickField(fieldsIndex, ['username', 'user', '用户名', '用户']),
    project_name: pickField(fieldsIndex, ['project_name', 'project', '项目名称', '项目']),
    buyer_name: pickField(fieldsIndex, ['buyer_name', 'buyer', '投手名称', '投手', '操盘手']),
    ad_account_id: pickField(fieldsIndex, ['ad_account_id', 'account_id', '广告账户编号', '广告账户id', '广告账户ID']),
    timestamp: pickField(fieldsIndex, ['timestamp', 'time', '采集时间', '时间', '创建时间']),
    date_start: pickField(fieldsIndex, ['date_start', 'datestart', '开始日期', '起始日期']),
    date_stop: pickField(fieldsIndex, ['date_stop', 'datestop', '结束日期', '截止日期', '终止日期']),
    data_start: pickField(fieldsIndex, ['data_start', 'datastart', 'date_start', 'datestart', '开始日期']),
    data_stop: pickField(fieldsIndex, ['data_stop', 'datastop', 'date_stop', 'datestop', '结束日期'])
  };

  return mapping;
}

function buildFieldsPayload(record, mapping, fieldsItems, allowedKeys) {
  const fields = {};
  const raw = record && record.raw_fields ? record.raw_fields : {};
  const spendValue = record.spend !== undefined && record.spend !== null ? record.spend : raw.spend;
  const clicksValue = record.clicks !== undefined && record.clicks !== null ? record.clicks : raw.clicks;
  const ctrValue = record.ctr !== undefined && record.ctr !== null ? record.ctr : raw.ctr;
  const uniqueLinkClicksValue = record.unique_link_clicks !== undefined && record.unique_link_clicks !== null
    ? record.unique_link_clicks
    : raw.unique_link_clicks;

  const allow = (key) => !allowedKeys || allowedKeys.has(normalizeFieldName(key));

  if (allow('campaign_name')) setBitableFieldValue(fields, mapping.campaign_name, record.campaign_name || '', 'text');
  if (allow('budget')) setBitableFieldValue(fields, mapping.budget, record.budget, 'number');
  if (allow('spend')) setBitableFieldValue(fields, mapping.spend, spendValue, 'number');
  if (allow('impressions')) setBitableFieldValue(fields, mapping.impressions, record.impressions, 'number');
  if (allow('clicks')) setBitableFieldValue(fields, mapping.clicks, clicksValue, 'number');
  if (allow('ctr')) setBitableFieldValue(fields, mapping.ctr, ctrValue, 'number');
  if (allow('unique_link_clicks')) {
    setBitableFieldValue(fields, mapping.unique_link_clicks, uniqueLinkClicksValue, 'number');
  }
  if (allow('results')) setBitableFieldValue(fields, mapping.results, record.results, 'number');
  if (allow('cost_per_result')) setBitableFieldValue(fields, mapping.cost_per_result, record.cost_per_result, 'number');
  if (allow('complete_registrations')) {
    setBitableFieldValue(fields, mapping.complete_registrations, record.complete_registrations, 'number');
  }
  if (allow('omni_complete_registration')) {
    setBitableFieldValue(fields, mapping.omni_complete_registration, record.omni_complete_registration, 'number');
  }
  if (allow('upload_mode')) setBitableFieldValue(fields, mapping.upload_mode, record.upload_mode || '', 'text');
  if (allow('operator')) setBitableFieldValue(fields, mapping.operator, record.operator || '', 'text');
  if (allow('username')) setBitableFieldValue(fields, mapping.username, record.username || '', 'text');
  if (allow('project_name')) setBitableFieldValue(fields, mapping.project_name, record.project_name || '', 'text');
  if (allow('buyer_name')) setBitableFieldValue(fields, mapping.buyer_name, record.buyer_name || '', 'text');
  if (allow('ad_account_id')) {
    setBitableFieldValue(fields, mapping.ad_account_id, record.ad_account_id || raw.ad_account_id || '', 'text');
  }
  if (allow('timestamp')) setBitableFieldValue(fields, mapping.timestamp, record.timestamp || '', 'datetime');
  if (allow('date_start')) setBitableFieldValue(fields, mapping.date_start, record.date_start || '', 'datetime');
  if (allow('date_stop')) setBitableFieldValue(fields, mapping.date_stop, record.date_stop || '', 'datetime');
  if (allow('data_start')) setBitableFieldValue(fields, mapping.data_start, record.date_start || '', 'datetime');
  if (allow('data_stop')) setBitableFieldValue(fields, mapping.data_stop, record.date_stop || '', 'datetime');

  const fieldsIndex = buildFieldNameIndex(fieldsItems || []);
  const sourceMap = buildSourceValueMap(record);
  for (const [normKey, value] of sourceMap.entries()) {
    if (allowedKeys && !allowedKeys.has(normKey)) continue;
    const fieldInfo = fieldsIndex.get(normKey);
    if (!fieldInfo || fields[fieldInfo.fieldName] !== undefined) continue;
    const kind = guessKind(value);
    setBitableFieldValue(fields, fieldInfo, value, kind);
  }

  return fields;
}

async function addRecordToBitable(tenantAccessToken, fieldsPayload, tableId) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${tableId}/records`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + tenantAccessToken
    },
    body: JSON.stringify({
      fields: fieldsPayload
    })
  });

  return await response.json();
}

async function uploadToTable(tenantAccessToken, tableId, commonPayload, data, allowedKeys) {
  const fieldsResp = await listBitableFields(tenantAccessToken, tableId);
  if (fieldsResp && typeof fieldsResp.code === 'number' && fieldsResp.code !== 0) {
    return {
      table_id: tableId,
      uploaded: 0,
      failed: data.length,
      errors: [{
        code: fieldsResp.code,
        error: fieldsResp.msg || 'Failed to list bitable fields',
        table_id: tableId
      }]
    };
  }
  const fieldsItems = (fieldsResp && fieldsResp.data && Array.isArray(fieldsResp.data.items)) ? fieldsResp.data.items : [];
  if (!fieldsItems.length) {
    return {
      table_id: tableId,
      uploaded: 0,
      failed: data.length,
      errors: [{
        code: 1254046,
        error: 'No fields found in target table',
        table_id: tableId
      }]
    };
  }
  const fieldMapping = buildFieldMapping(fieldsItems);

  const results = [];
  const errors = [];

  for (const record of data) {
    try {
      const fieldsPayload = buildFieldsPayload(
        {
          ...record,
          ...commonPayload
        },
        fieldMapping,
        fieldsItems,
        allowedKeys
      );

      if (!fieldsPayload || Object.keys(fieldsPayload).length === 0) {
        const availableFields = fieldsItems.map((f) => f.field_name).filter(Boolean);
        errors.push({
          campaign_name: record.campaign_name,
          code: 1254045,
          error: 'FieldNameNotFound: no matched columns in target table',
          table_id: tableId,
          available_fields: availableFields
        });
        continue;
      }

      const result = await addRecordToBitable(tenantAccessToken, fieldsPayload, tableId);

      if (result.code && result.code !== 0) {
        errors.push({
          campaign_name: record.campaign_name,
          code: result.code,
          error: result.msg,
          table_id: tableId
        });
      } else {
        results.push(result);
      }
    } catch (err) {
      errors.push({
        campaign_name: record.campaign_name,
        code: -1,
        error: err.message,
        table_id: tableId
      });
    }
  }

  return {
    table_id: tableId,
    uploaded: results.length,
    failed: errors.length,
    errors: errors.length > 0 ? errors : undefined,
    meta: {
      available_fields: fieldsItems.map((f) => f.field_name),
      mapped_fields: Object.fromEntries(
        Object.entries(fieldMapping)
          .filter(([, v]) => v && v.fieldName)
          .map(([k, v]) => [k, v.fieldName])
      )
    }
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { operator, username, project_name, buyer_name, upload_mode, timestamp, data } = req.body;
  const isRefluxMode = upload_mode === '回流' || upload_mode === '回流消耗';
  const normalizedUploadMode = isRefluxMode ? '回流消耗' : '当日消耗';
  const mainTableId = isRefluxMode ? LARK_REFLUX_TABLE_ID : LARK_TABLE_ID;
  const tableCandidates = isRefluxMode
    ? [LARK_REFLUX_TABLE_ID, LARK_TABLE_ID, LARK_TABLE_ID_EXTRA]
    : [LARK_TABLE_ID, LARK_TABLE_ID_EXTRA];
  const tableIdSet = new Set(tableCandidates.filter(Boolean));
  const tableIds = Array.from(tableIdSet);

  if (!data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'Invalid data format: expected { data: [...] }' });
  }

  if (data.length === 0) {
    return res.status(400).json({ error: 'No records to upload' });
  }

  if (!project_name || !buyer_name) {
    return res.status(400).json({ error: 'Project and buyer are required' });
  }

  {
    const invalidRecord = data.find((record) => {
      const range = extractDateRange(record);
      const start = range.date_start || '';
      const stop = range.date_stop || '';
      if (!start || !stop) return true;
      return start !== stop;
    });
    if (invalidRecord) {
      const range = extractDateRange(invalidRecord);
      return res.status(400).json({
        error: 'Invalid date range: date_start and date_stop must be the same date',
        upload_mode: normalizedUploadMode,
        actual: { date_start: range.date_start || null, date_stop: range.date_stop || null }
      });
    }
    const uniqueDates = new Set(
      data
        .map((record) => {
          const range = extractDateRange(record);
          return range.date_start || '';
        })
        .filter(Boolean)
    );
    if (uniqueDates.size > 1) {
      return res.status(400).json({
        error: 'Invalid date range: all records must use the same date',
        upload_mode: normalizedUploadMode,
        actual_dates: Array.from(uniqueDates).slice(0, 10)
      });
    }
  }

  if (ENFORCE_DATE_VALIDATION) {
    if (isRefluxMode) {
      const today = getTodayDateString();
      const yesterday = getYesterdayDateString();
      const invalidRecord = data.find((record) => {
        const range = extractDateRange(record);
        const start = range.date_start || '';
        const stop = range.date_stop || '';
        if (!start || !stop) return true;
        return start === today || start === yesterday || stop === today || stop === yesterday;
      });
      if (invalidRecord) {
        const range = extractDateRange(invalidRecord);
        return res.status(400).json({
          error: 'Invalid date range for reflux mode',
          disallowed: [today, yesterday],
          actual: { date_start: range.date_start || null, date_stop: range.date_stop || null }
        });
      }
    } else {
      const expectedDate = getYesterdayDateString();
      const invalidRecord = data.find((record) => {
        const range = extractDateRange(record);
        return range.date_start !== expectedDate || range.date_stop !== expectedDate;
      });
      if (invalidRecord) {
        const range = extractDateRange(invalidRecord);
        return res.status(400).json({
          error: 'Invalid date range',
          expected: expectedDate,
          actual: { date_start: range.date_start || null, date_stop: range.date_stop || null }
        });
      }
    }
  }

  if (!LARK_APP_TOKEN || !LARK_APP_ID || !LARK_APP_SECRET || !mainTableId) {
    return res.status(500).json({ error: 'Lark API configuration missing' });
  }

  try {
    const tenantAccessToken = await getTenantAccessToken();

    if (!tenantAccessToken) {
      return res.status(500).json({ error: 'Failed to get tenant access token' });
    }

    const commonPayload = {
      operator: operator,
      username: username || operator,
      project_name: project_name,
      buyer_name: buyer_name,
      upload_mode: normalizedUploadMode,
      timestamp: timestamp
    };
    const allowedKeys = isRefluxMode
      ? new Set([
          normalizeFieldName('spend'),
          normalizeFieldName('project_name'),
          normalizeFieldName('buyer_name'),
          normalizeFieldName('ad_account_id'),
          normalizeFieldName('upload_mode'),
          normalizeFieldName('timestamp'),
          normalizeFieldName('date_start'),
          normalizeFieldName('date_stop'),
          normalizeFieldName('data_start'),
          normalizeFieldName('data_stop')
        ])
      : null;
    const perTableResults = [];
    const mergedErrors = [];
    let totalUploaded = 0;
    let totalFailed = 0;

    for (const tableId of tableIds) {
      const tableResult = await uploadToTable(tenantAccessToken, tableId, commonPayload, data, allowedKeys);
      perTableResults.push(tableResult);
      totalUploaded += tableResult.uploaded || 0;
      totalFailed += tableResult.failed || 0;
      if (Array.isArray(tableResult.errors)) {
        mergedErrors.push(...tableResult.errors);
      }
    }

    const firstMeta = perTableResults.length ? perTableResults[0].meta : null;
    return res.status(200).json({
      success: true,
      uploaded: totalUploaded,
      failed: totalFailed,
      errors: mergedErrors.length > 0 ? mergedErrors : undefined,
      meta: {
        tables: perTableResults.map((r) => ({
          table_id: r.table_id,
          uploaded: r.uploaded,
          failed: r.failed
        })),
        ...(firstMeta || {})
      }
    });

  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
};
