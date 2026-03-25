const fetch = require('node-fetch');

const LARK_APP_TOKEN = process.env.LARK_APP_TOKEN || '';
const LARK_APP_ID = process.env.LARK_APP_ID || '';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || '';
const LARK_TABLE_ID = process.env.LARK_TABLE_ID || '';
const API_TOKEN = process.env.API_TOKEN || '';

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

async function listBitableFields(tenantAccessToken) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_TABLE_ID}/fields?page_size=200`;
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
    spend: pickField(fieldsIndex, ['spend', 'cost', 'amountspent', '已花费金额', '花费', '花费金额', '消耗']),
    impressions: pickField(fieldsIndex, ['impressions', '展示次数', '展示', '展现次数']),
    clicks: pickField(fieldsIndex, ['clicks', '点击次数', '点击']),
    operator: pickField(fieldsIndex, ['operator', '操作人', '操作者', '采集人']),
    timestamp: pickField(fieldsIndex, ['timestamp', 'time', '采集时间', '时间', '创建时间']),
    date_start: pickField(fieldsIndex, ['date_start', 'datestart', '开始日期', '起始日期']),
    date_stop: pickField(fieldsIndex, ['date_stop', 'datestop', '结束日期', '截止日期', '终止日期'])
  };

  return mapping;
}

function buildFieldsPayload(record, mapping) {
  const fields = {};

  setBitableFieldValue(fields, mapping.campaign_name, record.campaign_name || '', 'text');
  setBitableFieldValue(fields, mapping.spend, record.spend, 'number');
  setBitableFieldValue(fields, mapping.impressions, record.impressions, 'number');
  setBitableFieldValue(fields, mapping.clicks, record.clicks, 'number');
  setBitableFieldValue(fields, mapping.operator, record.operator || '', 'text');
  setBitableFieldValue(fields, mapping.timestamp, record.timestamp || '', 'datetime');
  setBitableFieldValue(fields, mapping.date_start, record.date_start || '', 'datetime');
  setBitableFieldValue(fields, mapping.date_stop, record.date_stop || '', 'datetime');

  return fields;
}

async function addRecordToBitable(tenantAccessToken, fieldsPayload) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_TABLE_ID}/records`;

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

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  if (token !== API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  const { operator, timestamp, data } = req.body;

  if (!data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'Invalid data format: expected { data: [...] }' });
  }

  if (data.length === 0) {
    return res.status(400).json({ error: 'No records to upload' });
  }

  if (!LARK_APP_TOKEN || !LARK_APP_ID || !LARK_APP_SECRET || !LARK_TABLE_ID) {
    return res.status(500).json({ error: 'Lark API configuration missing' });
  }

  try {
    const tenantAccessToken = await getTenantAccessToken();

    if (!tenantAccessToken) {
      return res.status(500).json({ error: 'Failed to get tenant access token' });
    }

    const fieldsResp = await listBitableFields(tenantAccessToken);
    const fieldsItems = (fieldsResp && fieldsResp.data && Array.isArray(fieldsResp.data.items)) ? fieldsResp.data.items : [];
    const fieldMapping = buildFieldMapping(fieldsItems);

    const results = [];
    const errors = [];

    for (const record of data) {
      try {
        const fieldsPayload = buildFieldsPayload(
          {
            ...record,
            operator: operator,
            timestamp: timestamp
          },
          fieldMapping
        );

        if (!fieldsPayload || Object.keys(fieldsPayload).length === 0) {
          errors.push({
            campaign_name: record.campaign_name,
            code: 1254045,
            error: 'FieldNameNotFound'
          });
          continue;
        }

        const result = await addRecordToBitable(tenantAccessToken, fieldsPayload);

        if (result.code && result.code !== 0) {
          errors.push({
            campaign_name: record.campaign_name,
            code: result.code,
            error: result.msg
          });
        } else {
          results.push(result);
        }
      } catch (err) {
        errors.push({
          campaign_name: record.campaign_name,
          code: -1,
          error: err.message
        });
      }
    }

    return res.status(200).json({
      success: true,
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
    });

  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
};
