(function() {
  const statusEl = document.getElementById('status');
  const collectBtn = document.getElementById('collectBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statsEl = document.getElementById('stats');
  const logEl = document.getElementById('log');
  const apiEndpointInput = document.getElementById('apiEndpoint');
  const apiTokenInput = document.getElementById('apiToken');
  const recordCountEl = document.getElementById('recordCount');
  const totalSpendEl = document.getElementById('totalSpend');
  const totalImpressionsEl = document.getElementById('totalImpressions');
  const totalClicksEl = document.getElementById('totalClicks');

  let collectedData = [];

  function updateStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;
  }

  function addLog(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + type;
    entry.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function updateStats(data) {
    statsEl.style.display = 'block';
    recordCountEl.textContent = data.length;
    const totals = data.reduce((acc, item) => {
      acc.spend += parseFloat(item.spend) || 0;
      acc.impressions += parseInt(item.impressions) || 0;
      acc.clicks += parseInt(item.clicks) || 0;
      return acc;
    }, { spend: 0, impressions: 0, clicks: 0 });
    totalSpendEl.textContent = '$' + totals.spend.toFixed(2);
    totalImpressionsEl.textContent = totals.impressions.toLocaleString();
    totalClicksEl.textContent = totals.clicks.toLocaleString();
  }

  function loadSettings() {
    chrome.storage.local.get(['apiEndpoint', 'apiToken'], function(result) {
      if (result.apiEndpoint) {
        apiEndpointInput.value = result.apiEndpoint;
      }
      if (result.apiToken) {
        apiTokenInput.value = result.apiToken;
      }
    });
  }

  function saveSettings() {
    chrome.storage.local.set({
      apiEndpoint: apiEndpointInput.value,
      apiToken: apiTokenInput.value
    });
  }

  collectBtn.addEventListener('click', async function() {
    const apiEndpoint = apiEndpointInput.value.trim();
    const apiToken = apiTokenInput.value.trim();

    if (!apiEndpoint) {
      updateStatus('请输入 API 端点地址', 'error');
      addLog('错误: 未设置 API 端点', 'error');
      return;
    }

    if (!apiToken) {
      updateStatus('请输入授权 Token', 'error');
      addLog('错误: 未设置授权 Token', 'error');
      return;
    }

    saveSettings();

    updateStatus('正在采集数据...', 'collecting');
    collectBtn.disabled = true;
    addLog('开始采集广告数据...');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'startCollection' });

      if (response && response.success) {
        collectedData = response.data || [];
        addLog('采集到 ' + collectedData.length + ' 条记录', 'info');

        if (collectedData.length === 0) {
          updateStatus('未检测到广告数据', 'error');
          addLog('警告: 未检测到广告数据，请确保在 Ads Manager 页面', 'error');
          collectBtn.disabled = false;
          return;
        }

        updateStats(collectedData);
        updateStatus('正在上传数据...', 'collecting');

        const payload = {
          operator: response.operator || 'unknown',
          timestamp: new Date().toISOString(),
          data: collectedData
        };

        const uploadResponse = await fetch(apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiToken
          },
          body: JSON.stringify(payload)
        });

        if (uploadResponse.ok) {
          const result = await uploadResponse.json();
          updateStatus('上传成功!', 'success');
          addLog('数据已成功上传到 Lark', 'info');
          addLog('响应: ' + JSON.stringify(result), 'info');
        } else {
          const errorText = await uploadResponse.text();
          updateStatus('上传失败', 'error');
          addLog('上传失败: ' + uploadResponse.status + ' - ' + errorText, 'error');
        }
      } else {
        updateStatus('采集失败', 'error');
        addLog('采集失败: ' + (response?.error || '未知错误'), 'error');
      }
    } catch (error) {
      updateStatus('发生错误', 'error');
      addLog('错误: ' + error.message, 'error');
      console.error('Collection error:', error);
    }

    collectBtn.disabled = false;
  });

  clearBtn.addEventListener('click', function() {
    logEl.innerHTML = '';
    addLog('日志已清空', 'info');
  });

  apiEndpointInput.addEventListener('change', saveSettings);
  apiTokenInput.addEventListener('change', saveSettings);

  loadSettings();
  addLog('插件已就绪，请在 Facebook Ads Manager 页面使用', 'info');
})();
