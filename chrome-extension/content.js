(function() {
  const API_PATTERNS = [
    /graph\.facebook\.com/,
    /adsmanager/,
    /insights/,
    /ads/,
    /campaign/,
    /act_\d+/,
  ];

  const BLOCKED_PATTERNS = [
    /profile/,
    /photo/,
    /video/,
    /image/,
    /avatar/,
  ];

  let isCollecting = false;
  let collectedRecords = [];
  let originalFetch = window.fetch;
  let originalXHROpen = XMLHttpRequest.prototype.open;
  let originalXHRSend = XMLHttpRequest.prototype.send;
  let originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  function shouldCapture(url) {
    if (!url) return false;
    const lowerUrl = url.toLowerCase();
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(lowerUrl)) return false;
    }
    for (const pattern of API_PATTERNS) {
      if (pattern.test(lowerUrl)) return true;
    }
    return false;
  }

  function extractAdData(data) {
    const records = [];

    function processObject(obj, path = '') {
      if (!obj || typeof obj !== 'object') return;

      if (Array.isArray(obj)) {
        obj.forEach((item, index) => processObject(item, path + '[' + index + ']'));
        return;
      }

      const campaignName = obj.campaign_name || obj.campaignName || obj.name || obj.title || '';
      const spend = obj.spend || obj.spend_amount || obj.amount_spent || '';
      const impressions = obj.impressions || obj.impression || obj.reach || '';
      const clicks = obj.clicks || obj.click || obj.link_clicks || '';
      const dateStart = obj.date_start || obj.dateStart || obj.start_date || '';
      const dateStop = obj.date_stop || obj.dateStop || obj.end_date || '';

      if ((campaignName || spend || impressions || clicks) &&
          (spend !== '' || impressions !== '' || clicks !== '')) {
        records.push({
          campaign_name: String(campaignName),
          spend: String(spend),
          impressions: String(impressions),
          clicks: String(clicks),
          date_start: String(dateStart),
          date_stop: String(dateStop)
        });
      }

      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          const value = obj[key];
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            processObject(value, path + '.' + key);
          } else if (Array.isArray(value)) {
            processObject(value, path + '.' + key);
          }
        }
      }
    }

    processObject(data);
    return records;
  }

  function processResponse(jsonData) {
    if (!isCollecting) return;

    const newRecords = extractAdData(jsonData);

    if (newRecords.length > 0) {
      newRecords.forEach(record => {
        const exists = collectedRecords.some(
          r => r.campaign_name === record.campaign_name &&
               r.spend === record.spend &&
               r.date_start === record.date_start
        );
        if (!exists) {
          collectedRecords.push(record);
        }
      });
    }
  }

  async function captureFetchResponse(response, url) {
    if (!shouldCapture(url) || !isCollecting) return;

    try {
      const clone = response.clone();
      const contentType = clone.headers.get('content-type') || '';

      if (contentType.includes('application/json') ||
          contentType.includes('text/javascript') ||
          url.includes('json')) {
        try {
          const json = await clone.json();
          processResponse(json);
        } catch (e) {
          const text = await clone.text();
          try {
            const json = JSON.parse(text);
            processResponse(json);
          } catch (e2) {}
        }
      }
    } catch (e) {}
  }

  window.fetch = async function(input, init) {
    const response = await originalFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input.url;

    if (shouldCapture(url) && isCollecting) {
      captureFetchResponse(response, url);
    }

    return response;
  };

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = url;
    this._method = method;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (!this._headers) this._headers = {};
    this._headers[name] = value;
    return originalXHRSetRequestHeader.apply(this, arguments);
  };

  const xhrResponseCapture = function() {
    const status = this.status;
    const responseType = this.responseType;
    const url = this._url;

    if (shouldCapture(url) && isCollecting && status >= 200 && status < 300) {
      try {
        let responseData = this.response;

        if (typeof responseData === 'string') {
          try {
            responseData = JSON.parse(responseData);
          } catch (e) {}
        }

        if (responseData && typeof responseData === 'object') {
          processResponse(responseData);
        }
      } catch (e) {}
    }
  };

  XMLHttpRequest.prototype.send = function(data) {
    if (this.addEventListener) {
      this.addEventListener('load', xhrResponseCapture);
    } else {
      const originalOnReadyStateChange = this.onreadystatechange;
      this.onreadystatechange = function() {
        if (this.readyState === 4) {
          xhrResponseCapture.call(this);
        }
        if (originalOnReadyStateChange) {
          originalOnReadyStateChange.apply(this, arguments);
        }
      };
    }

    return originalXHRSend.apply(this, arguments);
  };

  function getOperatorId() {
    const userData = window.__USER__ || window.FB || {};
    const userId = userData.userID || userData.user_id || '';
    const email = userData.email || '';

    if (userId) return userId;
    if (email) return email;

    const scripts = document.getElementsByTagName('script');
    for (let script of scripts) {
      const src = script.src || '';
      if (src.includes('user')) {
        const match = src.match(/user[_-]?id[=:](\d+)/i);
        if (match) return match[1];
      }
    }

    return navigator.userAgent + '-' + Math.random().toString(36).substring(7);
  }

  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'startCollection') {
      isCollecting = true;
      collectedRecords = [];
      addLog('开始采集数据...');

      setTimeout(() => {
        isCollecting = false;
        addLog('采集完成，共 ' + collectedRecords.length + ' 条记录');
        sendResponse({
          success: true,
          data: collectedRecords,
          operator: getOperatorId()
        });
      }, 3000);

      return true;
    }

    if (request.action === 'getData') {
      sendResponse({
        data: collectedRecords,
        operator: getOperatorId()
      });
      return true;
    }

    if (request.action === 'clearData') {
      collectedRecords = [];
      sendResponse({ success: true });
      return true;
    }
  });

  function addLog(message) {
    console.log('[Facebook Ads Collector] ' + message);
  }

  addLog('Facebook Ads Collector 已加载');
})();
