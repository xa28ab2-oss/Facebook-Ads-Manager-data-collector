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
      if (result.apiEndpoint) apiEndpointInput.value = result.apiEndpoint;
      if (result.apiToken) apiTokenInput.value = result.apiToken;
    });
  }

  function saveSettings() {
    chrome.storage.local.set({
      apiEndpoint: apiEndpointInput.value,
      apiToken: apiTokenInput.value
    });
  }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { success: false, error: 'empty response' });
      });
    });
  }

  function findAndClickRefreshButton(tabId, callback) {
    chrome.tabs.sendMessage(tabId, { action: 'clickRefresh' }, function(response) {
      if (chrome.runtime.lastError) {
        callback(false, chrome.runtime.lastError.message);
      } else {
        callback(response && response.success);
      }
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
      addLog('标签页 ID: ' + tab.id);

      const startResp = await sendToBackground({ action: 'startCollection', tabId: tab.id });
      if (!startResp || !startResp.success) {
        updateStatus('采集启动失败', 'error');
        addLog('采集启动失败: ' + ((startResp && startResp.error) || 'unknown'), 'error');
        collectBtn.disabled = false;
        return;
      }

      addLog('点击刷新按钮...');
      findAndClickRefreshButton(tab.id, function(success, error) {
        if (success) {
          addLog('刷新按钮已点击');
        } else {
          addLog('点击刷新按钮失败: ' + error, 'error');
        }

        addLog('等待 10 秒采集数据...');

        setTimeout(async function() {
          addLog('正在获取采集结果...');

          const response = await sendToBackground({ action: 'getData' });
          collectedData = (response && response.data) || [];
          addLog('采集到 ' + collectedData.length + ' 条记录');

          if (collectedData.length === 0) {
            updateStatus('未检测到广告数据', 'error');
            addLog('警告: 未检测到广告数据', 'error');
            if (response && response.error) {
              addLog('采集错误: ' + response.error, 'error');
            }
            await sendToBackground({ action: 'stopCollection' });
            collectBtn.disabled = false;
            return;
          }

          updateStats(collectedData);
          updateStatus('正在上传数据...', 'collecting');

          const payload = {
            operator: 'unknown',
            timestamp: new Date().toISOString(),
            data: collectedData
          };

          try {
            addLog('上传目标: ' + apiEndpoint);

            try {
              const preflight = await fetch(apiEndpoint, {
                method: 'OPTIONS',
                headers: {
                  'Authorization': 'Bearer ' + apiToken,
                  'Content-Type': 'application/json'
                }
              });
              addLog('预检(OPTIONS)状态: ' + preflight.status);
            } catch (preflightError) {
              const name = preflightError && preflightError.name ? preflightError.name : 'Error';
              const message = preflightError && preflightError.message ? preflightError.message : String(preflightError);
              addLog('预检(OPTIONS)失败: ' + name + ': ' + message, 'error');
            }

            const uploadResponse = await fetch(apiEndpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiToken
              },
              body: JSON.stringify(payload)
            });

            if (uploadResponse.ok) {
              const resultData = await uploadResponse.json();
              updateStatus('上传成功!', 'success');
              addLog('数据已成功上传到 Lark', 'info');
            } else {
              const errorText = await uploadResponse.text();
              updateStatus('上传失败', 'error');
              addLog('上传失败: ' + uploadResponse.status, 'error');
            }
          } catch (uploadError) {
            updateStatus('上传失败', 'error');
            const name = uploadError && uploadError.name ? uploadError.name : 'Error';
            const message = uploadError && uploadError.message ? uploadError.message : String(uploadError);
            addLog('上传失败: ' + name + ': ' + message, 'error');
            addLog('排查: 确认 Vercel 已重新部署、URL 为 https 且路径是 /api/upload', 'error');
          }

          await sendToBackground({ action: 'stopCollection' });
          collectBtn.disabled = false;
        }, 10000);
      });

    } catch (error) {
      updateStatus('发生错误', 'error');
      addLog('错误: ' + error.message, 'error');
      await sendToBackground({ action: 'stopCollection' });
      collectBtn.disabled = false;
    }
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
