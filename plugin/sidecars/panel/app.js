(() => {
  'use strict';

  const sidecar = window.sidecar;
  const $ = (id) => document.getElementById(id);

  let currentMode = 'all'; // 'all' | 'tools' | 'errors'
  let traceSearchQuery = '';
  let lastTelemetryData = null;
  let toastTimer = null;
  let selectedConversationId = 'auto'; // 'auto' or explicit uuid
  let lastSessionsSignature = '';
  let lastTelemetrySignature = '';
  const expandedStepIndices = new Set();
  let isMonitoring = true;
  let monitorInterval = null;

  function showToast(msg) {
    const toast = $('toast');
    const toastMsg = $('toast-msg');
    toastMsg.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 2400);
  }

  function formatTokens(num) {
    if (!num || isNaN(num)) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return String(num);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Tool classification for the segmented spectrum
  function getToolCategory(toolName) {
    if (['replace_file_content', 'write_to_file'].includes(toolName)) {
      return { id: 'file', label: 'File Edits', color: '#3b82f6', cls: 'segment-file' };
    }
    if (['run_command'].includes(toolName)) {
      return { id: 'shell', label: 'Shell / Terminal', color: '#8b5cf6', cls: 'segment-shell' };
    }
    if (['view_file', 'read_url_content', 'read_resource', 'search_web'].includes(toolName)) {
      return { id: 'read', label: 'Read / Search', color: '#10b981', cls: 'segment-read' };
    }
    if (['invoke_subagent', 'send_message', 'manage_subagents'].includes(toolName)) {
      return { id: 'agent', label: 'Subagents', color: '#f59e0b', cls: 'segment-agent' };
    }
    return { id: 'other', label: 'Other Tools', color: '#64748b', cls: 'segment-other' };
  }

  async function sendSteerMessage(text) {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (!sidecar || !sidecar.agent) {
      showToast('Cannot steer: Agent API unavailable');
      return;
    }

    const targetConvId = (selectedConversationId !== 'auto' && selectedConversationId)
      ? selectedConversationId
      : (lastTelemetryData?.conversationId || sidecar.conversationId);

    if (!targetConvId) {
      showToast('Cannot steer: No active conversation');
      return;
    }

    try {
      await sidecar.agent.sendMessage(trimmed, targetConvId);
      showToast('Instruction dispatched to agent');
      $('steer-input').value = '';
    } catch (err) {
      showToast(`Failed to dispatch: ${err.message}`);
    }
  }

  function renderToolSpectrum(toolCounts = {}) {
    const barEl = $('spectrum-bar');
    const legendEl = $('spectrum-legend');
    const totalEl = $('spectrum-total');

    const entries = Object.entries(toolCounts);
    const totalCalls = entries.reduce((sum, [, count]) => sum + count, 0);
    totalEl.textContent = `${totalCalls} calls`;

    if (totalCalls === 0) {
      barEl.innerHTML = '<div style="width: 100%; height: 100%; background: var(--secondary);"></div>';
      legendEl.innerHTML = '<span style="color: var(--muted-foreground); font-size: 10px;">No tools recorded yet</span>';
      return;
    }

    const categories = {};
    for (const [name, count] of entries) {
      const cat = getToolCategory(name);
      if (!categories[cat.id]) {
        categories[cat.id] = { ...cat, count: 0, tools: [] };
      }
      categories[cat.id].count += count;
      categories[cat.id].tools.push({ name, count });
    }

    const segmentsHtml = Object.values(categories).map(cat => {
      const pct = ((cat.count / totalCalls) * 100).toFixed(1);
      return `<div class="segment ${cat.cls}" style="width: ${pct}%;" title="${cat.label}: ${cat.count} (${pct}%)"></div>`;
    }).join('');
    barEl.innerHTML = segmentsHtml;

    const legendHtml = Object.values(categories).map(cat => {
      const pct = Math.round((cat.count / totalCalls) * 100);
      return `
        <div class="legend-item" title="${cat.tools.map(t => `${t.name} (${t.count})`).join(', ')}">
          <span class="legend-dot" style="background: ${cat.color};"></span>
          <span>${cat.label}</span>
          <span class="tabular mono" style="color: var(--muted-foreground); font-size: 9.5px;">${pct}%</span>
        </div>
      `;
    }).join('');
    legendEl.innerHTML = legendHtml;
  }

  // Render vertical waterfall traces preserving expanded node drawer states
  function renderWaterfall() {
    if (!lastTelemetryData) return;
    const feedEl = $('waterfall-feed');
    let items = lastTelemetryData.recentSteps || [];

    if (currentMode === 'errors') {
      items = lastTelemetryData.failedSteps || [];
    } else if (currentMode === 'tools') {
      items = items.filter(s => s.tools && s.tools.length > 0);
    }

    if (traceSearchQuery) {
      const q = traceSearchQuery.toLowerCase();
      items = items.filter(s => {
        if (String(s.stepIndex).includes(q)) return true;
        if (s.category && s.category.toLowerCase().includes(q)) return true;
        if (s.tools && s.tools.some(t =>
          t.name.toLowerCase().includes(q) ||
          (t.primaryArg && t.primaryArg.toLowerCase().includes(q)) ||
          (t.summary && t.summary.toLowerCase().includes(q)) ||
          (t.action && t.action.toLowerCase().includes(q))
        )) return true;
        if (s.thinking && s.thinking.toLowerCase().includes(q)) return true;
        if (s.userPrompt && s.userPrompt.toLowerCase().includes(q)) return true;
        if (s.outputSnippet && s.outputSnippet.toLowerCase().includes(q)) return true;
        if (s.content && s.content.toLowerCase().includes(q)) return true;
        return false;
      });
    }

    const totalAvailable = (lastTelemetryData.recentSteps || []).length;
    const countLabel = $('traces-count-label');
    if (countLabel) {
      countLabel.textContent = `${items.length} / ${totalAvailable}`;
    }

    if (items.length === 0) {
      feedEl.innerHTML = currentMode === 'errors'
        ? '<div class="empty-state">No errors recorded in this trace.</div>'
        : (traceSearchQuery ? '<div class="empty-state">No traces match your search filter.</div>' : '<div class="empty-state">Waiting for agent activity...</div>');
      return;
    }

    feedEl.innerHTML = items.map((s) => {
      const isErr = s.status === 'ERROR';
      const isExpanded = expandedStepIndices.has(s.stepIndex);
      let toolHtml = '';
      let drawerHtml = '';

      if (s.tools && s.tools.length > 0) {
        toolHtml = s.tools.map(t => `
          <span class="tool-name-tag mono">${escapeHtml(t.name)}</span>
          ${t.primaryArg ? `<span class="primary-arg mono" title="${escapeHtml(t.primaryArg)}">${escapeHtml(t.primaryArg)}</span>` : ''}
          <span class="node-summary">${escapeHtml(t.summary || t.action || '')}</span>
        `).join('');

        const reasoningBlock = s.thinking ? `
          <div class="drawer-section reasoning-section">
            <div class="drawer-section-title">
              <span>Reasoning & Strategy</span>
            </div>
            <div class="reasoning-text">${escapeHtml(s.thinking)}</div>
          </div>
        ` : '';

        const argsBlocks = s.tools.map(t => {
          const argEntries = Object.entries(t.args || {});
          if (argEntries.length === 0) return '';
          return `
            <div class="drawer-section">
              <div class="drawer-section-title">
                <span>Arguments: ${escapeHtml(t.name)}</span>
                ${t.action ? `<span style="font-weight: 400; text-transform: none; color: var(--muted-foreground);">${escapeHtml(t.action)}</span>` : ''}
              </div>
              <div class="args-grid mono">
                ${argEntries.map(([k, v]) => `
                  <div class="arg-row">
                    <span class="arg-key">${escapeHtml(k)}:</span>
                    <span class="arg-val">${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          `;
        }).join('');

        const outputBlock = s.outputSnippet ? `
          <div class="drawer-section output-section">
            <div class="drawer-section-title">
              <span>Execution Output / Result</span>
              <button class="btn-copy-mini" type="button" data-copy="${escapeHtml(s.outputSnippet)}" title="Copy output snippet">Copy</button>
            </div>
            <pre class="output-preview mono ${isErr ? 'has-error' : ''}">${escapeHtml(s.outputSnippet)}</pre>
          </div>
        ` : '';

        const footerMetrics = `
          <div class="drawer-footer-metrics mono">
            <span>Tokens: In ${formatTokens(s.inputTokens)} · Cache ${formatTokens(s.cacheReadTokens || 0)} · Out ${formatTokens(s.outputTokens)}</span>
            <span>Est. Cost: ${s.stepCost || '$0.0000'}</span>
            <span>Duration: +${s.durationSeconds || 0}s</span>
            <span>Time: ${escapeHtml(s.createdAt ? new Date(s.createdAt).toLocaleTimeString() : 'N/A')}</span>
          </div>
        `;

        drawerHtml = `
          <div class="node-drawer">
            ${reasoningBlock}
            ${argsBlocks}
            ${outputBlock}
            ${footerMetrics}
          </div>
        `;
      } else if (s.category === 'user' || s.type === 'USER_INPUT') {
        toolHtml = `
          <span class="tool-name-tag mono" style="color: #4ade80;">User Request</span>
          <span class="node-summary">${escapeHtml(s.userPrompt || s.content || '')}</span>
        `;
        drawerHtml = `
          <div class="node-drawer">
            <div class="drawer-section">
              <div class="drawer-section-title">User Prompt</div>
              <pre class="output-preview mono" style="color: var(--foreground);">${escapeHtml(s.content || s.userPrompt || '')}</pre>
            </div>
            <div class="drawer-footer-metrics mono">
              <span>Time: ${escapeHtml(s.createdAt ? new Date(s.createdAt).toLocaleTimeString() : 'N/A')}</span>
            </div>
          </div>
        `;
      } else if (s.category === 'assistant' || (s.source === 'MODEL' && s.type === 'PLANNER_RESPONSE')) {
        toolHtml = `
          <span class="tool-name-tag mono" style="color: #22d3ee;">Assistant Response</span>
          <span class="node-summary">${escapeHtml((s.content || '').slice(0, 100))}</span>
        `;
        drawerHtml = `
          <div class="node-drawer">
            ${s.thinking ? `
              <div class="drawer-section reasoning-section">
                <div class="drawer-section-title">Thinking</div>
                <div class="reasoning-text">${escapeHtml(s.thinking)}</div>
              </div>
            ` : ''}
            ${s.content ? `
              <div class="drawer-section">
                <div class="drawer-section-title">Response Content</div>
                <pre class="output-preview mono" style="color: var(--foreground);">${escapeHtml(s.content)}</pre>
              </div>
            ` : ''}
            <div class="drawer-footer-metrics mono">
              <span>Tokens: In ${formatTokens(s.inputTokens)} · Cache ${formatTokens(s.cacheReadTokens || 0)} · Out ${formatTokens(s.outputTokens)}</span>
              <span>Time: ${escapeHtml(s.createdAt ? new Date(s.createdAt).toLocaleTimeString() : 'N/A')}</span>
            </div>
          </div>
        `;
      } else {
        toolHtml = `<span class="node-summary" style="color: var(--secondary-foreground);">${escapeHtml(s.source)} · ${escapeHtml(s.type)}: ${escapeHtml((s.content || '').slice(0, 80))}</span>`;
        if (s.content) {
          drawerHtml = `
            <div class="node-drawer">
              <div class="drawer-section output-section">
                <div class="drawer-section-title">Content</div>
                <pre class="output-preview mono">${escapeHtml(s.content)}</pre>
              </div>
            </div>
          `;
        }
      }

      const durationHtml = s.durationSeconds > 0
        ? `<span class="duration-chip tabular mono">+${s.durationSeconds}s</span>`
        : '';

      const tokenChip = s.totalStepTokens > 0
        ? `<span class="step-tokens-tag tabular mono" title="In: ${formatTokens(s.inputTokens)} | Cache: ${formatTokens(s.cacheReadTokens || 0)} | Out: ${formatTokens(s.outputTokens)}">${formatTokens(s.totalStepTokens)} tok</span>`
        : '';

      const categoryPill = `<span class="category-pill category-${s.category || 'system'}">${escapeHtml((s.category || 'step').toUpperCase())}</span>`;

      return `
        <div class="waterfall-node ${isErr ? 'error' : ''} ${isExpanded ? 'expanded' : ''}" data-step="${s.stepIndex}">
          <div class="waterfall-bullet"></div>
          <div class="node-card">
            <div class="node-header">
              <div style="display: flex; align-items: center; gap: 5px;">
                <span class="node-step-tag tabular mono">#${s.stepIndex}</span>
                ${categoryPill}
              </div>
              <div class="node-timing">
                ${tokenChip}
                ${durationHtml}
                <span class="status-badge ${isErr ? 'has-errors' : ''}" style="font-size: 8.5px; padding: 1px 4px;">
                  ${escapeHtml(s.status)}
                </span>
              </div>
            </div>
            <div class="node-body">
              ${toolHtml}
            </div>
            ${drawerHtml}
          </div>
        </div>
      `;
    }).join('');
  }

  // Render Files list with event delegation
  function renderFiles(files = []) {
    const listEl = $('files-list');
    const countBadge = $('tab-files-badge');
    const summaryCount = $('files-summary-count');

    countBadge.textContent = files.length;
    summaryCount.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;

    if (files.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No files written or edited in this session yet.</div>';
      return;
    }

    listEl.innerHTML = files.map(filePath => {
      const parts = filePath.split(/[\\/]/);
      const basename = parts[parts.length - 1] || filePath;
      return `
        <div class="file-item">
          <div class="file-info">
            <svg class="icon file-icon" aria-hidden="true" viewBox="0 0 24 24">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
              <polyline points="13 2 13 9 20 9"/>
            </svg>
            <div style="overflow: hidden;">
              <div class="file-name" title="${escapeHtml(filePath)}">${escapeHtml(basename)}</div>
              <div class="file-path mono" title="${escapeHtml(filePath)}">${escapeHtml(filePath)}</div>
            </div>
          </div>
          <button class="btn-copy-path mono" type="button" data-path="${escapeHtml(filePath)}" title="Copy full path">
            Copy
          </button>
        </div>
      `;
    }).join('');
  }

  // Export Session Report as Markdown
  function copySessionReport() {
    if (!lastTelemetryData) {
      showToast('No telemetry data available');
      return;
    }

    const d = lastTelemetryData;
    const toolLines = Object.entries(d.toolCounts || {})
      .map(([tool, count]) => `  - \`${tool}\`: ${count}`)
      .join('\n');

    const fileLines = (d.filesTouched || [])
      .map(f => `  - \`${f}\``)
      .join('\n') || '  *(None)*';

    const report = `# Antigravity Session Trace Report
- **Session**: ${d.activeTitle || d.conversationId || 'N/A'}
- **Conversation ID**: \`${d.conversationId || 'N/A'}\`
- **Total Steps**: ${d.totalSteps || 0}
- **Estimated Cost**: ${d.estimatedCost || '$0.0000'}
- **Tokens**: Total: ${formatTokens(d.totalTokens)} (In: ${formatTokens(d.totalPromptTokens || d.inputTokens)}, Out: ${formatTokens(d.outputTokens)}, Cache: ${d.cacheHitRate})
- **Errors**: ${d.errorCount || 0}

### Tools Executed:
${toolLines || '  *(None)*'}

### Modified Files:
${fileLines}
`;

    navigator.clipboard.writeText(report).then(() => {
      showToast('Trace report copied to clipboard!');
    }).catch(() => {
      showToast('Clipboard access failed');
    });
  }

  // Update session dropdown only when session list actually changed
  function updateSessionDropdown(sessions = [], activeTitle = '') {
    if (!Array.isArray(sessions) || sessions.length === 0) return;

    const signature = sessions.map(s => `${s.id}:${s.stepCount}`).join(',') + `|${activeTitle}|${selectedConversationId}`;
    if (signature === lastSessionsSignature) {
      return; // Sessions unchanged, prevent dropdown DOM reset
    }
    lastSessionsSignature = signature;

    const select = $('session-select');
    const currentVal = selectedConversationId;

    const autoLabel = activeTitle ? `🟢 Auto (${activeTitle.slice(0, 24)})` : '🟢 Auto (Active Chat)';
    let optionsHtml = `<option value="auto" ${currentVal === 'auto' ? 'selected' : ''}>${escapeHtml(autoLabel)}</option>`;

    for (const s of sessions) {
      const isSelected = currentVal === s.id;
      const titleText = s.title || `Chat ${s.id.slice(0, 8)}`;
      const stepTag = s.stepCount ? ` (${s.stepCount} steps)` : '';
      optionsHtml += `<option value="${escapeHtml(s.id)}" ${isSelected ? 'selected' : ''}>${escapeHtml(titleText)}${stepTag}</option>`;
    }

    select.innerHTML = optionsHtml;
    select.value = currentVal;
  }

  async function refreshTelemetry(force = false) {
    if (!isMonitoring && !force) return;

    if (!sidecar) {
      $('session-badge').textContent = 'Standalone';
      $('session-badge').className = 'status-badge';
      return;
    }

    const targetId = selectedConversationId === 'auto' ? 'auto' : selectedConversationId;

    try {
      const res = await sidecar.fetch(`/api/telemetry?conversationId=${encodeURIComponent(targetId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (data.error && data.status === 'no_session') {
        $('session-badge').textContent = 'Waiting';
        $('session-badge').className = 'status-badge';
        $('pulse-indicator').className = 'pulse-indicator';
        return;
      }

      lastTelemetryData = data;

      if (data.sessions) {
        updateSessionDropdown(data.sessions, data.activeTitle);
      }

      // Header Status & Pulse
      $('session-badge').textContent = 'Live Trace';
      $('session-badge').className = 'status-badge live';
      $('pulse-indicator').className = 'pulse-indicator live';

      // 1. Cost & Cache Hit Gauge (Overview)
      $('val-cost').textContent = data.estimatedCost || '$0.0000';
      const hitRateText = data.cacheHitRate || '0%';
      $('val-cache-rate').textContent = `${hitRateText} cache hit`;
      const numericRate = parseFloat(hitRateText) || 0;
      $('bar-cache-fill').style.width = `${Math.min(100, numericRate)}%`;

      // 2. Token Breakdown (Overview)
      const inK = formatTokens(data.totalPromptTokens || data.inputTokens);
      const outK = formatTokens(data.outputTokens);
      $('val-tokens').textContent = formatTokens(data.totalTokens);
      $('val-tokens-sub').textContent = `In: ${inK} · Out: ${outK}`;

      // 3. Steps & Error Count (Overview & Badges)
      $('val-steps').textContent = data.totalSteps || 0;
      $('tab-traces-badge').textContent = data.totalSteps || 0;
      const errCount = data.errorCount || 0;
      $('val-steps-sub').textContent = `${errCount} error step${errCount === 1 ? '' : 's'}`;
      $('err-count-badge').textContent = errCount;
      const errorTabBtn = $('tab-errors');
      if (errCount > 0) {
        errorTabBtn.classList.add('has-errors');
      } else {
        errorTabBtn.classList.remove('has-errors');
      }

      // 4. Tools Count (Overview)
      const tools = Object.entries(data.toolCounts || {});
      const totalToolsCalled = tools.reduce((sum, [, count]) => sum + count, 0);
      $('val-tools-count').textContent = totalToolsCalled;
      $('val-tools-distinct').textContent = `${tools.length} unique`;

      // 5. Loop Warning Alert
      const loopBanner = $('loop-banner');
      if (data.loopDetected) {
        loopBanner.classList.add('active');
        $('loop-details').textContent =
          `Tool "${data.loopDetected.tool}" has executed ${data.loopDetected.repetitions} times consecutively with identical arguments.`;
      } else {
        loopBanner.classList.remove('active');
      }

      // Telemetry change detection signature
      const newSignature = `${data.conversationId}:${data.totalSteps}:${data.errorCount}:${data.totalTokens}:${data.loopDetected?.repetitions || 0}:${(data.filesTouched || []).length}`;
      if (force || newSignature !== lastTelemetrySignature) {
        lastTelemetrySignature = newSignature;
        renderToolSpectrum(data.toolCounts || {});
        renderWaterfall();
        renderFiles(data.filesTouched || []);
      }

    } catch (err) {
      console.warn('Telemetry poll error:', err);
      $('session-badge').textContent = 'Disconnected';
      $('session-badge').className = 'status-badge has-errors';
      $('pulse-indicator').className = 'pulse-indicator';
    }
  }

  function setupTabsAndControls() {
    const tabButtons = Array.from(document.querySelectorAll('.nav-tab'));

    function selectTab(targetBtn) {
      if (!targetBtn) return;
      tabButtons.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
        b.setAttribute('tabindex', '-1');
      });
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      targetBtn.classList.add('active');
      targetBtn.setAttribute('aria-selected', 'true');
      targetBtn.setAttribute('tabindex', '0');
      targetBtn.focus();

      const targetPaneId = targetBtn.getAttribute('data-tab');
      const targetPane = $(targetPaneId);
      if (targetPane) {
        targetPane.classList.add('active');
      }
    }

    // Tab click switching & keyboard navigation
    tabButtons.forEach((tabBtn, idx) => {
      tabBtn.addEventListener('click', () => selectTab(tabBtn));

      tabBtn.addEventListener('keydown', (e) => {
        let targetIdx = null;
        if (e.key === 'ArrowRight') {
          targetIdx = (idx + 1) % tabButtons.length;
        } else if (e.key === 'ArrowLeft') {
          targetIdx = (idx - 1 + tabButtons.length) % tabButtons.length;
        } else if (e.key === 'Home') {
          targetIdx = 0;
        } else if (e.key === 'End') {
          targetIdx = tabButtons.length - 1;
        }

        if (targetIdx !== null) {
          e.preventDefault();
          selectTab(tabButtons[targetIdx]);
        }
      });
    });

    // Event delegation on #waterfall-feed to toggle drawer expansion & copy output snippets
    $('waterfall-feed').addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.btn-copy-mini');
      if (copyBtn) {
        e.stopPropagation();
        const text = copyBtn.getAttribute('data-copy');
        if (text) {
          navigator.clipboard.writeText(text)
            .then(() => showToast('Copied output!'))
            .catch(() => showToast('Clipboard failed'));
        }
        return;
      }

      const node = e.target.closest('.waterfall-node');
      if (!node) return;
      const stepIdx = Number(node.getAttribute('data-step'));
      if (node.classList.contains('expanded')) {
        node.classList.remove('expanded');
        expandedStepIndices.delete(stepIdx);
      } else {
        node.classList.add('expanded');
        expandedStepIndices.add(stepIdx);
      }
    });

    // Event delegation on #files-list to copy file paths safely
    $('files-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-copy-path');
      if (!btn) return;
      const filePath = btn.getAttribute('data-path');
      if (filePath) {
        navigator.clipboard.writeText(filePath)
          .then(() => showToast('Path copied!'))
          .catch(() => showToast('Clipboard failed'));
      }
    });

    // Quick action steering buttons
    $('btn-pause').addEventListener('click', () => {
      sendSteerMessage('Please pause your current edits and explain your current reasoning and plan.');
    });

    $('btn-tests').addEventListener('click', () => {
      sendSteerMessage('Please run the project test suite now to verify recent changes.');
    });

    $('btn-review').addEventListener('click', () => {
      sendSteerMessage('Please review recently modified files for any syntax, lint, or regression errors.');
    });

    $('btn-send-steer').addEventListener('click', () => {
      sendSteerMessage($('steer-input').value);
    });

    $('steer-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendSteerMessage($('steer-input').value);
      }
    });

    // Session report button
    $('btn-copy-report').addEventListener('click', copySessionReport);

    // Filter tabs inside Traces
    $('tab-all').addEventListener('click', () => {
      currentMode = 'all';
      $('tab-all').classList.add('active');
      $('tab-tools')?.classList.remove('active');
      $('tab-errors').classList.remove('active');
      renderWaterfall();
    });

    $('tab-tools')?.addEventListener('click', () => {
      currentMode = 'tools';
      $('tab-tools').classList.add('active');
      $('tab-all').classList.remove('active');
      $('tab-errors').classList.remove('active');
      renderWaterfall();
    });

    $('tab-errors').addEventListener('click', () => {
      currentMode = 'errors';
      $('tab-errors').classList.add('active');
      $('tab-all').classList.remove('active');
      $('tab-tools')?.classList.remove('active');
      renderWaterfall();
    });

    // Traces Search Input
    const traceSearchEl = $('trace-search-input');
    if (traceSearchEl) {
      traceSearchEl.addEventListener('input', (e) => {
        traceSearchQuery = e.target.value.trim();
        renderWaterfall();
      });
    }

    // Expand/Collapse All Traces Toggle
    const btnExpandAll = $('btn-toggle-expand-all');
    if (btnExpandAll) {
      btnExpandAll.addEventListener('click', () => {
        const displayedNodes = Array.from(document.querySelectorAll('#waterfall-feed .waterfall-node'));
        if (displayedNodes.length === 0) return;
        const allExpanded = displayedNodes.every(n => n.classList.contains('expanded'));
        if (allExpanded) {
          displayedNodes.forEach(n => {
            const idx = Number(n.getAttribute('data-step'));
            expandedStepIndices.delete(idx);
          });
          btnExpandAll.textContent = 'Expand All';
        } else {
          displayedNodes.forEach(n => {
            const idx = Number(n.getAttribute('data-step'));
            expandedStepIndices.add(idx);
          });
          btnExpandAll.textContent = 'Collapse All';
        }
        renderWaterfall();
      });
    }

    // Session selector dropdown
    $('session-select').addEventListener('change', (e) => {
      selectedConversationId = e.target.value;
      refreshTelemetry(true);
    });

    // Power On/Off monitoring toggle
    $('btn-toggle-monitor').addEventListener('click', toggleMonitoring);
  }

  function toggleMonitoring() {
    isMonitoring = !isMonitoring;
    const btn = $('btn-toggle-monitor');
    const txt = $('power-text');
    const badge = $('session-badge');
    const pulse = $('pulse-indicator');

    if (isMonitoring) {
      btn.classList.add('active');
      txt.textContent = 'ON';
      badge.textContent = 'Live Trace';
      badge.className = 'status-badge live';
      pulse.className = 'pulse-indicator live';
      showToast('Monitoring resumed');
      refreshTelemetry(true);
      if (!monitorInterval) {
        monitorInterval = setInterval(refreshTelemetry, 2500);
      }
    } else {
      btn.classList.remove('active');
      txt.textContent = 'OFF';
      badge.textContent = 'Paused';
      badge.className = 'status-badge';
      pulse.className = 'pulse-indicator';
      showToast('Monitoring paused');
      if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
      }
    }
  }

  setupTabsAndControls();
  refreshTelemetry(true);
  monitorInterval = setInterval(refreshTelemetry, 2500);
})();
