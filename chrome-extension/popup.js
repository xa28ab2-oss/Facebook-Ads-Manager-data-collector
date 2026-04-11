(function() {
  const collectBtn = document.getElementById('collectBtn');
  const statusNoteEl = document.getElementById('statusNote');
  const logEl = document.getElementById('log');
  const logListEl = document.getElementById('logList');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const projectNameInput = document.getElementById('projectName');
  const buyerNameInput = document.getElementById('buyerName');
  const uploadModeInput = document.getElementById('uploadMode');
  const refreshOptionsBtn = document.getElementById('refreshOptionsBtn');

  const apiEndpoint = 'https://facebook-ads-manager-data-collector.vercel.app/api/upload';
  const defaultCollectText = '开始采集数据';

  let collectedData = [];
  let logEntries = [];
  let statusHistoryEntries = [];
  let lastConsumedUploadResultAt = 0;
  let statusState = { message: defaultCollectText, type: 'idle' };
  let statusResetTimer = null;

  function clearStatusResetTimer() {
    if (!statusResetTimer) return;
    clearTimeout(statusResetTimer);
    statusResetTimer = null;
  }

  function getTimeLabel() {
    return new Date().toLocaleString('zh-CN', { hour12: false });
  }

  function renderStatusHistory() {
    if (!logListEl) return;
    logListEl.innerHTML = '';
    for (let i = statusHistoryEntries.length - 1; i >= 0; i--) {
      const entry = statusHistoryEntries[i];
      const item = document.createElement('div');
      item.className = 'log-entry ' + entry.type;
      item.textContent = '[' + entry.time + '] ' + entry.message;
      logListEl.appendChild(item);
    }
    logListEl.scrollTop = 0;
  }

  function setStatusNote(message, type, recordHistory = true) {
    if (!statusNoteEl || !message) return;
    const time = getTimeLabel();
    statusNoteEl.textContent = '[' + time + '] ' + message;
    statusNoteEl.title = '点击查看历史记录';
    statusNoteEl.className = 'status-note ' + type;
    if (recordHistory) {
      statusHistoryEntries.push({ time, message, type });
      if (statusHistoryEntries.length > 100) {
        statusHistoryEntries = statusHistoryEntries.slice(statusHistoryEntries.length - 100);
      }
      if (logEl.style.display !== 'none') {
        renderStatusHistory();
      }
    }
  }

  function updateStatus(message, type, noteMessage, shouldPersist = true) {
    statusState = { message, type };
    clearStatusResetTimer();
    const buttonText = type === 'idle' ? defaultCollectText : message;
    collectBtn.textContent = buttonText;
    collectBtn.classList.remove('state-idle', 'state-collecting', 'state-success', 'state-error');
    collectBtn.classList.add('state-' + type);
    if (type === 'success' || type === 'error') {
      setStatusNote(noteMessage || message, type, true);
    }
    if (type === 'success' || type === 'error') {
      collectBtn.disabled = true;
      statusResetTimer = setTimeout(() => {
        updateStatus(defaultCollectText, 'idle');
        collectBtn.disabled = false;
      }, 3000);
    }
    if (shouldPersist) {
      persistUIState();
    }
  }

  function addLog(message, type = 'info', shouldPersist = true) {
    const entry = {
      time: new Date().toLocaleTimeString(),
      message,
      type
    };
    logEntries.push(entry);
    if (logEntries.length > 200) {
      logEntries = logEntries.slice(logEntries.length - 200);
    }
    if (shouldPersist) {
      persistUIState();
    }
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

  function getTodayDateString() {
    return formatDate(new Date());
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

  function validateSelections(projectName, buyerName) {
    if (!projectName || !buyerName) {
      updateStatus('请选择项目和投手', 'error', '请先选择项目和投手');
      addLog('未选择项目或投手，已停止上传', 'error');
      return false;
    }
    return true;
  }

  function setSelectOptions(selectEl, options, placeholder, selectedValue) {
    const value = selectedValue || selectEl.value || '';
    const blockedLabels = new Set(['请选择项目', '请选择项目名称', '请选择投手', '请选择投手名称']);
    const items = Array.isArray(options)
      ? options
          .map((item) => (item == null ? '' : String(item).trim()))
          .filter((item) => item && !blockedLabels.has(item))
      : [];
    selectEl.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = placeholder;
    empty.disabled = true;
    empty.hidden = true;
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
    let loadFailed = false;
    try {
      updateStatus('插件加载中...', 'collecting');
      collectBtn.disabled = true;
      const response = await fetch(getOptionsEndpoint(), { method: 'GET' });
      if (!response.ok) {
        loadFailed = true;
        updateStatus('配置表读取失败', 'error', '配置表读取失败: HTTP ' + response.status);
        addLog('配置表读取失败: ' + response.status, 'error');
        return;
      }
      const data = await response.json();
      const projects = data && Array.isArray(data.projects) ? data.projects : [];
      const buyers = data && Array.isArray(data.buyers) ? data.buyers : [];
      setSelectOptions(projectNameInput, projects, '请选择项目', selectedProject);
      setSelectOptions(buyerNameInput, buyers, '请选择投手', selectedBuyer);
      if (selectedProject && !projects.includes(selectedProject)) projectNameInput.value = '';
      if (selectedBuyer && !buyers.includes(selectedBuyer)) buyerNameInput.value = '';
      chrome.storage.local.set({
        optionsCache: {
          date: getTodayDateString(),
          projects,
          buyers
        }
      });
      saveSettings();
    } catch (e) {
      loadFailed = true;
      const message = e && e.message ? e.message : String(e);
      updateStatus('配置表读取失败', 'error', '配置表读取失败: ' + message);
      addLog('配置表读取失败: ' + message, 'error');
    } finally {
      if (!loadFailed) updateStatus('等待采集...', 'idle');
      if (statusState.type !== 'success' && statusState.type !== 'error') collectBtn.disabled = false;
    }
  }

  function persistUIState() {
    chrome.storage.local.set({
      uiState: {
        status: statusState,
        logs: logEntries,
        statusHistory: statusHistoryEntries,
        lastConsumedUploadResultAt,
        logVisible: logEl.style.display !== 'none',
        statusNote: statusNoteEl ? statusNoteEl.textContent : '',
        statusNoteType: statusNoteEl && statusNoteEl.classList.contains('error') ? 'error' :
          statusNoteEl && statusNoteEl.classList.contains('success') ? 'success' : ''
      }
    });
  }

  function loadSettings() {
    chrome.storage.local.get(['projectName', 'buyerName', 'uploadMode', 'uiState', 'optionsCache'], function(result) {
      const savedProject = result.projectName || '';
      const savedBuyer = result.buyerName || '';
      const savedUploadMode = result.uploadMode || '当日消耗';
      if (savedProject) projectNameInput.value = savedProject;
      if (savedBuyer) buyerNameInput.value = savedBuyer;
      if (uploadModeInput) uploadModeInput.value = savedUploadMode;
      if (result.uiState) {
        const uiState = result.uiState;
        if (Array.isArray(uiState.logs)) {
          logEntries = uiState.logs;
        }
        if (Array.isArray(uiState.statusHistory)) {
          statusHistoryEntries = uiState.statusHistory;
        }
        if (typeof uiState.lastConsumedUploadResultAt === 'number') {
          lastConsumedUploadResultAt = uiState.lastConsumedUploadResultAt;
        }
        if (statusNoteEl && typeof uiState.statusNote === 'string') {
          statusNoteEl.textContent = uiState.statusNote;
          statusNoteEl.title = uiState.statusNote ? '点击查看历史记录' : '';
          statusNoteEl.className = 'status-note' + (uiState.statusNoteType ? ' ' + uiState.statusNoteType : '');
        }
        renderStatusHistory();
        if (typeof uiState.logVisible === 'boolean') {
          logEl.style.display = uiState.logVisible ? 'block' : 'none';
        } else {
          logEl.style.display = 'none';
        }
      }
      updateStatus(defaultCollectText, 'idle', null, false);
      collectBtn.disabled = false;
      const optionsCache = result.optionsCache;
      const cacheProjects = optionsCache && Array.isArray(optionsCache.projects) ? optionsCache.projects : null;
      const cacheBuyers = optionsCache && Array.isArray(optionsCache.buyers) ? optionsCache.buyers : null;
      const isTodayCache = optionsCache && optionsCache.date === getTodayDateString();
      if (isTodayCache && cacheProjects && cacheBuyers) {
        setSelectOptions(projectNameInput, cacheProjects, '请选择项目', savedProject);
        setSelectOptions(buyerNameInput, cacheBuyers, '请选择投手', savedBuyer);
        if (savedProject && !cacheProjects.includes(savedProject)) projectNameInput.value = '';
        if (savedBuyer && !cacheBuyers.includes(savedBuyer)) buyerNameInput.value = '';
        saveSettings();
      } else {
        loadOptions(savedProject, savedBuyer);
      }
    });
  }

  function saveSettings() {
    chrome.storage.local.set({
      projectName: projectNameInput.value,
      buyerName: buyerNameInput.value,
      uploadMode: uploadModeInput ? uploadModeInput.value : '当日消耗'
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

  function applyUploadTaskResult(result) {
    if (!result || !result.type) return;
    if (result.at && typeof result.at === 'number') {
      lastConsumedUploadResultAt = result.at;
    }
    if (result.type === 'success') {
      updateStatus('上传成功!', 'success', result.message || '上传成功');
      return;
    }
    updateStatus('上传失败', 'error', result.message || '上传失败');
  }

  async function pollUploadTaskResult(maxRound = 30) {
    for (let i = 0; i < maxRound; i++) {
      const stateResp = await sendToBackground({ action: 'getUploadTaskState' });
      if (stateResp && stateResp.success) {
        if (stateResp.result && !stateResp.running) {
          applyUploadTaskResult(stateResp.result);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  async function syncUploadTaskStateFromBackground() {
    const stateResp = await sendToBackground({ action: 'getUploadTaskState' });
    if (!stateResp || !stateResp.success) return;
    if (stateResp.running) {
      updateStatus('正在后台上传数据...', 'collecting', null, false);
      collectBtn.disabled = true;
      await pollUploadTaskResult(120);
      return;
    }
    if (stateResp.result && stateResp.result.at && stateResp.result.at !== lastConsumedUploadResultAt) {
      setStatusNote(stateResp.result.message || (stateResp.result.type === 'success' ? '上传成功' : '上传失败'), stateResp.result.type, true);
      lastConsumedUploadResultAt = stateResp.result.at;
      persistUIState();
      sendToBackground({ action: 'clearUploadTaskResult' });
    }
    updateStatus(defaultCollectText, 'idle', null, false);
    collectBtn.disabled = false;
  }

  collectBtn.addEventListener('click', async function() {
    const projectName = projectNameInput.value.trim();
    const buyerName = buyerNameInput.value.trim();
    const uploadMode = uploadModeInput ? String(uploadModeInput.value || '当日消耗').trim() : '当日消耗';
    if (!validateSelections(projectName, buyerName)) return;

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
        updateStatus('采集启动失败', 'error', '采集启动失败: ' + ((startResp && startResp.error) || 'unknown'));
        addLog('采集启动失败: ' + ((startResp && startResp.error) || 'unknown'), 'error');
        if (startResp && startResp.error === 'background timeout') {
          addLog('后台未响应，正在重新加载扩展，请重新打开弹窗再试', 'error');
          chrome.runtime.reload();
        }
        if (statusState.type !== 'success' && statusState.type !== 'error') collectBtn.disabled = false;
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

      const proceedAfterRefresh = async function() {
        addLog('等待 5 秒采集数据...');
        updateStatus('正在后台上传数据...', 'collecting');
        const triggerResp = await sendToBackground({
          action: 'finalizeCollectionUpload',
          project_name: projectName || '',
          buyer_name: buyerName || '',
          upload_mode: uploadMode || '当日消耗',
          api_endpoint: apiEndpoint
        });
        if (!triggerResp || !triggerResp.success) {
          updateStatus('上传失败', 'error', '上传失败: ' + ((triggerResp && triggerResp.error) || 'unknown'));
          return;
        }
        await pollUploadTaskResult();
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
      updateStatus('发生错误', 'error', '采集失败: ' + error.message);
      addLog('错误: ' + error.message, 'error');
      await sendToBackground({ action: 'stopCollection' });
      if (statusState.type !== 'success' && statusState.type !== 'error') collectBtn.disabled = false;
    }
  });

  if (projectNameInput) {
    projectNameInput.addEventListener('change', saveSettings);
  }
  if (buyerNameInput) {
    buyerNameInput.addEventListener('change', saveSettings);
  }
  if (uploadModeInput) {
    uploadModeInput.addEventListener('change', saveSettings);
  }
  if (refreshOptionsBtn) {
    refreshOptionsBtn.addEventListener('click', function() {
      const selectedProject = projectNameInput.value || '';
      const selectedBuyer = buyerNameInput.value || '';
      addLog('手动刷新下拉选项...');
      loadOptions(selectedProject, selectedBuyer);
    });
  }
  if (statusNoteEl && logEl) {
    statusNoteEl.addEventListener('click', function() {
      if (!statusNoteEl.textContent) return;
      const isVisible = logEl.style.display !== 'none';
      logEl.style.display = isVisible ? 'none' : 'block';
      if (!isVisible) {
        renderStatusHistory();
      }
      persistUIState();
    });
  }
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', function() {
      statusHistoryEntries = [];
      renderStatusHistory();
      persistUIState();
    });
  }
  logEl.style.display = 'none';

  loadSettings();
  syncUploadTaskStateFromBackground();
  addLog('插件已就绪，请在广告平台报表页面使用', 'info', false);
})();
