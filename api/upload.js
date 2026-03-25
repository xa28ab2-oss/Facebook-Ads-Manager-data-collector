const LARK_APP_TOKEN = process.env.LARK_APP_TOKEN || '';
const LARK_APP_ID = process.env.LARK_APP_ID || '';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || '';
const LARK_TABLE_ID = process.env.LARK_TABLE_ID || '';
const API_TOKEN = process.env.API_TOKEN || '';

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

async function addRecordToBitable(tenantAccessToken, record) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_TABLE_ID}/records`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + tenantAccessToken
    },
    body: JSON.stringify({
      fields: {
        campaign_name: record.campaign_name,
        spend: parseFloat(record.spend) || 0,
        impressions: parseInt(record.impressions) || 0,
        clicks: parseInt(record.clicks) || 0,
        operator: record.operator || '',
        timestamp: record.timestamp || new Date().toISOString()
      }
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

  const { operator, timestamp, data } = req.body || {};

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

    const results = [];
    const errors = [];

    for (const record of data) {
      try {
        const result = await addRecordToBitable(tenantAccessToken, {
          ...record,
          operator: operator,
          timestamp: timestamp
        });

        if (result.code && result.code !== 0) {
          errors.push({
            campaign_name: record.campaign_name,
            error: result.msg
          });
        } else {
          results.push(result);
        }
      } catch (err) {
        errors.push({
          campaign_name: record.campaign_name,
          error: err.message
        });
      }
    }

    return res.status(200).json({
      success: true,
      uploaded: results.length,
      failed: errors.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
};

