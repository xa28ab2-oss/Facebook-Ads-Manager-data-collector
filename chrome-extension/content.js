(function() {
  function cleanCellText(value) {
    return String(value || '')
      .split('\n')
      .map((part) => part.trim())
      .filter((part) => part && !['help_outline', 'expand_more', 'settings'].includes(part))
      .join(' ')
      .trim();
  }

  function parseNumber(value) {
    const text = String(value || '').replace(/,/g, '').replace(/[^0-9.\-]/g, '');
    const number = Number(text);
    return Number.isFinite(number) ? number : 0;
  }

  function extractGoogleAdsDate() {
    const text = document.body ? document.body.innerText : '';
    const iso = text.match(/(20\d{2})-(\d{2})-(\d{2})\s*(?:至|–|—|-)\s*(20\d{2})-(\d{2})-(\d{2})/);
    if (iso) return { date_start: `${iso[1]}-${iso[2]}-${iso[3]}`, date_stop: `${iso[4]}-${iso[5]}-${iso[6]}` };
    const zh = text.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*[–—-]\s*(?:(20\d{2})年\s*)?(\d{1,2})月\s*(\d{1,2})日)?/);
    if (!zh) return null;
    const pad = (part) => String(part).padStart(2, '0');
    const start = `${zh[1]}-${pad(zh[2])}-${pad(zh[3])}`;
    const stop = zh[5] ? `${zh[4] || zh[1]}-${pad(zh[5])}-${pad(zh[6])}` : start;
    return { date_start: start, date_stop: stop };
  }

  function collectGoogleAdsData() {
    const range = extractGoogleAdsDate();
    if (!range) return { success: false, error: '无法识别 Google Ads 日期范围' };
    if (range.date_start !== range.date_stop) return { success: false, error: 'Google Ads 只支持采集单日数据' };

    const grids = Array.from(document.querySelectorAll('[role="grid"]'));
    for (const grid of grids) {
      const rows = Array.from(grid.querySelectorAll('[role="row"]'));
      if (!rows.length) continue;
      const headers = Array.from(rows[0].querySelectorAll('[role="columnheader"], [role="gridcell"]'))
        .map((cell) => cleanCellText(cell.getAttribute('aria-label') || cell.innerText));
      if (!headers.includes('广告系列') || !headers.includes('费用')) continue;
      const totalRow = rows.find((row) => cleanCellText(row.innerText).includes('总计：账号'));
      if (!totalRow) continue;
      const values = Array.from(totalRow.querySelectorAll('[role="gridcell"]')).map((cell) => cleanCellText(cell.innerText));
      const fields = {};
      // Google 的账号汇总行会比表头多一个左侧展开单元格；指标列从右侧对齐最稳定。
      headers.forEach((header, index) => {
        if (!header) return;
        const valueIndex = values.length - (headers.length - index);
        fields[header] = values[valueIndex] || '';
      });
      const accountMatch = (document.body.innerText || '').match(/\b\d{3}-\d{3}-\d{4}\b/);
      const costPerConversion = parseNumber(fields['每次转化费用']);
      const record = {
        platform: 'google_ads',
        campaign_name: 'Google Ads 账号汇总',
        account_id: accountMatch ? accountMatch[0].replace(/-/g, '') : '',
        ad_account_id: accountMatch ? accountMatch[0].replace(/-/g, '') : '',
        date_start: range.date_start,
        date_stop: range.date_stop,
        spend: parseNumber(fields['费用']),
        impressions: parseNumber(fields['展示次数']),
        clicks: parseNumber(fields['点击次数']),
        results: parseNumber(fields['转化次数']),
        conversions: parseNumber(fields['转化次数']),
        ctr: parseNumber(fields['点击率']),
        conversion_rate: parseNumber(fields['转化率']),
        cpc: parseNumber(fields['平均每次点击费用']),
        cost_per_conversion: costPerConversion,
        cost_per_result: costPerConversion,
        currency: (fields['费用'].match(/^[^\d\s]+/) || [''])[0],
        raw_fields: {
          ...fields,
          source_platform: 'google_ads',
          spend: parseNumber(fields['费用']),
          impressions: parseNumber(fields['展示次数']),
          clicks: parseNumber(fields['点击次数']),
          results: parseNumber(fields['转化次数']),
          date_start: range.date_start,
          date_stop: range.date_stop
        }
      };
      return { success: true, data: [record], meta: { platform: 'google_ads', headers } };
    }
    return { success: false, error: '未找到 Google Ads 广告系列汇总表，请打开广告系列报表并显示费用、展示次数、点击次数和转化次数列' };
  }

  function extractFacebookAdsDate() {
    const value = new URL(location.href).searchParams.get('date') || '';
    const match = value.match(/^(20\d{2}-\d{2}-\d{2})_(20\d{2}-\d{2}-\d{2})$/);
    if (!match) return null;
    const start = match[1];
    const rawStop = match[2];
    const startTime = Date.parse(`${start}T00:00:00Z`);
    const rawStopTime = Date.parse(`${rawStop}T00:00:00Z`);

    // Facebook Ads URL 使用右开区间：选择 5 月 22 日时，date 参数会是
    // 2026-05-22_2026-05-23。上传接口需要的是实际报表日期，因此结束日减一天。
    if (Number.isFinite(startTime) && Number.isFinite(rawStopTime) && rawStopTime > startTime) {
      const inclusiveStop = new Date(rawStopTime - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      return { date_start: start, date_stop: inclusiveStop };
    }
    return { date_start: start, date_stop: rawStop };
  }

  function findFacebookSummaryRow() {
    const rows = Array.from(document.querySelectorAll('[role="presentation"]'));
    return rows.find((row) => {
      const text = cleanCellText(row.innerText || row.textContent || '');
      return /Results from \d+ campaigns/i.test(text) || /\d+\s*个广告系列/.test(text) || text.includes('广告系列的成效');
    }) || null;
  }

  function facebookMetricKeyFromSurface(surface) {
    const value = String(surface || '').toLowerCase();
    if (value.includes('forattributionwindow(results,')) return 'results';
    if (value.includes('table_cell:spend')) return 'spend';
    if (value.includes('table_cell:impressions')) return 'impressions';
    if (value.includes('table_cell:reach')) return 'reach';
    if (value.includes('table_cell:clicks') || value.includes('table_cell:inline_link_clicks') || value.includes('table_cell:link_clicks')) return 'clicks';
    return '';
  }

  function parseOptionalFacebookNumber(value) {
    const text = cleanCellText(value);
    if (!text || text === '-' || text === '—') return null;
    const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) ? number : null;
  }

  function collectFacebookCampaignRowResults(summaryRow) {
    const summaryText = cleanCellText(summaryRow.innerText || summaryRow.textContent || '');
    const countMatch = summaryText.match(/Results from\s+(\d+)\s+campaigns/i) || summaryText.match(/(\d+)\s*个广告系列/);
    const expectedCount = countMatch ? Number(countMatch[1]) : 0;
    const rows = Array.from(document.querySelectorAll('[role="presentation"]'));
    const resultByCampaign = new Map();

    for (const row of rows) {
      if (row === summaryRow || row.contains(summaryRow) || summaryRow.contains(row)) continue;
      const nameCell = row.querySelector('[data-surface*="forObjectType(name,CAMPAIGN_GROUP)"]');
      const resultCell = row.querySelector('[data-surface*="forAttributionWindow(results,"]');
      if (!nameCell || !resultCell) continue;
      const campaignName = cleanCellText(nameCell.innerText || nameCell.textContent || '');
      if (!campaignName) continue;
      const resultValue = parseOptionalFacebookNumber(resultCell.innerText || resultCell.textContent || '');
      resultByCampaign.set(campaignName, resultValue === null ? 0 : resultValue);
    }

    if (!expectedCount) {
      return { success: false, error: '无法识别 Facebook Ads 广告系列总数，不能安全汇总成效' };
    }
    if (resultByCampaign.size !== expectedCount) {
      return {
        success: false,
        error: `Facebook 汇总成效为空，且 DOM 只加载了 ${resultByCampaign.size}/${expectedCount} 个广告系列，不能安全求和`
      };
    }
    return {
      success: true,
      value: Array.from(resultByCampaign.values()).reduce((sum, value) => sum + value, 0),
      row_count: resultByCampaign.size
    };
  }

  function collectFacebookAdsData() {
    const range = extractFacebookAdsDate();
    if (!range) return { success: false, error: '无法从 Facebook Ads 页面 URL 识别日期范围' };
    if (range.date_start !== range.date_stop) return { success: false, error: 'Facebook DOM 测试版只支持采集单日数据' };

    const summaryRow = findFacebookSummaryRow();
    if (!summaryRow) return { success: false, error: '未找到 Facebook Ads 广告系列汇总行' };

    const metricText = {};
    for (const cell of summaryRow.querySelectorAll('[data-surface]')) {
      const key = facebookMetricKeyFromSurface(cell.getAttribute('data-surface'));
      if (!key) continue;
      metricText[key] = cleanCellText(cell.innerText || cell.textContent || '');
    }

    let resultValue = parseOptionalFacebookNumber(metricText.results);
    let resultSource = 'summary';
    let resultFallbackReason = '';
    if (resultValue === null) {
      const aggregate = collectFacebookCampaignRowResults(summaryRow);
      if (aggregate.success) {
        resultValue = aggregate.value;
        resultSource = 'campaign_rows';
      } else {
        resultSource = 'network_fallback_required';
        resultFallbackReason = aggregate.error || 'DOM 无法安全汇总成效';
      }
    }

    const labels = { spend: '消耗', results: '成效', reach: '覆盖人数', impressions: '展示量', clicks: '点击量（全部）' };
    const missing = ['spend', 'reach', 'impressions', 'clicks']
      .filter((key) => !Object.prototype.hasOwnProperty.call(metricText, key));
    if (missing.length) {
      return {
        success: false,
        error: 'Facebook DOM 报表缺少可读取列：' + missing.map((key) => labels[key]).join('、') + '。请调整列模板并确保这些列已显示在表格中'
      };
    }

    const params = new URL(location.href).searchParams;
    const accountId = String(params.get('act') || '').replace(/\D/g, '');
    const businessId = String(params.get('business_id') || '').replace(/\D/g, '');
    const spendText = metricText.spend || '';
    const currency = (spendText.match(/^[^\d\s—-]+/) || [''])[0];
    const record = {
      platform: 'facebook_ads',
      campaign_name: 'Facebook Ads 账号汇总',
      account_id: accountId,
      ad_account_id: accountId,
      business_id: businessId,
      bm_id: businessId,
      date_start: range.date_start,
      date_stop: range.date_stop,
      spend: parseNumber(spendText),
      reach: parseNumber(metricText.reach),
      impressions: parseNumber(metricText.impressions),
      clicks: parseNumber(metricText.clicks),
      currency,
      raw_fields: {
        source_platform: 'facebook_ads',
        business_id: businessId,
        bm_id: businessId,
        spend: parseNumber(spendText),
        results_source: resultSource,
        results_fallback_reason: resultFallbackReason,
        reach: parseNumber(metricText.reach),
        impressions: parseNumber(metricText.impressions),
        clicks: parseNumber(metricText.clicks),
        date_start: range.date_start,
        date_stop: range.date_stop
      }
    };
    if (resultValue !== null) {
      record.results = resultValue;
      record.raw_fields.results = resultValue;
    }
    return {
      success: true,
      data: [record],
      meta: {
        platform: 'facebook_ads',
        collection_mode: 'dom_readonly',
        atomic_columns: ['spend', 'reach', 'impressions', 'clicks'],
        result_columns: ['results']
      }
    };
  }

  function findRefreshButton() {
    const selectors = [
      'material-button.icon-refresh[role="button"]',
      'material-button[role="button"]',
      'div[role="button"]',
      'span[role="button"]',
      'button',
      'div[aria-label*="刷新"]',
      'div[aria-label*="refresh"]',
    ];

    for (const selector of selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (el.offsetParent === null) continue;

          const label = el.getAttribute('aria-label') || '';
          const text = el.textContent?.trim() || '';
          const className = typeof el.className === 'string' ? el.className : '';

          if (label.includes('刷新') || label.toLowerCase().includes('refresh') ||
              text.includes('刷新') || text.toLowerCase().includes('refresh') ||
              className.split(/\s+/).includes('icon-refresh')) {
            return el;
          }
        }
      } catch (e) {}
    }

    return null;
  }

  async function clickRefreshButton() {
    const firstButton = findRefreshButton();
    if (!firstButton) return { success: false, error: '未找到刷新按钮' };
    firstButton.click();

    if (location.hostname === 'ads.google.com') {
      // Google Ads 通常一次刷新即可。仅当第一次刷新后报表仍不可读取时，才补点第二次。
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const firstRefreshResult = collectGoogleAdsData();
        if (firstRefreshResult && firstRefreshResult.success) {
          return { success: true, click_count: 1 };
        }
      }

      const secondButton = findRefreshButton();
      if (!secondButton) return { success: false, error: 'Google Ads 第二次刷新按钮未找到' };
      secondButton.click();
      return { success: true, click_count: 2, retried: true };
    }

    return { success: true, click_count: 1 };
  }

  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'clickRefresh') {
      clickRefreshButton()
        .then(sendResponse)
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    }
    if (request.action === 'collectGoogleAdsData') {
      sendResponse(collectGoogleAdsData());
      return true;
    }
    if (request.action === 'collectFacebookAdsData') {
      sendResponse(collectFacebookAdsData());
      return true;
    }
  });

  console.log('[Ads Data Collector] Content script loaded');
})();
