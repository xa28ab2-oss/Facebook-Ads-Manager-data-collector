(function() {
  const statusEl = document.getElementById('status');
  const collectBtn = document.getElementById('collectBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statsEl = document.getElementById('stats');
  const logEl = document.getElementById('log');
  const projectNameInput = document.getElementById('projectName');
  const buyerNameInput = document.getElementById('buyerName');
  const recordCountEl = document.getElementById('recordCount');
  const totalSpendEl = document.getElementById('totalSpend');
  const totalImpressionsEl = document.getElementById('totalImpressions');
  const totalClicksEl = document.getElementById('totalClicks');

  const apiEndpoint = 'https://facebook-ads-manager-data-collector.vercel.app/api/upload';

  let collectedData = [];
  let logEntries = [];
  let statusState = { message: '等待采集...', type: 'idle' };

  function updateStatus(message, type) {
    statusState = { message, type };
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;
    persistUIState();
  }

  function renderLog(entry) {
    const item = document.createElement('div');
    item.className = 'log-entry ' + entry.type;
    item.textContent = '[' + entry.time + '] ' + entry.message;
    logEl.appendChild(item);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function addLog(message, type = 'info') {
    const entry = {
      time: new Date().toLocaleTimeString(),
      message,
      type
    };
    logEntries.push(entry);
    if (logEntries.length > 200) {
      logEntries = logEntries.slice(logEntries.length - 200);
      logEl.innerHTML = '';
      for (const item of logEntries) renderLog(item);
    } else {
      renderLog(entry);
    }
    persistUIState();
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
    persistUIState();
  }

  function formatDate(value) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getYesterdayDateString() {
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return formatDate(yesterday);
  }

  function extractDateRange(record) {
    const raw = record && record.raw_fields ? record.raw_fields : {};
    return {
      date_start: record.date_start || raw.date_start || '',
      date_stop: record.date_stop || raw.date_stop || ''
    };
  }

  function getOptionsEndpoint() {
    return apiEndpoint.replace(/\/api\/upload\/?$/, '/api/options');
  }

  function setSelectOptions(selectEl, options, placeholder, selectedValue) {
    const value = selectedValue || selectEl.value || '';
    const items = Array.isArray(options) ? options.filter(Boolean) : [];
    if (value && !items.includes(value)) items.unshift(value);
    selectEl.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = placeholder;
    selectEl.appendChild(empty);
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item;
      option.textContent = item;
      selectEl.appendChild(option);
    }
    selectEl.value = value && items.includes(value) ? value : '';
  }

  async function loadOptions(selectedProject, selectedBuyer) {
    try {
      const response = await fetch(getOptionsEndpoint(), { method: 'GET' });
      if (!response.ok) {
        addLog('配置表读取失败: ' + response.status, 'error');
        return;
      }
      const data = await response.json();
      const projects = data && Array.isArray(data.projects) ? data.projects : [];
      const buyers = data && Array.isArray(data.buyers) ? data.buyers : [];
      setSelectOptions(projectNameInput, projects, '请选择项目', selectedProject);
      setSelectOptions(buyerNameInput, buyers, '请选择投手', selectedBuyer);
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      addLog('配置表读取失败: ' + message, 'error');
    }
  }

  function persistUIState() {
    chrome.storage.local.set({
      uiState: {
        status: statusState,
        logs: logEntries,
        stats: {
          visible: statsEl.style.display !== 'none',
          recordCount: recordCountEl.textContent,
          totalSpend: totalSpendEl.textContent,
          totalImpressions: totalImpressionsEl.textContent,
          totalClicks: totalClicksEl.textContent
        }
      }
    });
  }

  function loadSettings() {
    chrome.storage.local.get(['projectName', 'buyerName', 'uiState'], function(result) {
      const savedProject = result.projectName || '';
      const savedBuyer = result.buyerName || '';
      if (savedProject) projectNameInput.value = savedProject;
      if (savedBuyer) buyerNameInput.value = savedBuyer;
      loadOptions(savedProject, savedBuyer);
      if (result.uiState) {
        const uiState = result.uiState;
        if (uiState.status) {
          statusState = uiState.status;
          statusEl.textContent = statusState.message || '等待采集...';
          statusEl.className = 'status ' + (statusState.type || 'idle');
        }
        if (Array.isArray(uiState.logs)) {
          logEntries = uiState.logs;
          logEl.innerHTML = '';
          for (const item of logEntries) renderLog(item);
        }
        if (uiState.stats) {
          const stats = uiState.stats;
          statsEl.style.display = stats.visible ? 'block' : 'none';
          if (stats.recordCount != null) recordCountEl.textContent = stats.recordCount;
          if (stats.totalSpend != null) totalSpendEl.textContent = stats.totalSpend;
          if (stats.totalImpressions != null) totalImpressionsEl.textContent = stats.totalImpressions;
          if (stats.totalClicks != null) totalClicksEl.textContent = stats.totalClicks;
        }
      }
    });
  }

  function saveSettings() {
    chrome.storage.local.set({
      projectName: projectNameInput.value,
      buyerName: buyerNameInput.value
    });
  }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ success: false, error: 'background timeout' });
      }, 8000);
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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

  function ensureContentScript(tabId) {
    return new Promise((resolve) => {
      try {
        chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
          resolve(!chrome.runtime.lastError);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  collectBtn.addEventListener('click', async function() {
    const projectName = projectNameInput.value.trim();
    const buyerName = buyerNameInput.value.trim();

    saveSettings();

    updateStatus('正在采集数据...', 'collecting');
    collectBtn.disabled = true;
    addLog('开始采集广告数据...');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      addLog('标签页 ID: ' + tab.id);
      if (tab && tab.url) addLog('标签页 URL: ' + tab.url);

      const ping = await sendToBackground({ action: 'ping' });
      if (!ping || !ping.success) {
        addLog('后台未响应，尝试继续启动采集', 'error');
      }

      const startResp = await sendToBackground({ action: 'startCollection', tabId: tab.id });
      if (!startResp || !startResp.success) {
        updateStatus('采集启动失败', 'error');
        addLog('采集启动失败: ' + ((startResp && startResp.error) || 'unknown'), 'error');
        if (startResp && startResp.error === 'background timeout') {
          addLog('后台未响应，正在重新加载扩展，请重新打开弹窗再试', 'error');
          chrome.runtime.reload();
        }
        collectBtn.disabled = false;
        return;
      }

      addLog('点击刷新按钮...');
      let ready = false;
      for (let i = 0; i < 12; i++) {
        const statusResp = await sendToBackground({ action: 'getStatus' });
        if (statusResp && statusResp.ready) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) {
        addLog('采集尚未完全就绪，继续尝试刷新', 'error');
      }

      const proceedAfterRefresh = function() {
        addLog('等待 10 秒采集数据...');
        setTimeout(async function() {
          addLog('正在获取采集结果...');

          const response = await sendToBackground({ action: 'getData' });
          collectedData = (response && response.data) || [];
          addLog('采集到 ' + collectedData.length + ' 条记录');

          try {
            if (response && response.meta) {
              if (response.meta.atomic_columns) {
                addLog('采集列(atomic_columns): ' + JSON.stringify(response.meta.atomic_columns));
              }
              if (response.meta.dimensions) {
                addLog('采集列(dimensions): ' + JSON.stringify(response.meta.dimensions));
              }
              if (typeof response.meta.name_cache_size === 'number') {
                addLog('名称缓存命中: ' + response.meta.name_cache_size);
              }
              if (response.meta.name_sample) {
                addLog('名称缓存样例: ' + JSON.stringify(response.meta.name_sample));
              }
              if (typeof response.meta.capture_count === 'number') {
                addLog('响应捕获数: ' + response.meta.capture_count);
              }
              if (typeof response.meta.parsed_count === 'number') {
                addLog('解析成功数: ' + response.meta.parsed_count);
              }
              if (typeof response.meta.dataset_row_count === 'number') {
                addLog('返回行数: ' + response.meta.dataset_row_count);
              }
              if (typeof response.meta.record_candidate_count === 'number') {
                addLog('候选记录数: ' + response.meta.record_candidate_count);
              }
              if (typeof response.meta.record_kept_count === 'number') {
                addLog('保留记录数: ' + response.meta.record_kept_count);
              }
            }
          } catch (e) {}

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

          const expectedDate = getYesterdayDateString();
          const invalidRecord = collectedData.find((record) => {
            const range = extractDateRange(record);
            return range.date_start !== expectedDate || range.date_stop !== expectedDate;
          });
          if (invalidRecord) {
            const range = extractDateRange(invalidRecord);
            updateStatus('日期不符合要求，已停止上传', 'error');
            addLog(`日期校验失败: 需要 ${expectedDate}，实际 ${range.date_start || '-'} ~ ${range.date_stop || '-'}`, 'error');
            await sendToBackground({ action: 'stopCollection' });
            collectBtn.disabled = false;
            return;
          }

          try {
            const sample = collectedData.slice(0, 3);
            addLog('采集数据(前3条): ' + JSON.stringify(sample));
          } catch (e) {}

          updateStats(collectedData);
          updateStatus('正在上传数据...', 'collecting');

          const collectedAt = Date.now();
          const collectedAtMinute = Math.floor(collectedAt / 60000) * 60000;
          const payload = {
            operator: 'unknown',
            project_name: projectName || '',
            buyer_name: buyerName || '',
            timestamp: collectedAtMinute,
            data: collectedData
          };

          try {
            addLog('上传目标: ' + apiEndpoint);

            try {
              const preflight = await fetch(apiEndpoint, {
                method: 'OPTIONS',
              headers: {
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
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(payload)
            });

            if (uploadResponse.ok) {
              const resultData = await uploadResponse.json();
              const uploaded = resultData && typeof resultData.uploaded === 'number' ? resultData.uploaded : null;
              const failed = resultData && typeof resultData.failed === 'number' ? resultData.failed : null;
              const errors = resultData && Array.isArray(resultData.errors) ? resultData.errors : null;

              if (uploaded === 0 && failed && failed > 0) {
                updateStatus('上传完成(有错误)', 'error');
                addLog('上传结果: 成功 0 条，失败 ' + failed + ' 条', 'error');
              } else {
                updateStatus('上传成功!', 'success');
                if (uploaded != null && failed != null) {
                  addLog('上传结果: 成功 ' + uploaded + ' 条，失败 ' + failed + ' 条', 'info');
                } else {
                  addLog('数据已成功上传到 Lark', 'info');
                }
              }

              if (errors && errors.length > 0) {
                addLog('写入失败明细(前3条): ' + JSON.stringify(errors.slice(0, 3)), 'error');
              }
            } else {
              const errorText = await uploadResponse.text();
              updateStatus('上传失败', 'error');
              addLog('上传失败: ' + uploadResponse.status, 'error');
              if (errorText) addLog('服务端返回: ' + errorText, 'error');
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
      };

      findAndClickRefreshButton(tab.id, async function(success, error) {
        if (success) {
          addLog('刷新按钮已点击');
          proceedAfterRefresh();
          return;
        }

        const errText = String(error || '');
        if (errText.includes('Receiving end does not exist')) {
          addLog('点击刷新按钮失败: ' + error, 'error');
          addLog('检测到内容脚本未连接，尝试注入...', 'error');
          const injected = await ensureContentScript(tab.id);
          if (injected) {
            addLog('内容脚本已注入，重试点击刷新...');
            findAndClickRefreshButton(tab.id, function(success2, error2) {
              if (success2) {
                addLog('刷新按钮已点击');
              } else {
                addLog('点击刷新按钮失败: ' + (error2 || 'unknown'), 'error');
              }
              proceedAfterRefresh();
            });
          } else {
            addLog('注入失败：请重新加载插件并刷新 Ads Manager 页面', 'error');
            proceedAfterRefresh();
          }
          return;
        }

        addLog('点击刷新按钮失败: ' + error, 'error');
        proceedAfterRefresh();
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
    logEntries = [];
    addLog('日志已清空', 'info');
    persistUIState();
  });

  projectNameInput.addEventListener('change', saveSettings);
  buyerNameInput.addEventListener('change', saveSettings);

  loadSettings();
  addLog('插件已就绪，请在 Facebook Ads Manager 页面使用', 'info');
})();
