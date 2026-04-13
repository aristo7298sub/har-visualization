/**
 * Visualizer — swim-lane timeline with scroll/zoom + bidirectional highlight
 */
import { HarParser } from './har-parser.js';

/** Direction for each event type */
const DIR_MAP = {
    'session.update': 'send', 'session.created': 'recv', 'session.updated': 'recv',
    'input_audio_buffer.append': 'send', 'input_audio_buffer.speech_started': 'recv',
    'input_audio_buffer.speech_stopped': 'recv', 'input_audio_buffer.committed': 'recv',
    'conversation.item.input_audio_transcription.completed': 'recv',
    'conversation.item.created': 'recv', 'conversation.item.truncate': 'send',
    'response.created': 'recv', 'response.done': 'recv', 'response.cancel': 'send',
    'response.output_item.added': 'recv', 'response.output_item.done': 'recv',
    'response.content_part.added': 'recv', 'response.content_part.done': 'recv',
    'response.audio.delta': 'recv', 'response.audio.done': 'recv',
    'response.audio_transcript.delta': 'recv', 'response.audio_transcript.done': 'recv',
    'error': 'recv',
};
function getDir(et) { return DIR_MAP[et] || (et.startsWith('response.') ? 'recv' : 'send'); }

/** Swim lanes ordered by logical event flow */
const LANES = [
    { id: 'session', label: 'Session', color: '#4285f4', types: ['session.update', 'session.created', 'session.updated'] },
    { id: 'audio-in', label: 'Audio Input', color: '#f9ab00', types: ['input_audio_buffer.append'] },
    { id: 'vad', label: 'VAD / Speech', color: '#0e7c86', types: ['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.committed'] },
    { id: 'transcription', label: 'Transcription', color: '#1a7f37', types: ['conversation.item.input_audio_transcription.completed'] },
    { id: 'conversation', label: 'Conversation', color: '#8250df', types: ['conversation.item.created', 'conversation.item.truncate'] },
    { id: 'response', label: 'Response', color: '#0969da', types: ['response.created', 'response.done', 'response.output_item.added', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done', 'response.cancel'] },
    { id: 'audio-out', label: 'Audio Output', color: '#ea4335', types: ['response.audio.delta', 'response.audio.done'] },
    { id: 'transcript-out', label: 'Transcript Out', color: '#1a7f37', types: ['response.audio_transcript.delta', 'response.audio_transcript.done'] },
];

function eventToLane(et) {
    for (const l of LANES) { if (l.types.includes(et)) return l.id; }
    return null;
}

export class Visualizer {
    constructor() {
        this.messages = [];
        this.stats = null;
        this.selectedEventIdx = -1;
        this.hiddenLanes = new Set();
        this.showEventList = true;
        this.zoomLevel = 1;   // 1 = fit, 2 = 2x, etc.
        this._filterLaneIds = new Set();   // active lane filters for Event Log (multi-select)
        this._boxSelectedIdxs = null; // Set of indices from box-select
    }

    init(messages, stats, filename) {
        this.messages = messages;
        this.stats = stats;
        this.filename = filename;
        this.renderTopBar();
        this.renderOverview();
        this.renderTimeline();
        this.renderConversation();
        this.renderResponses();
        document.getElementById('upload-screen').style.display = 'none';
        document.getElementById('main-app').classList.add('active');
        this.switchTab('overview');
        this.bindTabEvents();
    }

    bindTabEvents() { document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => this.switchTab(t.dataset.tab))); }
    switchTab(id) {
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${id}`));
    }

    renderTopBar() {
        const s = this.stats;
        document.getElementById('top-bar-file').textContent = this.filename;
        document.getElementById('top-bar-stats').innerHTML = `
            <span class="top-bar-stat">Events: <span class="value">${s.totalEvents}</span></span>
            <span class="top-bar-stat">Responses: <span class="value">${s.totalResponses}</span></span>
            <span class="top-bar-stat">Cancel Rate: <span class="value" style="color:${s.cancelRate > 20 ? 'var(--red)' : 'var(--green)'}">${s.cancelRate.toFixed(1)}%</span></span>
            <span class="top-bar-stat">Duration: <span class="value">${s.durationStr || 'N/A'}</span></span>`;
    }

    renderOverview() {
        const s = this.stats, cfg = s.sessionConfig || {}, td = cfg.turn_detection || {},
            voice = cfg.voice || {}, aec = cfg.input_audio_echo_cancellation || {},
            ns = cfg.input_audio_noise_reduction || {}, txn = cfg.input_audio_transcription || {},
            agent = s.sessionCreated?.agent || {};
        document.getElementById('overview-content').innerHTML = `
            <div class="overview-grid">
                <div class="card"><div class="card-header">📊 Statistics</div><div class="card-body"><div class="stat-grid">
                    <div class="stat-item"><div class="stat-value accent">${s.totalEvents}</div><div class="stat-label">Total Events</div></div>
                    <div class="stat-item"><div class="stat-value green">${s.completedResponses}</div><div class="stat-label">Completed</div></div>
                    <div class="stat-item"><div class="stat-value red">${s.cancelledResponses}</div><div class="stat-label">Cancelled</div></div>
                    <div class="stat-item"><div class="stat-value ${s.cancelRate > 30 ? 'red' : s.cancelRate > 10 ? 'orange' : 'green'}">${s.cancelRate.toFixed(1)}%</div><div class="stat-label">Cancel Rate</div></div>
                    <div class="stat-item"><div class="stat-value accent">${s.vadSpeechStart}</div><div class="stat-label">VAD Triggers</div></div>
                    <div class="stat-item"><div class="stat-value accent">${s.durationStr || 'N/A'}</div><div class="stat-label">Duration</div></div>
                </div></div></div>
                <div class="card"><div class="card-header">🔗 Connection</div><div class="card-body"><table class="config-table">
                    ${Object.entries(s.wsParams).filter(([k]) => k !== 'authorization').map(([k, v]) => `<tr><td>${this._esc(k)}</td><td>${this._esc(this._trunc(v, 60))}</td></tr>`).join('')}
                </table></div></div>
                <div class="card"><div class="card-header">⚙️ Session Config</div><div class="card-body"><table class="config-table">
                    <tr><td>Modalities</td><td>${this._esc(JSON.stringify(cfg.modalities || []))}</td></tr>
                    <tr><td>VAD Type</td><td>${this._esc(td.type || 'N/A')}</td></tr>
                    <tr><td>silence_duration_ms</td><td>${td.silence_duration_ms ?? 'N/A'}</td></tr>
                    <tr><td>prefix_padding_ms</td><td>${td.prefix_padding_ms ?? 'N/A'}</td></tr>
                    <tr><td>Echo Cancellation</td><td>${this._esc(aec.type || 'N/A')}</td></tr>
                    <tr><td>Noise Reduction</td><td>${this._esc(ns.type || 'N/A')}</td></tr>
                    <tr><td>Voice</td><td>${this._esc(voice.name || 'N/A')} (${this._esc(voice.type || '')})</td></tr>
                    <tr><td>Rate</td><td>${voice.rate ?? 'N/A'}</td></tr>
                    <tr><td>Temperature</td><td>${voice.temperature ?? 'N/A'}</td></tr>
                    <tr><td>Transcription</td><td>${this._esc(txn.model || 'N/A')}</td></tr>
                </table></div></div>
                ${agent.name ? `<div class="card"><div class="card-header">🤖 Agent</div><div class="card-body"><table class="config-table">
                    <tr><td>Name</td><td>${this._esc(agent.name)}</td></tr>
                    <tr><td>Type</td><td>${this._esc(agent.type || 'N/A')}</td></tr>
                    <tr><td>Description</td><td style="font-family:var(--font-sans)">${this._esc(this._trunc(agent.description || '', 200))}</td></tr>
                </table></div></div>` : ''}
                <div class="card" style="grid-column:1/-1"><div class="card-header">🔍 Diagnostics</div><div class="card-body"><div class="diag-list">
                    ${s.diagnostics.map(d => `<div class="diag-item ${d.level}"><span>${d.icon}</span><span>${this._esc(d.message)}</span></div>`).join('')}
                </div></div></div>
            </div>`;
    }

    // ═══════════════════════════════════════
    //  SWIM LANE TIMELINE
    // ═══════════════════════════════════════
    renderTimeline() {
        const container = document.getElementById('timeline-content');
        const dur = this.stats.lastTimestamp - this.stats.firstTimestamp;
        this._duration = dur;

        const laneButtons = LANES.map(l =>
            `<span class="sl-btn active" data-lane="${l.id}"><span class="lane-color-dot" style="background:${l.color};display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:middle;"></span>${l.label}</span>`
        ).join('');

        container.innerHTML = `
            <div class="swimlane-wrapper">
                <div class="sl-detail-card" id="sl-detail-card">
                    <div class="sl-detail-header">
                        <span class="sl-detail-type" id="sl-detail-type"></span>
                        <span class="sl-detail-dir" id="sl-detail-dir"></span>
                        <span class="sl-detail-time" id="sl-detail-time"></span>
                        <span class="sl-detail-close" id="sl-detail-close">&times;</span>
                    </div>
                    <div class="sl-detail-summary" id="sl-detail-summary"></div>
                    <div class="sl-detail-json-toggle" id="sl-detail-json-toggle">▶ Raw Log</div>
                    <pre class="sl-detail-json" id="sl-detail-json"></pre>
                </div>
                <div class="sl-controls">
                    ${laneButtons}
                    <span class="sl-event-count" id="sl-event-count"></span>
                    <div class="sl-zoom-controls">
                        <button class="sl-zoom-btn" id="sl-zoom-out">−</button>
                        <button class="sl-zoom-btn" id="sl-zoom-in">+</button>
                        <span class="sl-zoom-label" id="sl-zoom-label">1x</span>
                        <button class="sl-zoom-btn" id="sl-zoom-fit" style="font-size:12px;width:auto;padding:0 8px">Fit</button>
                    </div>
                </div>
                <!-- Minimap with viewport slider -->
                <div class="sl-minimap" id="sl-minimap">
                    <canvas id="sl-minimap-canvas" height="32"></canvas>
                    <div class="sl-minimap-viewport" id="sl-minimap-viewport"></div>
                </div>
                <div class="sl-scroll-container" id="sl-scroll-container">
                    <div class="sl-scroll-inner" id="sl-scroll-inner">
                        <div class="sl-time-axis" id="sl-time-axis"></div>
                        <div id="sl-lanes"></div>
                    </div>
                </div>
                <div class="event-list-section">
                    <div class="event-list-toggle" id="event-list-toggle">▼ Event Log</div>
                    <div style="padding:6px 14px;background:var(--bg-secondary);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:16px;font-size:13px;color:var(--text-secondary)">
                        <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="sl-show-hf"> Show high-frequency events (audio.append, audio.delta, transcript.delta)</label>
                        <button class="sl-filter-clear" id="sl-filter-clear" style="display:none;margin-left:8px;padding:2px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--orange-light);color:var(--orange);font-size:12px;cursor:pointer;font-weight:600">✕ Clear Filter</button>
                        <span id="sl-filter-label" style="display:none;font-size:12px;color:var(--orange);font-weight:600"></span>
                        <span id="sl-log-count" style="margin-left:auto;font-size:12px;color:var(--text-muted)"></span>
                    </div>
                    <div class="event-list" id="event-list"></div>
                </div>
            </div>`;

        this._renderAll();
        this._renderMinimap();
        this._renderEventList();

        // Bind controls — lane buttons: click=filter Event Log (multi-select), right-click=toggle visibility
        container.querySelectorAll('.sl-btn[data-lane]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const lid = btn.dataset.lane;
                // Toggle this lane in Event Log filter (multi-select)
                this._boxSelectedIdxs = null;
                if (this._filterLaneIds.has(lid)) {
                    this._filterLaneIds.delete(lid);
                    btn.classList.remove('filter-active');
                } else {
                    this._filterLaneIds.add(lid);
                    btn.classList.add('filter-active');
                }
                this._renderEventList();
            });
            // Right-click to toggle lane visibility
            btn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const lid = btn.dataset.lane;
                this.hiddenLanes.has(lid) ? this.hiddenLanes.delete(lid) : this.hiddenLanes.add(lid);
                btn.classList.toggle('active');
                this._renderAll();
            });
        });

        document.getElementById('sl-detail-close').addEventListener('click', () => this._deselectAll());
        document.getElementById('sl-detail-json-toggle').addEventListener('click', () => {
            const j = document.getElementById('sl-detail-json'), t = document.getElementById('sl-detail-json-toggle');
            j.classList.toggle('active'); t.textContent = j.classList.contains('active') ? '▼ Raw Log' : '▶ Raw Log';
        });
        document.getElementById('event-list-toggle').addEventListener('click', () => {
            this.showEventList = !this.showEventList;
            document.getElementById('event-list').style.display = this.showEventList ? 'block' : 'none';
            document.getElementById('event-list-toggle').textContent = this.showEventList ? '▼ Event Log' : '▶ Event Log';
        });

        // High-frequency events toggle
        document.getElementById('sl-show-hf').addEventListener('change', () => {
            this._renderEventList();
        });

        // Clear filter button
        document.getElementById('sl-filter-clear').addEventListener('click', () => {
            this._filterLaneIds.clear();
            this._boxSelectedIdxs = null;
            container.querySelectorAll('.sl-btn[data-lane]').forEach(b => b.classList.remove('filter-active'));
            document.querySelectorAll('.sl-event.box-selected').forEach(d => d.classList.remove('box-selected'));
            this._renderEventList();
        });

        // Box-select on timeline
        this._initBoxSelect();

        // Zoom
        document.getElementById('sl-zoom-in').addEventListener('click', () => this._setZoom(this.zoomLevel * 2));
        document.getElementById('sl-zoom-out').addEventListener('click', () => this._setZoom(this.zoomLevel / 2));
        document.getElementById('sl-zoom-fit').addEventListener('click', () => this._setZoom(1));

        // Mouse wheel zoom — no modifier key needed, preserves cursor position
        const scrollContainer = document.getElementById('sl-scroll-container');
        scrollContainer.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = scrollContainer.getBoundingClientRect();
            const cursorX = e.clientX - rect.left + scrollContainer.scrollLeft - 170;
            const oldZoom = this.zoomLevel;
            const factor = e.deltaY < 0 ? 1.3 : 0.77;
            const newZoom = Math.max(1, Math.min(200, oldZoom * factor));
            this._setZoom(newZoom);
            const ratio = newZoom / oldZoom;
            scrollContainer.scrollLeft = cursorX * ratio - (e.clientX - rect.left) + 170;
        }, { passive: false });

        // Sync minimap viewport on scroll
        scrollContainer.addEventListener('scroll', () => this._updateMinimapViewport());

        // Minimap drag to navigate
        this._initMinimapDrag();
    }

    _setZoom(z) {
        this.zoomLevel = Math.max(1, Math.min(200, z));
        const label = this.zoomLevel < 10 ? this.zoomLevel.toFixed(1) + 'x' : Math.round(this.zoomLevel) + 'x';
        document.getElementById('sl-zoom-label').textContent = label;
        const inner = document.getElementById('sl-scroll-inner');
        inner.style.width = (this.zoomLevel * 100) + '%';
        this._renderTimeAxis();
        this._renderLanes();
        this._updateMinimapViewport();
    }

    _renderMinimap() {
        const canvas = document.getElementById('sl-minimap-canvas');
        if (!canvas) return;
        const container = document.getElementById('sl-minimap');
        canvas.width = container.clientWidth;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        const dur = this._duration;
        if (!dur) return;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#f0f2f5';
        ctx.fillRect(0, 0, w, h);
        // Draw events as thin lines
        const colors = { 'session': '#4285f4', 'vad': '#0e7c86', 'audio-input': '#f9ab00', 'transcription': '#1a7f37', 'response': '#0969da', 'response-done': '#0969da', 'audio-output': '#ea4335', 'transcript-done': '#1a7f37', 'conversation': '#8250df', 'cancel': '#cf222e' };
        for (const msg of this.messages) {
            const x = (HarParser._tsToMs(msg.timestamp) - this.stats.firstTimestamp) / dur * w;
            const cat = HarParser.classifyEvent(msg.eventType);
            ctx.fillStyle = colors[cat] || '#8b949e';
            ctx.globalAlpha = msg.eventType === 'input_audio_buffer.append' ? 0.15 : 0.6;
            ctx.fillRect(x, 0, 1, h);
        }
        ctx.globalAlpha = 1;
        this._updateMinimapViewport();
    }

    _updateMinimapViewport() {
        const vp = document.getElementById('sl-minimap-viewport');
        const sc = document.getElementById('sl-scroll-container');
        const minimap = document.getElementById('sl-minimap');
        if (!vp || !sc || !minimap) return;
        const mmWidth = minimap.clientWidth;
        const contentWidth = sc.scrollWidth - 170; // subtract sticky label
        const visibleWidth = sc.clientWidth - 170;
        if (contentWidth <= 0) return;
        const vpLeft = sc.scrollLeft / contentWidth * mmWidth;
        const vpWidth = Math.max(20, visibleWidth / contentWidth * mmWidth);
        vp.style.left = vpLeft + 'px';
        vp.style.width = Math.min(vpWidth, mmWidth) + 'px';
    }

    _initMinimapDrag() {
        const vp = document.getElementById('sl-minimap-viewport');
        const minimap = document.getElementById('sl-minimap');
        const sc = document.getElementById('sl-scroll-container');
        if (!vp || !minimap || !sc) return;
        let dragging = false, startX = 0, startScroll = 0;
        const onDown = (e) => {
            dragging = true;
            startX = e.clientX;
            startScroll = sc.scrollLeft;
            document.body.style.userSelect = 'none';
        };
        const onMove = (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const mmWidth = minimap.clientWidth;
            const contentWidth = sc.scrollWidth - 170;
            sc.scrollLeft = startScroll + dx / mmWidth * contentWidth;
        };
        const onUp = () => { dragging = false; document.body.style.userSelect = ''; };
        vp.addEventListener('mousedown', onDown);
        // Click on minimap to jump
        minimap.addEventListener('click', (e) => {
            if (e.target === vp) return;
            const rect = minimap.getBoundingClientRect();
            const clickPct = (e.clientX - rect.left) / rect.width;
            const contentWidth = sc.scrollWidth - 170;
            const visibleWidth = sc.clientWidth - 170;
            sc.scrollLeft = clickPct * contentWidth - visibleWidth / 2;
        });
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    _renderAll() {
        this._renderTimeAxis();
        this._renderLanes();
        this._updateEventCount();
    }

    _renderTimeAxis() {
        const axisEl = document.getElementById('sl-time-axis');
        const dur = this._duration;
        if (!dur || dur <= 0) return;
        const tickCount = Math.max(6, Math.floor(10 * this.zoomLevel));
        let html = '';
        for (let i = 0; i <= tickCount; i++) {
            const pct = (i / tickCount * 100).toFixed(3);
            const ms = this.stats.firstTimestamp + (dur * i / tickCount);
            const label = new Date(ms).toISOString().substring(11, 23);
            html += `<span class="sl-time-tick" style="left:${pct}%">${label}</span>`;
        }
        axisEl.innerHTML = html;
    }

    _renderLanes() {
        const el = document.getElementById('sl-lanes');
        const dur = this._duration;
        const s = this.stats;
        let html = '';

        for (const lane of LANES) {
            if (this.hiddenLanes.has(lane.id)) continue;

            // Determine predominant direction for this lane
            const dirs = new Set(lane.types.map(t => getDir(t)));
            const dirLabel = dirs.size > 1 ? 'both' : (dirs.has('send') ? 'send' : 'recv');
            const dirBadge = dirLabel === 'send' ? '<span class="sl-lane-dir-badge send">SEND</span>'
                : dirLabel === 'recv' ? '<span class="sl-lane-dir-badge recv">RECV</span>'
                    : '<span class="sl-lane-dir-badge both">BOTH</span>';
            const dirClass = `dir-${dirLabel}`;
            html += `<div class="sl-lane ${dirClass}">`;
            html += `<div class="sl-lane-label"><span class="lane-color-dot" style="background:${lane.color}"></span>${lane.label}${dirBadge}</div>`;
            html += `<div class="sl-lane-track" data-lane="${lane.id}">`;

            // Duration bars
            if (lane.id === 'response') {
                for (const r of s.responses.values()) {
                    const sp = this._pct(r.createdTs, dur), ep = this._pct(r.doneTs || this.messages[this.messages.length - 1]?.timestamp, dur);
                    html += `<div class="sl-duration-bar ${r.status === 'cancelled' ? 'cancelled' : 'completed'}" style="left:${sp}%;width:${Math.max(ep - sp, 0.2)}%"></div>`;
                }
            }
            if (lane.id === 'vad') {
                let ss = null;
                for (const m of this.messages) {
                    if (m.eventType === 'input_audio_buffer.speech_started') ss = m.timestamp;
                    else if (m.eventType === 'input_audio_buffer.speech_stopped' && ss) {
                        const sp = this._pct(ss, dur), ep = this._pct(m.timestamp, dur);
                        html += `<div class="sl-duration-bar speaking" style="left:${sp}%;width:${Math.max(ep - sp, 0.2)}%"></div>`;
                        ss = null;
                    }
                }
            }

            // Event dots
            for (let i = 0; i < this.messages.length; i++) {
                const m = this.messages[i];
                if (eventToLane(m.eventType) !== lane.id) continue;
                const pct = this._pct(m.timestamp, dur);
                const cat = HarParser.classifyEvent(m.eventType);
                html += `<div class="sl-event ${cat}" style="left:${pct}%" data-idx="${i}" title="${this._esc(m.eventType)}"></div>`;
            }
            html += '</div></div>';
        }
        el.innerHTML = html;

        // Bind clicks on dots → bidirectional highlight
        el.querySelectorAll('.sl-event').forEach(dot => {
            dot.addEventListener('click', (e) => { e.stopPropagation(); this._selectEvent(parseInt(dot.dataset.idx)); });
        });
    }

    _pct(ts, dur) {
        if (!ts || !dur) return 0;
        return Math.max(0, Math.min(100, (HarParser._tsToMs(ts) - this.stats.firstTimestamp) / dur * 100));
    }

    _selectEvent(idx) {
        this.selectedEventIdx = idx;
        const msg = this.messages[idx];

        // ── Highlight dot in swim lane ──
        document.querySelectorAll('.sl-event.selected').forEach(e => e.classList.remove('selected'));
        const dot = document.querySelector(`.sl-event[data-idx="${idx}"]`);
        if (dot) {
            dot.classList.add('selected');
            // Scroll into view horizontally
            dot.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }

        // ── Highlight row in event list ──
        document.querySelectorAll('.event-row.selected').forEach(r => r.classList.remove('selected'));
        const row = document.querySelector(`.event-row[data-idx="${idx}"]`);
        if (row) {
            row.classList.add('selected');
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // ── Detail card ──
        const card = document.getElementById('sl-detail-card');
        card.classList.add('active');
        document.getElementById('sl-detail-type').textContent = msg.eventType;

        const dirEl = document.getElementById('sl-detail-dir');
        const dir = getDir(msg.eventType);
        dirEl.textContent = dir === 'send' ? '↑ SEND' : '↓ RECV';
        dirEl.className = `sl-detail-dir ${dir}`;

        const relMs = HarParser._tsToMs(msg.timestamp) - this.stats.firstTimestamp;
        document.getElementById('sl-detail-time').innerHTML = `🕐 ${HarParser.formatTimestamp(msg.timestamp)} &nbsp;|&nbsp; ⏱️ ${(relMs / 1000).toFixed(3)}s`;
        document.getElementById('sl-detail-summary').textContent = HarParser.getEventSummary(msg);
        document.getElementById('sl-detail-json').textContent = JSON.stringify(HarParser.sanitizeEvent(msg.event), null, 2);
        document.getElementById('sl-detail-json').classList.remove('active');
        document.getElementById('sl-detail-json-toggle').textContent = '▶ Raw Log';
    }

    _deselectAll() {
        document.getElementById('sl-detail-card').classList.remove('active');
        document.querySelectorAll('.sl-event.selected').forEach(e => e.classList.remove('selected'));
        document.querySelectorAll('.event-row.selected').forEach(r => r.classList.remove('selected'));
        this.selectedEventIdx = -1;
    }

    _updateEventCount() {
        const v = this.messages.filter(m => !this.hiddenLanes.has(eventToLane(m.eventType))).length;
        const el = document.getElementById('sl-event-count');
        if (el) el.textContent = `${v} / ${this.messages.length} events`;
    }

    _renderEventList() {
        const listEl = document.getElementById('event-list');
        const showHF = document.getElementById('sl-show-hf')?.checked;
        const SKIP = showHF ? new Set() : new Set(['input_audio_buffer.append', 'response.audio.delta', 'response.audio_transcript.delta']);

        // Apply filters: lane filter (multi-select) or box-select
        let filtered;
        let filterLabel = '';
        if (this._boxSelectedIdxs) {
            filtered = this.messages.filter((m, i) => this._boxSelectedIdxs.has(i) && !SKIP.has(m.eventType));
            filterLabel = `Box selection: ${filtered.length} events`;
        } else if (this._filterLaneIds.size > 0) {
            // Collect all event types from selected lanes
            const allowedTypes = new Set();
            for (const lid of this._filterLaneIds) {
                const lane = LANES.find(l => l.id === lid);
                if (lane) lane.types.forEach(t => allowedTypes.add(t));
            }
            filtered = this.messages.filter(m => allowedTypes.has(m.eventType) && !SKIP.has(m.eventType));
            const laneNames = [...this._filterLaneIds].map(lid => LANES.find(l => l.id === lid)?.label || lid).join(' + ');
            filterLabel = `Filter: ${laneNames} — ${filtered.length} events`;
        } else {
            filtered = this.messages.filter(m => !SKIP.has(m.eventType));
        }

        const hasFilter = !!(this._filterLaneIds.size > 0 || this._boxSelectedIdxs);
        const clearBtn = document.getElementById('sl-filter-clear');
        const filterLabelEl = document.getElementById('sl-filter-label');
        if (clearBtn) clearBtn.style.display = hasFilter ? 'inline-block' : 'none';
        if (filterLabelEl) { filterLabelEl.style.display = hasFilter ? 'inline' : 'none'; filterLabelEl.textContent = filterLabel; }

        const countEl = document.getElementById('sl-log-count');
        if (countEl) countEl.textContent = `${filtered.length} / ${this.messages.length} events`;
        const frag = document.createDocumentFragment();

        for (let seq = 0; seq < filtered.length; seq++) {
            const msg = filtered[seq];
            const row = document.createElement('div');
            row.className = 'event-row';
            const cat = HarParser.classifyEvent(msg.eventType);
            const idx = this.messages.indexOf(msg);
            row.dataset.idx = idx;

            if (msg.eventType === 'response.done' && msg.event?.response?.status === 'cancelled') row.classList.add('highlight-cancel');
            if (msg.eventType === 'response.cancel') row.classList.add('highlight-cancel');
            if (msg.eventType.startsWith('input_audio_buffer.speech')) row.classList.add('highlight-vad');

            const dir = getDir(msg.eventType);
            const dirBadge = dir === 'send'
                ? '<span class="event-dir-badge send">SEND</span>'
                : '<span class="event-dir-badge recv">RECV</span>';
            const dirIcon = dir === 'send' ? '↑' : '↓';
            const dirIconClass = dir === 'send' ? 'send' : 'recv';

            row.innerHTML = `
                <span class="event-seq">${seq + 1}</span>
                <span class="event-ts">${HarParser.formatTimestamp(msg.timestamp)}</span>
                ${dirBadge}
                <span class="event-dir-icon ${dirIconClass}">${dirIcon}</span>
                <span class="event-type ${cat}">${this._esc(msg.eventType)}</span>
                <span class="event-col-resize"></span>
                <span class="event-summary">${this._esc(HarParser.getEventSummary(msg))}</span>`;

            row.addEventListener('click', () => this._selectEvent(idx));
            frag.appendChild(row);
        }
        listEl.innerHTML = '';
        listEl.appendChild(frag);
        this._initColumnResize(listEl);
    }

    _initBoxSelect() {
        const scrollContainer = document.getElementById('sl-scroll-container');
        const inner = document.getElementById('sl-scroll-inner');
        if (!scrollContainer || !inner) return;

        let box = null, startX = 0, startY = 0, isDragging = false, dragLaneId = null;

        scrollContainer.addEventListener('mousedown', (e) => {
            // Only start box select on the lane tracks, not on event dots
            if (e.target.classList.contains('sl-event') || e.target.closest('.sl-lane-label')) return;
            const laneTrack = e.target.closest('.sl-lane-track');
            if (!laneTrack && !e.target.closest('.sl-lane')) return;

            // Detect which lane the drag starts on
            dragLaneId = laneTrack ? laneTrack.dataset.lane : null;

            isDragging = true;
            const rect = inner.getBoundingClientRect();
            startX = e.clientX - rect.left;
            startY = e.clientY - rect.top;

            box = document.createElement('div');
            box.className = 'sl-box-select';
            box.style.left = startX + 'px';
            box.style.top = startY + 'px';
            box.style.width = '0';
            box.style.height = '0';
            inner.appendChild(box);

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging || !box) return;
            const rect = inner.getBoundingClientRect();
            const curX = e.clientX - rect.left;
            const curY = e.clientY - rect.top;
            const x = Math.min(startX, curX);
            const y = Math.min(startY, curY);
            const w = Math.abs(curX - startX);
            const h = Math.abs(curY - startY);
            box.style.left = x + 'px';
            box.style.top = y + 'px';
            box.style.width = w + 'px';
            box.style.height = h + 'px';
        });

        document.addEventListener('mouseup', (e) => {
            if (!isDragging || !box) return;
            isDragging = false;

            const rect = inner.getBoundingClientRect();
            const endX = e.clientX - rect.left;
            const w = Math.abs(endX - startX);

            box.remove();
            box = null;

            // Ignore tiny drags (clicks)
            if (w < 5) return;

            // Calculate time range from box x-coordinates
            const innerWidth = inner.clientWidth - 170; // subtract label width
            const leftPx = Math.min(startX, endX) - 170;
            const rightPx = Math.max(startX, endX) - 170;
            const leftPct = Math.max(0, leftPx / innerWidth);
            const rightPct = Math.min(1, rightPx / innerWidth);
            const dur = this._duration;
            const tStart = this.stats.firstTimestamp + leftPct * dur;
            const tEnd = this.stats.firstTimestamp + rightPct * dur;

            // Find events in this time range that belong to the dragged lane
            const selected = new Set();
            for (let i = 0; i < this.messages.length; i++) {
                const m = this.messages[i];
                const ms = HarParser._tsToMs(m.timestamp);
                if (ms < tStart || ms > tEnd) continue;
                // If we know which lane the drag started on, only include that lane's events
                if (dragLaneId) {
                    if (eventToLane(m.eventType) !== dragLaneId) continue;
                }
                selected.add(i);
            }

            if (selected.size === 0) return;

            this._filterLaneIds.clear();
            this._boxSelectedIdxs = selected;
            document.querySelectorAll('.sl-btn[data-lane]').forEach(b => b.classList.remove('filter-active'));

            // Highlight selected dots
            document.querySelectorAll('.sl-event').forEach(dot => {
                const idx = parseInt(dot.dataset.idx);
                dot.classList.toggle('box-selected', selected.has(idx));
            });

            this._renderEventList();
        });
    }

    _initColumnResize(listEl) {
        let dragging = false, startX = 0, startW = 0;
        const curW = () => parseInt(getComputedStyle(listEl).getPropertyValue('--event-type-width') || '400');
        listEl.addEventListener('mousedown', e => {
            if (!e.target.classList.contains('event-col-resize')) return;
            dragging = true; startX = e.clientX; startW = curW();
            e.target.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });
        const onMove = e => { if (!dragging) return; const w = Math.max(120, Math.min(800, startW + e.clientX - startX)); listEl.style.setProperty('--event-type-width', w + 'px'); };
        const onUp = () => { if (!dragging) return; dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; listEl.querySelectorAll('.event-col-resize.dragging').forEach(el => el.classList.remove('dragging')); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    // ── Conversation ──
    renderConversation() {
        const c = document.getElementById('conversation-content'), flow = this.stats.conversationFlow;
        if (!flow.length) { c.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:40px">No transcripts.</div>'; return; }
        c.innerHTML = `<div class="conversation-container">${flow.map(i => {
            if (i.role === 'user') return `<div class="msg-bubble user">${this._esc(i.text)}<div class="msg-meta">🧑 User • ${HarParser.formatTimestamp(i.timestamp)}</div></div>`;
            if (i.status === 'cancelled') return `<div class="msg-bubble cancelled">❌ Cancelled (${this._esc(i.reason || 'unknown')})<div class="msg-meta">🤖 Agent • ${HarParser.formatTimestamp(i.timestamp)}</div></div>`;
            return `<div class="msg-bubble agent">${this._esc(i.text)}<div class="msg-meta">🤖 Agent • ${HarParser.formatTimestamp(i.timestamp)}</div></div>`;
        }).join('')}</div>`;
    }

    // ── Responses ──
    renderResponses() {
        const c = document.getElementById('responses-content'), ra = Array.from(this.stats.responses.values());
        if (!ra.length) { c.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:40px">No responses.</div>'; return; }
        c.innerHTML = `<table class="resp-table"><thead><tr>
            <th>#</th><th>Response ID</th><th>Status</th><th>Reason</th><th>Duration</th>
            <th>Out Tokens</th><th>Audio</th><th>Text</th><th>Audio Deltas</th><th>audio.done</th><th>transcript.done</th><th>Speech During</th>
        </tr></thead><tbody>${ra.map((r, i) => {
            const d = r.doneTs && r.createdTs ? ((HarParser._tsToMs(r.doneTs) - HarParser._tsToMs(r.createdTs)) / 1000).toFixed(1) + 's' : 'N/A';
            return `<tr><td>${i + 1}</td><td title="${this._esc(r.id)}">${this._esc(r.id.substring(0, 28))}…</td>
                <td><span class="badge badge-${r.status}">${r.status}</span></td><td>${this._esc(r.reason || '-')}</td><td>${d}</td>
                <td>${r.outputTokens}</td><td>${r.audioTokens}</td><td>${r.textTokens}</td><td>${r.audioDeltas}</td>
                <td>${r.audioDone ? '✅' : '❌'}</td><td>${r.transcriptDone ? '✅' : '❌'}</td>
                <td>${r.speechStartedDuring ? '<span style="color:var(--red)">🔴 YES</span>' : ''}</td></tr>`;
        }).join('')}</tbody></table>`;
    }

    _esc(s) { if (s == null) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
    _trunc(s, n) { return !s ? '' : s.length > n ? s.substring(0, n) + '…' : s; }
}
