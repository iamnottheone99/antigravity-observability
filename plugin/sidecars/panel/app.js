(() => {
  'use strict';

  const sidecar = typeof window !== 'undefined' ? window.sidecar : (typeof globalThis !== 'undefined' ? globalThis.sidecar : null);

  /**
   * Look up DOM element by its ID.
   * @param {string} id - Target DOM element identifier.
   * @returns {HTMLElement|null} Found element or null.
   */
  const byId = (id) => (typeof document !== 'undefined' && document ? document.getElementById(id) : null);
  const $ = byId;

  let currentMode = 'all'; // 'all' | 'tools' | 'errors'
  let selectedErrorCluster = 'all';
  let traceSearchQuery = '';
  let lastTelemetryData = null;
  let toastTimer = null;
  let selectedConversationId = 'auto'; // 'auto' or explicit uuid
  let lastSessionsSignature = '';
  let lastTelemetrySignature = '';
  const expandedStepIndices = new Set();
  let isMonitoring = true;
  let monitorInterval = null;

  /**
   * Display temporary toast feedback notification.
   * @param {string} msg - Message string to display.
   */
  function showToast(msg) {
    const toast = byId('toast');
    const toastMsg = byId('toast-msg');
    toastMsg.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 2400);
  }

  /**
   * Format numerical token counts into human-readable shorthand (k / M).
   * @param {number} num - Raw token count.
   * @returns {string} Formatted token string.
   */
  function formatTokens(num) {
    if (!num || isNaN(num)) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return String(num);
  }

  /**
   * Sanitize string for secure insertion into HTML contexts.
   * @param {string} str - Unsanitized input string.
   * @returns {string} Escaped HTML string.
   */
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Categorize tool execution for segmented spectrum display.
   * @param {string} toolName - Name of invoked tool.
   * @param {string|null} [serverName=null] - Optional MCP server name.
   * @returns {{ id: string, label: string, color: string, cls: string, server?: string }}
   */
  function getToolCategory(toolName, serverName = null) {
    if (['replace_file_content', 'write_to_file', 'edit_file', 'write_file'].includes(toolName)) {
      return { id: 'file', label: 'File Edits', color: '#3b82f6', cls: 'segment-file' };
    }
    if (['run_command'].includes(toolName)) {
      return { id: 'shell', label: 'Shell / Terminal', color: '#8b5cf6', cls: 'segment-shell' };
    }
    if (['view_file', 'read_file', 'read_url_content', 'search_web'].includes(toolName)) {
      return { id: 'read', label: 'Read / Search', color: '#10b981', cls: 'segment-read' };
    }
    if (['invoke_subagent', 'send_message', 'manage_subagents', 'define_subagent'].includes(toolName)) {
      return { id: 'agent', label: 'Subagents', color: '#f59e0b', cls: 'segment-agent' };
    }
    if (['call_mcp_tool', 'list_resources', 'read_resource'].includes(toolName) || (typeof toolName === 'string' && toolName.startsWith('mcp_'))) {
      if (serverName) {
        const s = String(serverName).toLowerCase();
        let color = '#ec4899';
        if (s === 'engram') color = '#ec4899';
        else if (s.includes('zvec')) color = '#06b6d4';
        else if (s.includes('chrome') || s.includes('devtools')) color = '#f97316';
        else if (s.includes('git') || s.includes('gh')) color = '#a855f7';
        else if (s.includes('docker')) color = '#38bdf8';
        else {
          const palette = ['#f43f5e', '#8b5cf6', '#14b8a6', '#0ea5e9', '#eab308'];
          let hash = 0;
          for (let i = 0; i < s.length; i++) hash = (hash << 5) - hash + s.charCodeAt(i);
          color = palette[Math.abs(hash) % palette.length];
        }
        const cleanLabel = serverName.charAt(0).toUpperCase() + serverName.slice(1);
        return { id: `mcp-${s}`, label: `${cleanLabel} (MCP)`, color, cls: 'segment-mcp', server: s };
      }
      return { id: 'mcp', label: 'MCP Tools', color: '#ec4899', cls: 'segment-mcp' };
    }
    return { id: 'other', label: 'Other Tools', color: '#64748b', cls: 'segment-other' };
  }

  /**
   * Dispatch steering prompt message to the active agent conversation.
   * @param {string} text - User steer instruction text.
   * @returns {Promise<void>}
   */
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
      byId('steer-input').value = '';
    } catch (err) {
      showToast(`Failed to dispatch: ${err.message}`);
    }
  }

  /**
   * Render the segmented tool usage spectrum and distribution legend.
   * @param {Record<string, number>} [toolCounts={}] - Map of tool names to call counts.
   * @param {Record<string, number>} [mcpServers={}] - Map of MCP server names to call counts.
   * @param {string[]} [activeSkills=[]] - List of active skills in session.
   */
  function renderToolSpectrum(toolCounts = {}, mcpServers = {}, activeSkills = []) {
    const barEl = byId('spectrum-bar');
    const legendEl = byId('spectrum-legend');
    const totalEl = byId('spectrum-total');
    const skillsEl = byId('spectrum-skills');

    const entries = Object.entries(toolCounts);
    const totalCalls = entries.reduce((sum, [, count]) => sum + count, 0);
    totalEl.textContent = `${totalCalls} calls`;

    if (totalCalls === 0) {
      barEl.innerHTML = '<div style="width: 100%; height: 100%; background: var(--secondary);"></div>';
      legendEl.innerHTML = '<span style="color: var(--muted-foreground); font-size: 10px;">No tools recorded yet</span>';
      if (skillsEl) skillsEl.style.display = 'none';
      return;
    }

    const categories = {};
    const serverEntries = Object.entries(mcpServers || {});

    for (const [name, count] of entries) {
      if ((name === 'call_mcp_tool' || name.startsWith('mcp_') || name === 'list_resources' || name === 'read_resource') && serverEntries.length > 0) {
        continue;
      }
      const cat = getToolCategory(name);
      if (!categories[cat.id]) {
        categories[cat.id] = { ...cat, count: 0, tools: [] };
      }
      categories[cat.id].count += count;
      categories[cat.id].tools.push({ name, count });
    }

    if (serverEntries.length > 0) {
      for (const [server, count] of serverEntries) {
        const cat = getToolCategory('call_mcp_tool', server);
        if (!categories[cat.id]) {
          categories[cat.id] = { ...cat, count: 0, tools: [] };
        }
        categories[cat.id].count += count;
        categories[cat.id].tools.push({ name: `${server} (MCP)`, count });
      }
    } else {
      const mcpTotal = (toolCounts['call_mcp_tool'] || 0) + (toolCounts['list_resources'] || 0) + (toolCounts['read_resource'] || 0);
      if (mcpTotal > 0 && !categories['mcp']) {
        const cat = getToolCategory('call_mcp_tool');
        categories['mcp'] = { ...cat, count: mcpTotal, tools: [{ name: 'call_mcp_tool', count: mcpTotal }] };
      }
    }

    const segmentsHtml = Object.values(categories).map(cat => {
      const pct = ((cat.count / totalCalls) * 100).toFixed(1);
      return `<div class="segment ${escapeHtml(cat.cls)}" style="width: ${pct}%; background-color: ${cat.color};" title="${escapeHtml(cat.label)}: ${cat.count} (${pct}%)"></div>`;
    }).join('');
    barEl.innerHTML = segmentsHtml;

    const legendHtml = Object.values(categories).map(cat => {
      const pct = Math.round((cat.count / totalCalls) * 100);
      const toolDetails = cat.tools.map(t => `${t.name} (${t.count})`).join(', ');
      return `
        <div class="legend-item" title="${escapeHtml(toolDetails)}">
          <span class="legend-dot" style="background: ${cat.color};"></span>
          <span>${escapeHtml(cat.label)}</span>
          <span class="tabular mono" style="color: var(--muted-foreground); font-size: 9.5px;">${pct}%</span>
        </div>
      `;
    }).join('');
    legendEl.innerHTML = legendHtml;

    if (skillsEl) {
      if (Array.isArray(activeSkills) && activeSkills.length > 0) {
        skillsEl.style.display = 'flex';
        skillsEl.innerHTML = `
          <span class="skills-label">Active Skills / MCP:</span>
          ${activeSkills.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('')}
        `;
      } else {
        skillsEl.style.display = 'none';
        skillsEl.innerHTML = '';
      }
    }
  }

  /**
   * Render cognitive reasoning phase distribution bar and status pill.
   * @param {Record<string, number>} [dist={}] - Percentage distribution of phases.
   * @param {string} [currentPhase='SYNTHESIS'] - Current cognitive phase key.
   * @param {string} [currentPhaseLabel='Synthesis'] - Human-readable current phase label.
   * @param {Record<string, any>} [engineStatus={}] - Semantic classifier engine metadata.
   */
  function renderCognitiveSpectrum(dist = {}, currentPhase = 'SYNTHESIS', currentPhaseLabel = 'Synthesis', engineStatus = {}) {
    const barEl = byId('cognitive-phase-bar');
    const legendEl = byId('cognitive-phase-legend');
    const currentPill = byId('val-current-phase');
    const engineBadge = byId('val-classifier-engine');

    if (currentPill) {
      currentPill.textContent = currentPhaseLabel || currentPhase;
      currentPill.className = `phase-pill phase-${(currentPhase || 'synthesis').toLowerCase()}`;
    }

    if (engineBadge) {
      if (engineStatus?.engine === 'zvec-grep' && engineStatus.active) {
        engineBadge.textContent = `zvec-grep (${engineStatus.model || 'onnx'})`;
        engineBadge.title = `Local neural embedding model active: ${engineStatus.dimensions || 256}-dim vectors (${engineStatus.cachedVectors || 0} cached)`;
      } else {
        engineBadge.textContent = 'Statistical N-Gram';
        engineBadge.title = 'Local zero-dependency statistical n-gram fallback active';
      }
    }

    if (!barEl || !legendEl) return;

    const phases = [
      { id: 'exploration', label: 'Exploration', color: '#10b981', pct: Number(dist.exploration) || 0, desc: 'Reading files, searching codebase' },
      { id: 'synthesis', label: 'Synthesis', color: '#8b5cf6', pct: Number(dist.synthesis) || 0, desc: 'Planning, reasoning, user interaction' },
      { id: 'execution', label: 'Execution', color: '#3b82f6', pct: Number(dist.execution) || 0, desc: 'Editing code, creating files' },
      { id: 'verification', label: 'Verification', color: '#f59e0b', pct: Number(dist.verification) || 0, desc: 'Running tests, git checks, linters' },
      { id: 'recovery', label: 'Recovery', color: '#f43f5e', pct: Number(dist.recovery) || 0, desc: 'Debugging errors, fixing exceptions' },
    ];

    const activePhases = phases.filter(p => p.pct > 0);

    if (activePhases.length === 0) {
      barEl.innerHTML = '<div style="width: 100%; height: 100%; background: var(--secondary);"></div>';
      legendEl.innerHTML = '<span style="color: var(--muted-foreground); font-size: 10px;">No cognitive activity recorded yet</span>';
      return;
    }

    barEl.innerHTML = activePhases.map(p =>
      `<div class="segment" style="width: ${p.pct}%; background-color: ${p.color};" title="${escapeHtml(p.label)}: ${p.pct}% (${escapeHtml(p.desc)})"></div>`
    ).join('');

    legendEl.innerHTML = activePhases.map(p =>
      `<div class="legend-item" title="${escapeHtml(p.desc)}">
        <div class="legend-dot" style="background-color: ${p.color};"></div>
        <span class="legend-name">${escapeHtml(p.label)}</span>
        <span class="legend-pct tabular mono">${p.pct}%</span>
      </div>`
    ).join('');
  }

  /**
   * Update an individual health scorecard pillar percentage and color bar.
   * @param {string} id - Pillar identifier ('reliability', 'loop', 'phase', 'context').
   * @param {number} val - Pillar score percentage (0-100).
   */
  const setPillar = (id, val) => {
    const vEl = byId(`pillar-val-${id}`);
    const bEl = byId(`pillar-bar-${id}`);
    if (vEl) vEl.textContent = `${val}%`;
    if (bEl) {
      bEl.style.width = `${Math.min(100, Math.max(0, val))}%`;
      if (val < 60) bEl.style.backgroundColor = 'var(--destructive)';
      else if (val < 80) bEl.style.backgroundColor = 'var(--warning)';
      else bEl.style.backgroundColor = 'var(--primary)';
    }
  };

  /**
   * Render composite automated agent health scorecard tile and pillar breakdown.
   * @param {Record<string, any>} [scorecard={}] - Scorecard metrics object.
   */
  function renderHealthScorecard(scorecard = {}) {
    const score = Number.isFinite(scorecard.score) ? scorecard.score : 100;
    const grade = scorecard.grade || 'Optimal';
    const color = scorecard.color || '#10b981';
    const summary = scorecard.summary || 'Healthy execution';
    const pillars = scorecard.pillars || {
      reliability: 100,
      loopRadar: 100,
      phaseBalance: 100,
      contextEconomy: 100,
    };

    // 1. Overview Tile 1
    const scoreEl = byId('val-health-score');
    const gradeEl = byId('badge-health-grade');
    const subEl = byId('val-health-sub');
    const barEl = byId('bar-health-fill');

    if (scoreEl) scoreEl.textContent = score;
    if (gradeEl) {
      gradeEl.textContent = grade;
      gradeEl.className = `health-grade-badge grade-${grade.toLowerCase().replace(/\s+/g, '-')}`;
    }
    if (subEl) subEl.textContent = summary;
    if (barEl) {
      barEl.style.width = `${Math.min(100, Math.max(0, score))}%`;
      barEl.style.backgroundColor = color;
    }

    // 2. Health Scorecard Section Breakdown
    const pillEl = byId('scorecard-pill');
    const descEl = byId('scorecard-desc');
    if (pillEl) {
      pillEl.textContent = `${grade} (${score}/100)`;
      pillEl.className = `health-pill grade-${grade.toLowerCase().replace(/\s+/g, '-')}`;
    }
    if (descEl) descEl.textContent = summary;



    setPillar('reliability', pillars.reliability ?? 100);
    setPillar('loop', pillars.loopRadar ?? 100);
    setPillar('phase', pillars.phaseBalance ?? 100);
    setPillar('context', pillars.contextEconomy ?? 100);
  }

  /**
   * Render error taxonomy summary badges, distribution bar, and legend.
   * @param {Record<string, any>} [errorTaxonomy={}] - Clustered error taxonomy mapping.
   */
  function renderErrorTaxonomy(errorTaxonomy = {}) {
    const sectionEl = byId('error-taxonomy-section');
    const badgeEl = byId('error-taxonomy-badge');
    const barEl = byId('error-taxonomy-bar');
    const legendEl = byId('error-taxonomy-legend');

    if (!sectionEl || !barEl || !legendEl) return;

    const clusters = Object.values(errorTaxonomy || {});
    const totalErrors = clusters.reduce((sum, c) => sum + (c.count || 0), 0);

    if (totalErrors === 0) {
      sectionEl.style.display = 'none';
      return;
    }

    sectionEl.style.display = 'flex';
    if (badgeEl) {
      badgeEl.textContent = `${totalErrors} error${totalErrors > 1 ? 's' : ''}`;
    }

    // Segmented bar
    barEl.innerHTML = clusters.map(c => {
      const pct = ((c.count / totalErrors) * 100).toFixed(1);
      return `<div class="segment" style="width: ${pct}%; background-color: ${c.color};" title="${escapeHtml(c.label)}: ${c.count} (${pct}%)"></div>`;
    }).join('');

    // Clickable legend items
    legendEl.innerHTML = clusters.map(c => `
      <div class="error-legend-item" data-cluster="${escapeHtml(c.id)}" title="${escapeHtml(c.description || c.sample || '')} · Click to view in Traces">
        <div class="error-legend-dot" style="background-color: ${c.color};"></div>
        <span class="error-legend-name">${escapeHtml(c.label)}</span>
        <span class="error-legend-count tabular mono">${c.count}</span>
      </div>
    `).join('');

    legendEl.querySelectorAll('.error-legend-item').forEach(el => {
      el.addEventListener('click', () => {
        const clusterId = el.getAttribute('data-cluster');
        switchToTab('pane-traces');
        setFilterMode('errors', clusterId);
      });
    });
  }

  /**
   * Render interactive error cluster filter chips in the Traces pane.
   * @param {Record<string, any>} [errorTaxonomy={}] - Clustered error taxonomy mapping.
   */
  function renderErrorClustersFilter(errorTaxonomy = {}) {
    const filterEl = byId('error-clusters-filter');
    if (!filterEl) return;

    if (currentMode !== 'errors') {
      filterEl.style.display = 'none';
      return;
    }

    const clusters = Object.values(errorTaxonomy || {});
    if (clusters.length === 0) {
      filterEl.style.display = 'none';
      return;
    }

    filterEl.style.display = 'flex';
    const totalErrors = clusters.reduce((sum, c) => sum + (c.count || 0), 0);

    let html = `<button class="error-cluster-chip ${selectedErrorCluster === 'all' ? 'active' : ''}" data-cluster="all" type="button">All Errors (${totalErrors})</button>`;
    for (const c of clusters) {
      const isActive = selectedErrorCluster === c.id;
      const borderStyle = isActive ? `border-color: ${c.color}; color: ${c.color};` : '';
      html += `<button class="error-cluster-chip ${isActive ? 'active' : ''}" data-cluster="${escapeHtml(c.id)}" type="button" style="${borderStyle}">
        <span style="display:inline-block; width:5px; height:5px; border-radius:50%; background:${c.color}; margin-right:3px;"></span>
        ${escapeHtml(c.label)} (${c.count})
      </button>`;
    }
    filterEl.innerHTML = html;

    filterEl.querySelectorAll('.error-cluster-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedErrorCluster = btn.getAttribute('data-cluster');
        renderErrorClustersFilter(errorTaxonomy);
        renderWaterfall();
      });
    });
  }

  /**
   * Switch the active navigation tab pane.
   * @param {string} tabId - Target pane element ID.
   */
  function switchToTab(tabId) {
    document.querySelectorAll('.nav-tab').forEach(t => {
      const match = t.getAttribute('data-tab') === tabId;
      t.classList.toggle('active', match);
      t.setAttribute('aria-selected', match ? 'true' : 'false');
      t.setAttribute('tabindex', match ? '0' : '-1');
    });
    document.querySelectorAll('.tab-pane').forEach(p => {
      p.classList.toggle('active', p.id === tabId);
    });
  }

  /**
   * Set traces filtering mode and optional error taxonomy cluster filter.
   * @param {'all'|'tools'|'errors'} mode - Filtering mode.
   * @param {string} [cluster='all'] - Error cluster category ID.
   */
  function setFilterMode(mode, cluster = 'all') {
    currentMode = mode;
    selectedErrorCluster = cluster;
    byId('tab-all')?.classList.toggle('active', mode === 'all');
    byId('tab-tools')?.classList.toggle('active', mode === 'tools');
    byId('tab-errors')?.classList.toggle('active', mode === 'errors');
    renderErrorClustersFilter(lastTelemetryData?.errorTaxonomy);
    renderWaterfall();
  }

  /**
   * Render vertical waterfall trace feed with expandable step drawers.
   */
  function renderWaterfall() {
    if (!lastTelemetryData) return;
    const feedEl = byId('waterfall-feed');
    let items = lastTelemetryData.recentSteps || [];

    if (currentMode === 'errors') {
      items = lastTelemetryData.failedSteps || [];
      if (selectedErrorCluster && selectedErrorCluster !== 'all') {
        items = items.filter(s => s.errorTaxonomy?.id === selectedErrorCluster);
      }
    } else if (currentMode === 'tools') {
      items = items.filter(s => s.tools && s.tools.length > 0);
    }

    if (traceSearchQuery) {
      const q = traceSearchQuery.toLowerCase();
      items = items.filter(s => {
        if (String(s.stepIndex).includes(q)) return true;
        if (s.phase && s.phase.toLowerCase().includes(q)) return true;
        if (s.phaseLabel && s.phaseLabel.toLowerCase().includes(q)) return true;
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
    const countLabel = byId('traces-count-label');
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

        const errorCauseBlock = s.errorTaxonomy ? `
          <div class="drawer-section" style="border-left: 2px solid ${s.errorTaxonomy.color}; padding-left: 8px;">
            <div class="drawer-section-title" style="color: ${s.errorTaxonomy.color};">
              <span>Root Cause: ${escapeHtml(s.errorTaxonomy.label)}</span>
            </div>
            <div style="font-size: 11px; color: var(--foreground);">${escapeHtml(s.errorTaxonomy.summary)}</div>
          </div>
        ` : '';

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
            ${errorCauseBlock}
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
        if (s.content || s.errorTaxonomy) {
          const causeBlock = s.errorTaxonomy ? `
            <div class="drawer-section" style="border-left: 2px solid ${s.errorTaxonomy.color}; padding-left: 8px;">
              <div class="drawer-section-title" style="color: ${s.errorTaxonomy.color};">
                <span>Root Cause: ${escapeHtml(s.errorTaxonomy.label)}</span>
              </div>
              <div style="font-size: 11px; color: var(--foreground);">${escapeHtml(s.errorTaxonomy.summary)}</div>
            </div>
          ` : '';
          drawerHtml = `
            <div class="node-drawer">
              ${causeBlock}
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
      const errorTaxonomyBadge = s.errorTaxonomy
        ? `<span class="error-taxonomy-tag mono" style="color: ${s.errorTaxonomy.color}; background: ${s.errorTaxonomy.color}22; border: 1px solid ${s.errorTaxonomy.color}44;" title="${escapeHtml(s.errorTaxonomy.summary || '')}">${escapeHtml(s.errorTaxonomy.label)}</span>`
        : '';

      return `
        <div class="waterfall-node ${isErr ? 'error' : ''} ${isExpanded ? 'expanded' : ''}" data-step="${s.stepIndex}">
          <div class="waterfall-bullet"></div>
          <div class="node-card">
            <div class="node-header">
              <div style="display: flex; align-items: center; gap: 5px; flex-wrap: wrap;">
                <span class="node-step-tag tabular mono">#${s.stepIndex}</span>
                ${categoryPill}
                ${s.phase ? `<span class="phase-pill phase-${(s.phase || 'synthesis').toLowerCase()}">${escapeHtml(s.phaseLabel || s.phase)}</span>` : ''}
                ${errorTaxonomyBadge}
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

  /**
   * Render list of modified/accessed files with copy actions.
   * @param {string[]} [files=[]] - Array of touched file paths.
   */
  function renderFiles(files = []) {
    const listEl = byId('files-list');
    const countBadge = byId('tab-files-badge');
    const summaryCount = byId('files-summary-count');

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

  /**
   * Generate and copy Markdown session trace telemetry report to clipboard.
   */
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

  /**
   * Update conversation session selector options when session list changes.
   * @param {Array<{ id: string, title?: string, stepCount?: number }>} [sessions=[]] - Active sessions.
   * @param {string} [activeTitle=''] - Title of active conversation.
   */
  function updateSessionDropdown(sessions = [], activeTitle = '') {
    if (!Array.isArray(sessions) || sessions.length === 0) return;

    const signature = sessions.map(s => `${s.id}:${s.stepCount}`).join(',') + `|${activeTitle}|${selectedConversationId}`;
    if (signature === lastSessionsSignature) {
      return; // Sessions unchanged, prevent dropdown DOM reset
    }
    lastSessionsSignature = signature;

    const select = byId('session-select');
    const currentVal = selectedConversationId;

    const autoLabel = activeTitle ? `Auto (${activeTitle.slice(0, 24)})` : 'Auto (Active Chat)';
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

  /**
   * Fetch latest telemetry payload from sidecar API and re-render dashboard views.
   * @param {boolean} [force=false] - Force update regardless of pause state or signature match.
   * @returns {Promise<void>}
   */
  async function refreshTelemetry(force = false) {
    if (!isMonitoring && !force) return;

    if (!sidecar) {
      byId('session-badge').textContent = 'Standalone';
      byId('session-badge').className = 'status-badge';
      return;
    }

    const targetId = selectedConversationId === 'auto' ? 'auto' : selectedConversationId;

    try {
      const forceQuery = force ? '&force=true' : '';
      const res = await sidecar.fetch(`/api/telemetry?conversationId=${encodeURIComponent(targetId)}${forceQuery}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (data.error && data.status === 'no_session') {
        byId('session-badge').textContent = 'Waiting';
        byId('session-badge').className = 'status-badge';
        byId('pulse-indicator').className = 'pulse-indicator';
        return;
      }

      lastTelemetryData = data;

      if (data.sessions) {
        updateSessionDropdown(data.sessions, data.activeTitle);
      }

      // Header Status & Pulse
      byId('session-badge').textContent = 'Live Trace';
      byId('session-badge').className = 'status-badge live';
      byId('pulse-indicator').className = 'pulse-indicator live';

      // Header Model Badge
      const modelBadge = byId('model-badge');
      if (modelBadge) {
        modelBadge.textContent = data.activeModel || 'Gemini';
        modelBadge.title = `Active Model: ${data.activeModel || 'Gemini'}`;
      }

      // 1. Agent Health & Scorecard (Overview)
      if (data.healthScorecard) {
        renderHealthScorecard(data.healthScorecard);
      }

      // 2. Active Context Window (Overview - Antigravity)
      const ctxTokens = data.latestContextTokens || 0;
      const ctxK = formatTokens(ctxTokens);
      byId('val-context').textContent = ctxK;
      const ctxLoadText = data.contextLoadPercent || '0.0%';
      const ctxNumeric = parseFloat(ctxLoadText) || 0;
      byId('val-context-load').textContent = `${ctxLoadText} load`;
      const ctxBar = byId('bar-context-fill');
      if (ctxBar) {
        ctxBar.style.width = `${Math.min(100, ctxNumeric)}%`;
        if (ctxNumeric >= 85) {
          ctxBar.className = 'micro-bar-fill danger';
        } else if (ctxNumeric >= 70) {
          ctxBar.className = 'micro-bar-fill warning';
        } else {
          ctxBar.className = 'micro-bar-fill';
        }
      }

      // 3. Token Breakdown (Overview)
      const inK = formatTokens(data.totalPromptTokens || data.inputTokens);
      const outK = formatTokens(data.outputTokens);
      byId('val-tokens').textContent = formatTokens(data.totalTokens);
      byId('val-tokens-sub').textContent = `In: ${inK} · Out: ${outK}`;

      // 4. Steps & Velocity (Overview & Badges)
      byId('val-steps').textContent = data.totalSteps || 0;
      byId('tab-traces-badge').textContent = data.totalSteps || 0;
      const errCount = data.errorCount || 0;
      byId('val-steps-sub').textContent = `Avg ${data.avgStepDuration || '0.0s'}/step · ${errCount} err`;
      byId('err-count-badge').textContent = errCount;
      const errorTabBtn = byId('tab-errors');
      if (errCount > 0) {
        errorTabBtn.classList.add('has-errors');
      } else {
        errorTabBtn.classList.remove('has-errors');
      }

      // 5. Tools & Reliability (Overview)
      const tools = Object.entries(data.toolCounts || {});
      const totalToolsCalled = tools.reduce((sum, [, count]) => sum + count, 0);
      byId('val-tools-count').textContent = totalToolsCalled;
      const successRate = data.toolSuccessRate || '100%';
      byId('val-tools-distinct').textContent = `${successRate} ok · ${tools.length} distinct`;

      // 6. Antigravity Ecosystem (Overview)
      const subagentCalls = data.subagentCalls || 0;
      const mcpCalls = data.mcpCalls || 0;
      const mcpServers = data.mcpServers || {};
      const activeSkills = data.activeSkills || [];
      const artifactsCount = data.artifactsCount || 0;
      const compactionsCount = data.compactionsCount || 0;

      const serverEntries = Object.entries(mcpServers);
      let mcpSummary = `${mcpCalls} MCP`;
      if (serverEntries.length > 0) {
        mcpSummary = serverEntries
          .sort((a, b) => b[1] - a[1])
          .map(([srv, cnt]) => `${srv}(${cnt})`)
          .join(', ');
      }

      if (subagentCalls > 0) {
        byId('val-ecosystem').textContent = `${subagentCalls} Ag · ${mcpSummary}`;
      } else {
        byId('val-ecosystem').textContent = mcpCalls > 0 ? mcpSummary : '0 Agents · 0 MCP';
      }

      if (activeSkills.length > 0) {
        const skillLabel = activeSkills.length <= 2 ? activeSkills.join(', ') : `${activeSkills.length} Skills`;
        byId('val-ecosystem-sub').textContent = `${skillLabel} · ${artifactsCount} Art · ${compactionsCount} Cmp`;
      } else {
        byId('val-ecosystem-sub').textContent = `${artifactsCount} Artifacts · ${compactionsCount} Compacted`;
      }

      const ecoTile = byId('val-ecosystem')?.parentElement;
      if (ecoTile) {
        const srvDetails = serverEntries.length > 0 ? serverEntries.map(([s, c]) => `${s}: ${c}`).join(', ') : 'None';
        const sklDetails = activeSkills.length > 0 ? activeSkills.join(', ') : 'None';
        ecoTile.title = `Ecosystem Breakdown:\n• Subagents: ${subagentCalls} calls\n• MCP Servers: ${srvDetails}\n• Active Skills: ${sklDetails}\n• Artifacts: ${artifactsCount}\n• Context Compactions: ${compactionsCount}`;
      }

      // 7. Loop Warning Alert
      const loopBanner = byId('loop-banner');
      if (data.loopDetected) {
        loopBanner.classList.add('active');
        if (data.loopDetected.similarity) {
          byId('loop-details').textContent =
            data.loopDetected.description || `Repetitive ${data.loopDetected.tool || 'action'} detected (${Math.round(data.loopDetected.similarity * 100)}% similarity).`;
        } else {
          byId('loop-details').textContent =
            `Tool "${data.loopDetected.tool}" has executed ${data.loopDetected.repetitions} times consecutively with identical arguments.`;
        }
      } else {
        loopBanner.classList.remove('active');
      }

      // Telemetry change detection signature
      const errorCount = data.errorCount || 0;
      const errorClusterCount = Object.keys(data.errorTaxonomy || {}).length;
      const healthScore = data.healthScorecard?.score ?? 100;
      const cognitiveSig = `${data.currentPhase || ''}:${data.cognitiveEngine?.engine || ''}:${data.cognitiveEngine?.cachedVectors || 0}`;
      const newSignature = `${data.conversationId}:${data.totalSteps}:${errorCount}:${data.totalTokens}:${data.latestContextTokens || 0}:${data.activeModel || ''}:${data.loopDetected?.repetitions || data.loopDetected?.similarity || 0}:${(data.filesTouched || []).length}:${Object.keys(mcpServers).length}:${activeSkills.length}:${cognitiveSig}:${healthScore}:${errorClusterCount}`;
      if (force || newSignature !== lastTelemetrySignature) {
        lastTelemetrySignature = newSignature;
        renderToolSpectrum(data.toolCounts || {}, data.mcpServers || {}, data.activeSkills || []);
        renderCognitiveSpectrum(data.phaseDistribution || {}, data.currentPhase, data.currentPhaseLabel, data.cognitiveEngine);
        renderErrorTaxonomy(data.errorTaxonomy || {});
        renderErrorClustersFilter(data.errorTaxonomy || {});
        renderWaterfall();
        renderFiles(data.filesTouched || []);
      }

    } catch (err) {
      console.warn('Telemetry poll error:', err);
      byId('session-badge').textContent = 'Disconnected';
      byId('session-badge').className = 'status-badge has-errors';
      byId('pulse-indicator').className = 'pulse-indicator';
    }
  }

  /**
   * Switch the active navigation tab and display its pane.
   * @param {HTMLElement} targetBtn - Target nav-tab button element.
   */
  function selectTab(targetBtn) {
    if (!targetBtn) return;
    const tabButtons = Array.from(document.querySelectorAll('.nav-tab'));
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
    const targetPane = byId(targetPaneId);
    if (targetPane) {
      targetPane.classList.add('active');
    }
    if (targetPaneId === 'pane-system') {
      fetchQuotaData(false);
      fetchCacheData(false);
    }
  }

  /**
   * Bind event listeners for tab switching, steering form, and filter controls.
   */
  function setupTabsAndControls() {
    const tabButtons = Array.from(document.querySelectorAll('.nav-tab'));



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
    byId('waterfall-feed').addEventListener('click', (e) => {
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
    byId('files-list').addEventListener('click', (e) => {
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
    byId('btn-pause').addEventListener('click', () => {
      sendSteerMessage('Please pause your current edits and explain your current reasoning and plan.');
    });

    byId('btn-tests').addEventListener('click', () => {
      sendSteerMessage('Please run the project test suite now to verify recent changes.');
    });

    byId('btn-review').addEventListener('click', () => {
      sendSteerMessage('Please review recently modified files for any syntax, lint, or regression errors.');
    });

    byId('btn-send-steer').addEventListener('click', () => {
      sendSteerMessage(byId('steer-input').value);
    });

    byId('steer-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendSteerMessage(byId('steer-input').value);
      }
    });

    // Session report button
    byId('btn-copy-report').addEventListener('click', copySessionReport);

    // Filter tabs inside Traces
    byId('tab-all').addEventListener('click', () => {
      setFilterMode('all');
    });

    byId('tab-tools')?.addEventListener('click', () => {
      setFilterMode('tools');
    });

    byId('tab-errors').addEventListener('click', () => {
      setFilterMode('errors');
    });

    byId('btn-view-all-errors')?.addEventListener('click', () => {
      switchToTab('pane-traces');
      setFilterMode('errors', 'all');
    });

    // Traces Search Input
    const traceSearchEl = byId('trace-search-input');
    if (traceSearchEl) {
      traceSearchEl.addEventListener('input', (e) => {
        traceSearchQuery = e.target.value.trim();
        renderWaterfall();
      });
    }

    // Expand/Collapse All Traces Toggle
    const btnExpandAll = byId('btn-toggle-expand-all');
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
    byId('session-select').addEventListener('change', (e) => {
      selectedConversationId = e.target.value;
      refreshTelemetry(true);
    });

    // Manual telemetry refresh button
    const refreshBtn = byId('btn-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('spinning');
        try {
          await refreshTelemetry(true);
          await fetchQuotaData(true);
          await fetchCacheData(true);
          showToast('Telemetry & Quota refreshed');
        } catch {
          showToast('Refresh failed');
        } finally {
          setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
        }
      });
    }

    // Quota and Cache event handlers
    const refreshQuotaBtn = byId('btn-refresh-quota');
    if (refreshQuotaBtn) {
      refreshQuotaBtn.addEventListener('click', async () => {
        showToast('Refreshing quota...');
        await fetchQuotaData(true);
      });
    }

    const refreshCacheBtn = byId('btn-refresh-cache');
    if (refreshCacheBtn) {
      refreshCacheBtn.addEventListener('click', async () => {
        showToast('Refreshing storage...');
        await fetchCacheData(true);
      });
    }

    const pruneStaleBtn = byId('btn-prune-stale');
    if (pruneStaleBtn) {
      pruneStaleBtn.addEventListener('click', async () => {
        await pruneStaleSessions(10);
      });
    }

    const cacheFeed = byId('cache-tasks-feed');
    if (cacheFeed) {
      cacheFeed.addEventListener('click', async (e) => {
        const delBtn = e.target.closest('.cache-task-delete-btn');
        if (delBtn) {
          const taskId = delBtn.getAttribute('data-task-id');
          if (taskId) {
            await deleteCacheTask(taskId);
          }
        }
      });
    }

    // Power On/Off monitoring toggle
    byId('btn-toggle-monitor').addEventListener('click', toggleMonitoring);
  }

  /**
   * Format ISO reset timestamp into a concise countdown string.
   * @param {string|null} isoString - Target reset ISO string.
   * @returns {string} Human-friendly countdown (e.g. "1d 4h", "45m", "N/A").
   */
  function formatRelativeTime(isoString) {
    if (!isoString) return 'N/A';
    const target = new Date(isoString).getTime();
    if (isNaN(target)) return 'N/A';
    const diff = target - Date.now();
    if (diff <= 0) return 'Ready';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;
      return `${days}d ${remHours}h`;
    }
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  /**
   * Render language server model quota progress bars and rate limits.
   * @param {object} quotaData - Quota payload returned by /api/quota.
   */
  function renderQuotaSummary(quotaData) {
    if (!quotaData) return;

    const planPill = byId('quota-plan-pill');
    const promptCreditsEl = byId('quota-prompt-credits');
    const flowCreditsEl = byId('quota-flow-credits');
    const barsGrid = byId('quota-bars-grid');
    const detailsContainer = byId('quota-details-container');
    const lsStatusBadge = byId('ls-status-badge');

    if (quotaData.status === 'unavailable') {
      if (lsStatusBadge) {
        lsStatusBadge.textContent = 'Standalone Mode (Offline)';
        lsStatusBadge.className = 'badge-status-offline';
      }
      if (barsGrid) {
        barsGrid.innerHTML = '<div class="quota-empty-state">Language server offline or standalone environment.</div>';
      }
      if (detailsContainer) {
        detailsContainer.innerHTML = '<div class="quota-empty-state">Language server connection inactive. Quota tracking is available when connected to Antigravity IDE.</div>';
      }
      return;
    }

    if (lsStatusBadge) {
      lsStatusBadge.textContent = 'Language Server Connected';
      lsStatusBadge.className = 'badge-status-connected';
    }

    // User Profile and Plan
    const user = quotaData.user || {};
    if (planPill) {
      planPill.textContent = user.plan || 'Pro';
    }
    if (promptCreditsEl) {
      const promptAvail = user.availablePromptCredits !== null ? formatTokens(user.availablePromptCredits) : '--';
      promptCreditsEl.textContent = `${promptAvail} Credits`;
      promptCreditsEl.title = `Available Prompt Credits: ${user.availablePromptCredits ?? 'Unlimited'}`;
    }
    if (flowCreditsEl) {
      const flowAvail = user.availableFlowCredits !== null ? formatTokens(user.availableFlowCredits) : '--';
      flowCreditsEl.textContent = `${flowAvail} Flow`;
      flowCreditsEl.title = `Available Flow Credits: ${user.availableFlowCredits ?? 'Unlimited'}`;
    }

    // Overview snapshot bars
    if (barsGrid) {
      const groups = quotaData.groups || [];
      const buckets = [];
      for (const g of groups) {
        if (Array.isArray(g.buckets)) {
          buckets.push(...g.buckets);
        }
      }

      if (buckets.length === 0) {
        barsGrid.innerHTML = '<div class="quota-empty-state">No active quota buckets reported.</div>';
      } else {
        let cardsHtml = '';
        for (const b of buckets) {
          const pct = b.remainingPercent ?? Math.round((b.remainingFraction || 0) * 100);
          const fillCls = pct > 50 ? 'high' : (pct > 20 ? 'medium' : 'low');
          const resetLabel = formatRelativeTime(b.resetTime);
          const nameClean = b.name.replace(/ Limit Remaining/i, '').replace(/ Remaining/i, '');

          cardsHtml += `
            <div class="quota-bucket-card" title="${escapeHtml(b.description || b.name)}">
              <div class="quota-bucket-top">
                <span class="quota-bucket-name">${escapeHtml(nameClean)}</span>
                <span class="quota-bucket-val tabular mono">${pct}%</span>
              </div>
              <div class="quota-bucket-bar">
                <div class="quota-bucket-fill ${fillCls}" style="width: ${pct}%;"></div>
              </div>
              <div class="quota-bucket-reset tabular mono">Reset: ${escapeHtml(resetLabel)}</div>
            </div>
          `;
        }
        barsGrid.innerHTML = cardsHtml;
      }
    }

    // System Details Pane
    if (detailsContainer) {
      let detailsHtml = '';

      // Group cards
      const groups = quotaData.groups || [];
      for (const g of groups) {
        detailsHtml += `
          <div class="quota-group-card">
            <div class="quota-group-header">
              <span class="quota-group-title">${escapeHtml(g.name)}</span>
              <span class="quota-group-desc">${escapeHtml(g.description)}</span>
            </div>
            <div class="quota-bars-grid">
        `;

        for (const b of g.buckets || []) {
          const pct = b.remainingPercent ?? Math.round((b.remainingFraction || 0) * 100);
          const fillCls = pct > 50 ? 'high' : (pct > 20 ? 'medium' : 'low');
          const resetLabel = formatRelativeTime(b.resetTime);
          detailsHtml += `
            <div class="quota-bucket-card" title="${escapeHtml(b.description)}">
              <div class="quota-bucket-top">
                <span class="quota-bucket-name">${escapeHtml(b.name)}</span>
                <span class="quota-bucket-val tabular mono">${pct}%</span>
              </div>
              <div class="quota-bucket-bar">
                <div class="quota-bucket-fill ${fillCls}" style="width: ${pct}%;"></div>
              </div>
              <div class="quota-bucket-reset tabular mono">Reset: ${escapeHtml(resetLabel)}</div>
            </div>
          `;
        }

        detailsHtml += `
            </div>
          </div>
        `;
      }

      // Models Table
      const models = quotaData.models || [];
      if (models.length > 0) {
        detailsHtml += `
          <div class="quota-group-card" style="margin-top: 10px;">
            <div class="quota-group-header">
              <span class="quota-group-title">Active Model Quotas</span>
              <span class="quota-group-desc">${models.length} client models</span>
            </div>
            <table class="quota-models-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Quota Remaining</th>
                  <th>Reset Time</th>
                </tr>
              </thead>
              <tbody>
        `;

        for (const m of models) {
          const pct = m.remainingPercent ?? Math.round((m.remainingFraction || 0) * 100);
          const fillCls = pct > 50 ? 'high' : (pct > 20 ? 'medium' : 'low');
          const resetLabel = formatRelativeTime(m.resetTime);
          detailsHtml += `
            <tr>
              <td>
                <div style="font-weight: 600;">${escapeHtml(m.label)}</div>
                <div style="font-size: 9px; color: var(--muted-foreground);">${escapeHtml(m.modelId)}</div>
              </td>
              <td>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span class="tabular mono" style="font-weight: 700; width: 36px;">${pct}%</span>
                  <div class="quota-bucket-bar" style="width: 70px;">
                    <div class="quota-bucket-fill ${fillCls}" style="width: ${pct}%;"></div>
                  </div>
                </div>
              </td>
              <td class="tabular mono" style="color: var(--muted-foreground); font-size: 9.5px;">
                ${escapeHtml(resetLabel)}
              </td>
            </tr>
          `;
        }

        detailsHtml += `
              </tbody>
            </table>
          </div>
        `;
      }

      detailsContainer.innerHTML = detailsHtml || '<div class="quota-empty-state">No detailed quota limits found.</div>';
    }
  }

  /**
   * Render storage footprint breakdown and brain cache sessions list.
   * @param {object} cacheData - Cache payload returned by /api/cache.
   */
  function renderCacheManager(cacheData) {
    if (!cacheData || cacheData.status !== 'ok') return;

    const summary = cacheData.summary || {};
    const tasks = cacheData.tasks || [];

    const valTotal = byId('val-storage-total');
    const valBrain = byId('val-storage-brain');
    const valBrainCount = byId('val-storage-brain-count');
    const valConversations = byId('val-storage-conversations');
    const valRecordings = byId('val-storage-recordings');
    const tasksCountEl = byId('cache-tasks-count');
    const tasksFeedEl = byId('cache-tasks-feed');

    if (valTotal) valTotal.textContent = summary.totalFormatted || '0 B';
    if (valBrain) valBrain.textContent = summary.brainFormatted || '0 B';
    if (valBrainCount) valBrainCount.textContent = `${summary.brainTasksCount || tasks.length} sessions`;
    if (valConversations) valConversations.textContent = summary.conversationsFormatted || '0 B';
    if (valRecordings) valRecordings.textContent = summary.recordingsFormatted || '0 B';
    if (tasksCountEl) tasksCountEl.textContent = `${tasks.length} sessions`;

    if (!tasksFeedEl) return;

    if (tasks.length === 0) {
      tasksFeedEl.innerHTML = '<div class="cache-empty-state">No stored brain sessions found on disk.</div>';
      return;
    }

    const activeId = selectedConversationId === 'auto'
      ? (lastTelemetryData?.conversationId || '')
      : selectedConversationId;

    let feedHtml = '';
    for (const t of tasks) {
      const isCurrent = t.id === activeId;
      const dateStr = t.mtime ? new Date(t.mtime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const badgeCurrent = isCurrent ? '<span class="status-badge live" style="font-size: 8.5px; padding: 1px 4px;">ACTIVE</span>' : '';

      feedHtml += `
        <div class="cache-task-item" data-task-id="${escapeHtml(t.id)}">
          <div class="cache-task-info">
            <div class="cache-task-title" title="${escapeHtml(t.title)}">
              ${badgeCurrent} ${escapeHtml(t.title)}
            </div>
            <div class="cache-task-meta tabular mono">
              <span>${escapeHtml(t.id.slice(0, 8))}...</span>
              <span>&bull;</span>
              <span style="font-weight: 600; color: var(--foreground);">${escapeHtml(t.sizeFormatted)}</span>
              <span>&bull;</span>
              <span>${escapeHtml(dateStr)}</span>
            </div>
          </div>
          <button class="cache-task-delete-btn" type="button" data-task-id="${escapeHtml(t.id)}" ${isCurrent ? 'disabled title="Cannot delete active session"' : 'title="Delete session cache"'}>
            Delete
          </button>
        </div>
      `;
    }

    tasksFeedEl.innerHTML = feedHtml;
  }

  /**
   * Helper to perform GET request against sidecar API endpoints.
   * @param {string} endpoint - API path.
   * @param {boolean} [force=false] - Whether to bypass cache.
   * @returns {Promise<object>} Parsed JSON response.
   */
  async function fetchEndpoint(endpoint, force = false) {
    const url = `${endpoint}${force ? '?force=true' : ''}`;
    const res = sidecar ? await sidecar.fetch(url) : await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.statusCode || res.status}`);
    return await res.json();
  }

  /**
   * Helper to perform POST mutation against cache management API.
   * @param {object} payload - Action parameters.
   * @returns {Promise<object>} Action result.
   */
  async function postCacheAction(payload) {
    const res = sidecar
      ? await sidecar.fetch('/api/cache', { method: 'POST', body: JSON.stringify(payload) })
      : await fetch('/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return await res.json();
  }

  /**
   * Fetch and render either quota or storage metrics.
   * @param {'quota'|'cache'} type - Target endpoint category.
   * @param {boolean} [force=false] - Whether to bypass server cache.
   * @returns {Promise<object>} Response payload.
   */
  async function fetchResource(type, force = false) {
    try {
      const data = await fetchEndpoint(`/api/${type}`, force);
      if (type === 'quota') renderQuotaSummary(data);
      else renderCacheManager(data);
      return data;
    } catch (err) {
      console.warn(`Failed to fetch ${type} data:`, err);
      const fallback = type === 'quota'
        ? { status: 'unavailable', message: err.message }
        : { status: 'error', error: err.message };
      if (type === 'quota') renderQuotaSummary(fallback);
      return fallback;
    }
  }

  /**
   * Request real-time model quota metrics from sidecar backend.
   * @param {boolean} [force=false] - Whether to bypass server cache.
   * @returns {Promise<object>} Quota payload.
   */
  const fetchQuotaData = (force = false) => fetchResource('quota', force);

  /**
   * Request disk cache footprint and session list from sidecar backend.
   * @param {boolean} [force=false] - Whether to bypass server cache.
   * @returns {Promise<object>} Cache payload.
   */
  const fetchCacheData = (force = false) => fetchResource('cache', force);

  /**
   * Execute cache pruning to remove older sessions and reclaim disk space.
   * @param {number} [keepCount=10] - Number of most recent sessions to preserve.
   * @returns {Promise<object>} Prune result status.
   */
  async function pruneStaleSessions(keepCount = 10) {
    try {
      const activeId = selectedConversationId === 'auto'
        ? (lastTelemetryData?.conversationId || '')
        : selectedConversationId;

      const result = await postCacheAction({
        action: 'prune_stale',
        keepCount,
        activeConversationId: activeId,
      });

      if (result.status === 'ok') {
        showToast(`Pruned ${result.deletedCount} sessions (Freed ${result.freedFormatted})`);
        await fetchCacheData(true);
      } else {
        showToast(`Prune failed: ${result.error || 'Unknown error'}`);
      }
      return result;
    } catch (err) {
      showToast(`Prune failed: ${err.message}`);
      return { status: 'error', error: err.message };
    }
  }

  /**
   * Remove an individual session cache directory and associated database records.
   * @param {string} taskId - Target session UUID.
   * @returns {Promise<object>} Deletion result status.
   */
  async function deleteCacheTask(taskId) {
    if (!taskId) return { status: 'error', error: 'Missing task ID' };
    try {
      const activeId = selectedConversationId === 'auto'
        ? (lastTelemetryData?.conversationId || '')
        : selectedConversationId;

      if (taskId === activeId) {
        showToast('Cannot delete currently active session');
        return { status: 'error', error: 'Cannot delete active session' };
      }

      const result = await postCacheAction({
        action: 'delete_task',
        taskId,
        activeConversationId: activeId,
      });

      if (result.status === 'ok') {
        showToast(`Session deleted (Freed ${result.freedFormatted})`);
        await fetchCacheData(true);
      } else {
        showToast(`Delete failed: ${result.error || 'Unknown error'}`);
      }
      return result;
    } catch (err) {
      showToast(`Delete failed: ${err.message}`);
      return { status: 'error', error: err.message };
    }
  }

  /**
   * Toggle real-time background telemetry polling on or off.
   */
  function toggleMonitoring() {
    isMonitoring = !isMonitoring;
    const btn = byId('btn-toggle-monitor');
    const txt = byId('power-text');
    const badge = byId('session-badge');
    const pulse = byId('pulse-indicator');

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

  // Auto-run when in real browser environment
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof window.addEventListener === 'function' && !globalThis.__IS_HEADLESS_TEST__) {
    setupTabsAndControls();
    refreshTelemetry(true);
    fetchQuotaData(false);
    fetchCacheData(false);
    monitorInterval = setInterval(refreshTelemetry, 2500);
  }

  // Export panel API for testing and diagnostics
  const panelApi = {
    byId,
    showToast,
    formatTokens,
    escapeHtml,
    getToolCategory,
    sendSteerMessage,
    renderToolSpectrum,
    renderCognitiveSpectrum,
    renderHealthScorecard,
    setPillar,
    renderErrorTaxonomy,
    renderErrorClustersFilter,
    switchToTab,
    setFilterMode,
    renderWaterfall,
    renderFiles,
    copySessionReport,
    updateSessionDropdown,
    refreshTelemetry,
    setupTabsAndControls,
    selectTab,
    toggleMonitoring,
    formatRelativeTime,
    renderQuotaSummary,
    renderCacheManager,
    fetchEndpoint,
    postCacheAction,
    fetchResource,
    fetchQuotaData,
    fetchCacheData,
    pruneStaleSessions,
    deleteCacheTask,
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.__observabilityPanel = panelApi;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = panelApi;
  }
})();
