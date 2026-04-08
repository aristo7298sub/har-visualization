/**
 * HAR Parser for Voice Live / Realtime API WebSocket events
 * Ported from har_to_md.py — pure client-side, no dependencies
 */

export class HarParser {
    /**
     * Parse a HAR JSON object and extract WebSocket messages
     * @param {Object} har - Parsed HAR JSON
     * @returns {Object} { messages, stats, errors }
     */
    static parse(har) {
        const messages = this.extractWsMessages(har);
        if (messages.length === 0) {
            return { messages: [], stats: null, error: 'No Voice Live / Realtime API WebSocket events found in HAR file.' };
        }
        const stats = this.analyzeMessages(messages);
        return { messages, stats, error: null };
    }

    /**
     * Extract WebSocket messages from HAR entries
     */
    static extractWsMessages(har) {
        const messages = [];
        const entries = har?.log?.entries || [];

        for (const entry of entries) {
            const url = entry?.request?.url || '';
            if (!url.includes('voice-live/realtime') && !url.includes('openai/realtime')) {
                continue;
            }

            const wsUrl = url;
            const wsParams = {};
            if (url.includes('?')) {
                const paramStr = url.split('?')[1];
                for (const p of paramStr.split('&')) {
                    const eqIdx = p.indexOf('=');
                    if (eqIdx > 0) {
                        wsParams[p.substring(0, eqIdx)] = decodeURIComponent(p.substring(eqIdx + 1));
                    }
                }
            }

            // Try multiple HAR formats for WebSocket messages
            let wsMsgs = entry._webSocketMessages
                || entry?.response?.content?._webSocketMessages
                || [];

            for (const msg of wsMsgs) {
                const data = msg.data || '';
                if (!data) continue;

                let event;
                try {
                    event = JSON.parse(data);
                } catch {
                    continue;
                }

                let direction = 'receive';
                if (msg.type === 'send' || msg.type === 'request') {
                    direction = 'send';
                } else if (msg.type === 'receive' || msg.type === 'response') {
                    direction = 'receive';
                } else {
                    // Fallback: opcode 1 = text
                    const opcode = msg.opcode || 0;
                    direction = opcode === 1 ? 'send' : 'receive';
                }

                messages.push({
                    timestamp: msg.time,
                    direction,
                    event,
                    eventType: event.type || 'unknown',
                    wsUrl,
                    wsParams,
                    rawSize: data.length,
                });
            }
        }

        // Sort by timestamp
        messages.sort((a, b) => {
            const ta = this._tsToMs(a.timestamp);
            const tb = this._tsToMs(b.timestamp);
            return ta - tb;
        });

        return messages;
    }

    /**
     * Analyze messages and produce statistics
     */
    static analyzeMessages(messages) {
        const stats = {
            totalEvents: messages.length,
            sentEvents: 0,
            receivedEvents: 0,
            sessions: {},
            responses: new Map(),
            vadSpeechStart: 0,
            vadSpeechStop: 0,
            cancelEvents: 0,
            truncateEvents: 0,
            transcripts: [],
            conversationFlow: [],
            errors: [],
            sessionConfig: null,
            sessionCreated: null,
            wsUrl: messages[0]?.wsUrl || '',
            wsParams: messages[0]?.wsParams || {},
            firstTimestamp: null,
            lastTimestamp: null,
            _currentResp: null,
        };

        stats.firstTimestamp = this._tsToMs(messages[0]?.timestamp);
        stats.lastTimestamp = this._tsToMs(messages[messages.length - 1]?.timestamp);

        for (const msg of messages) {
            const { direction, eventType: et, event: ev } = msg;

            if (direction === 'send') {
                stats.sentEvents++;
            } else {
                stats.receivedEvents++;
            }

            switch (et) {
                case 'session.update':
                    stats.sessionConfig = ev.session || {};
                    break;

                case 'session.created':
                    stats.sessionCreated = ev.session || {};
                    const sid = ev.session?.id || '';
                    stats.sessions[sid] = {
                        id: sid,
                        model: ev.session?.model || '',
                        agent: ev.session?.agent || null,
                        createdTs: msg.timestamp,
                    };
                    break;

                case 'session.updated':
                    if (!stats.sessionConfig) {
                        stats.sessionConfig = ev.session || {};
                    }
                    break;

                case 'response.created': {
                    const resp = ev.response || {};
                    const rid = resp.id || '';
                    stats._currentResp = rid;
                    stats.responses.set(rid, {
                        id: rid,
                        status: resp.status || 'in_progress',
                        createdTs: msg.timestamp,
                        doneTs: null,
                        reason: '',
                        audioDeltas: 0,
                        transcriptDeltas: 0,
                        audioDone: false,
                        transcriptDone: false,
                        transcriptText: '',
                        outputTokens: 0,
                        audioTokens: 0,
                        textTokens: 0,
                        inputTokens: 0,
                        totalTokens: 0,
                        speechStartedDuring: false,
                        speechStartedTs: null,
                        voice: resp.voice || null,
                        metadata: resp.metadata || null,
                    });
                    break;
                }

                case 'response.audio.delta': {
                    const rid = stats._currentResp;
                    if (rid && stats.responses.has(rid)) {
                        stats.responses.get(rid).audioDeltas++;
                    }
                    break;
                }

                case 'response.audio_transcript.delta': {
                    const rid = stats._currentResp;
                    if (rid && stats.responses.has(rid)) {
                        stats.responses.get(rid).transcriptDeltas++;
                    }
                    break;
                }

                case 'response.audio.done': {
                    const rid = stats._currentResp;
                    if (rid && stats.responses.has(rid)) {
                        stats.responses.get(rid).audioDone = true;
                    }
                    break;
                }

                case 'response.audio_transcript.done': {
                    const rid = stats._currentResp;
                    if (rid && stats.responses.has(rid)) {
                        const r = stats.responses.get(rid);
                        r.transcriptDone = true;
                        r.transcriptText = ev.transcript || '';
                    }
                    const t = ev.transcript || '';
                    if (t) {
                        stats.transcripts.push(`[Agent] ${t}`);
                        stats.conversationFlow.push({
                            role: 'agent',
                            text: t,
                            status: 'completed',
                            responseId: rid,
                            timestamp: msg.timestamp,
                        });
                    }
                    break;
                }

                case 'response.done': {
                    const resp = ev.response || {};
                    const rid = resp.id || '';
                    if (stats.responses.has(rid)) {
                        const r = stats.responses.get(rid);
                        r.status = resp.status || '';
                        r.doneTs = msg.timestamp;
                        const sd = resp.status_details || {};
                        r.reason = sd.reason || '';
                        const usage = resp.usage || {};
                        const outDetails = usage.output_token_details || {};
                        r.outputTokens = usage.output_tokens || 0;
                        r.inputTokens = usage.input_tokens || 0;
                        r.totalTokens = usage.total_tokens || 0;
                        r.audioTokens = outDetails.audio_tokens || 0;
                        r.textTokens = outDetails.text_tokens || 0;

                        if (resp.status === 'cancelled') {
                            stats.conversationFlow.push({
                                role: 'agent',
                                text: '(cancelled)',
                                status: 'cancelled',
                                reason: sd.reason || '',
                                responseId: rid,
                                timestamp: msg.timestamp,
                            });
                        }
                    }
                    stats._currentResp = null;
                    break;
                }

                case 'input_audio_buffer.speech_started':
                    stats.vadSpeechStart++;
                    if (stats._currentResp && stats.responses.has(stats._currentResp)) {
                        const r = stats.responses.get(stats._currentResp);
                        r.speechStartedDuring = true;
                        r.speechStartedTs = msg.timestamp;
                    }
                    break;

                case 'input_audio_buffer.speech_stopped':
                    stats.vadSpeechStop++;
                    break;

                case 'response.cancel':
                    stats.cancelEvents++;
                    break;

                case 'conversation.item.truncate':
                    stats.truncateEvents++;
                    break;

                case 'conversation.item.input_audio_transcription.completed': {
                    const t = ev.transcript || '';
                    if (t) {
                        stats.transcripts.push(t);
                        stats.conversationFlow.push({ role: 'user', text: t, timestamp: msg.timestamp });
                    } else {
                        stats.conversationFlow.push({ role: 'user', text: '(empty transcript)', timestamp: msg.timestamp });
                    }
                    break;
                }

                case 'error':
                    stats.errors.push(ev.error || ev);
                    break;
            }
        }

        // Compute derived stats
        const respArray = Array.from(stats.responses.values());
        stats.totalResponses = respArray.length;
        stats.completedResponses = respArray.filter(r => r.status === 'completed').length;
        stats.cancelledResponses = respArray.filter(r => r.status === 'cancelled').length;
        stats.cancelRate = stats.totalResponses > 0
            ? (stats.cancelledResponses / stats.totalResponses * 100)
            : 0;

        // Duration
        if (stats.firstTimestamp && stats.lastTimestamp) {
            stats.durationMs = stats.lastTimestamp - stats.firstTimestamp;
            stats.durationStr = this._formatDuration(stats.durationMs);
        }

        // Diagnostics
        stats.diagnostics = this._generateDiagnostics(stats);

        return stats;
    }

    /**
     * Generate diagnostic alerts
     */
    static _generateDiagnostics(stats) {
        const diags = [];
        const respArray = Array.from(stats.responses.values());

        if (stats.cancelRate > 30) {
            diags.push({
                level: 'error',
                icon: '🔴',
                message: `Cancel rate ${stats.cancelRate.toFixed(1)}% is high — check VAD config, acoustic environment, AEC timing`,
            });
        }

        if (stats.vadSpeechStart > stats.totalResponses * 2 && stats.totalResponses > 0) {
            diags.push({
                level: 'warning',
                icon: '⚠️',
                message: `speech_started triggered ${stats.vadSpeechStart} times vs ${stats.totalResponses} responses — possible echo feedback or ambient noise`,
            });
        }

        if (stats.truncateEvents === 0 && stats.cancelledResponses > 0) {
            diags.push({
                level: 'warning',
                icon: '⚠️',
                message: `Responses cancelled but no auto_truncate — conversation history may not match what user heard. Consider enabling auto_truncate: true`,
            });
        }

        const speechDuringCompleted = respArray.filter(r => r.status === 'completed' && r.speechStartedDuring).length;
        if (speechDuringCompleted > 0) {
            diags.push({
                level: 'warning',
                icon: '⚠️',
                message: `${speechDuringCompleted} completed response(s) had speech_started during playback — client may stop audio on VAD trigger (audio truncation pattern)`,
            });
        }

        const audioIncomplete = respArray.filter(r => r.status === 'completed' && r.transcriptDone && !r.audioDone).length;
        if (audioIncomplete > 0) {
            diags.push({
                level: 'error',
                icon: '🔴',
                message: `${audioIncomplete} response(s) have transcript.done but audio.done=false — server-side audio stream truncated`,
            });
        }

        // Cancelled with audio deltas = user heard partial content
        const cancelledWithAudio = respArray.filter(r => r.status === 'cancelled' && r.audioDeltas > 0);
        for (const r of cancelledWithAudio) {
            diags.push({
                level: 'error',
                icon: '🔴',
                message: `Response ${r.id.substring(0, 25)}… cancelled after ${r.audioDeltas} audio deltas — user heard partial content then it was cut`,
            });
        }

        // Normal barge-in
        const normalBargeIn = respArray.filter(r => r.status === 'cancelled' && r.audioDeltas === 0 && r.reason === 'turn_detected');
        for (const r of normalBargeIn) {
            diags.push({
                level: 'info',
                icon: 'ℹ️',
                message: `Response ${r.id.substring(0, 25)}… — normal barge-in (user continued speaking, VAD cancelled pending response)`,
            });
        }

        if (stats.errors.length > 0) {
            diags.push({
                level: 'error',
                icon: '❌',
                message: `${stats.errors.length} error event(s) detected — investigate further`,
            });
        }

        if (diags.length === 0) {
            diags.push({
                level: 'success',
                icon: '✅',
                message: 'No anomalies detected in this session',
            });
        }

        return diags;
    }

    /**
     * Classify event for timeline coloring
     */
    static classifyEvent(eventType) {
        const categories = {
            'session.update': 'session',
            'session.created': 'session',
            'session.updated': 'session',
            'input_audio_buffer.append': 'audio-input',
            'input_audio_buffer.speech_started': 'vad',
            'input_audio_buffer.speech_stopped': 'vad',
            'input_audio_buffer.committed': 'vad',
            'conversation.item.input_audio_transcription.completed': 'transcription',
            'conversation.item.created': 'conversation',
            'conversation.item.truncate': 'truncate',
            'response.created': 'response',
            'response.output_item.added': 'response',
            'response.content_part.added': 'response',
            'response.audio_transcript.delta': 'transcript-delta',
            'response.audio_transcript.done': 'transcript-done',
            'response.audio.delta': 'audio-output',
            'response.audio.done': 'audio-done',
            'response.content_part.done': 'response',
            'response.output_item.done': 'response',
            'response.done': 'response-done',
            'response.cancel': 'cancel',
            'error': 'error',
        };
        return categories[eventType] || 'other';
    }

    // ── Utility methods ──

    static _tsToMs(ts) {
        if (ts == null) return 0;
        if (typeof ts === 'number') {
            return ts > 1e12 ? ts : ts * 1000;
        }
        if (typeof ts === 'string') {
            try {
                return new Date(ts.replace('Z', '+00:00')).getTime();
            } catch {
                return 0;
            }
        }
        return 0;
    }

    static formatTimestamp(ts) {
        if (ts == null) return 'N/A';
        const ms = this._tsToMs(ts);
        if (ms === 0) return 'N/A';
        const d = new Date(ms);
        return d.toISOString().substring(11, 23); // HH:MM:SS.mmm
    }

    static _formatDuration(ms) {
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    }

    /**
     * Get a short display for an event's key info
     */
    static getEventSummary(msg) {
        const { eventType: et, event: ev } = msg;
        switch (et) {
            case 'session.created':
                return `session=${ev.session?.id?.substring(0, 25) || ''}`;
            case 'session.updated':
                return 'Config confirmed';
            case 'session.update':
                return 'Config update sent';
            case 'response.created':
                return `id=${ev.response?.id?.substring(0, 20) || ''} status=${ev.response?.status || ''}`;
            case 'response.done': {
                const r = ev.response || {};
                const u = r.usage || {};
                return `${r.status} | out_tokens=${u.output_tokens || 0}`;
            }
            case 'input_audio_buffer.speech_started':
                return `🎙️ VAD detected speech | item=${ev.item_id?.substring(0, 20) || ''}`;
            case 'input_audio_buffer.speech_stopped':
                return `🔇 audio_end_ms=${ev.audio_end_ms || ''}`;
            case 'input_audio_buffer.committed':
                return `item=${ev.item_id?.substring(0, 20) || ''}`;
            case 'conversation.item.input_audio_transcription.completed':
                return `📝 "${(ev.transcript || '').substring(0, 60)}"`;
            case 'response.audio_transcript.done':
                return `🔊 "${(ev.transcript || '').substring(0, 60)}"`;
            case 'response.cancel':
                return '⚠️ Client cancellation';
            case 'conversation.item.truncate':
                return `✂️ truncate item=${ev.item_id?.substring(0, 20) || ''}`;
            case 'error':
                return `❌ ${ev.error?.type || ''}: ${(ev.error?.message || '').substring(0, 50)}`;
            case 'input_audio_buffer.append':
                return `audio chunk (${ev.audio?.length || 0} chars)`;
            case 'response.audio.delta':
                return `audio data (${ev.delta?.length || 0} chars)`;
            case 'response.audio_transcript.delta':
                return `"${(ev.delta || '').substring(0, 40)}"`;
            case 'conversation.item.created': {
                const item = ev.item || {};
                return `role=${item.role || ''} type=${item.type || ''}`;
            }
            default:
                return '';
        }
    }

    /**
     * Sanitize event for display (truncate large payloads)
     */
    static sanitizeEvent(event) {
        const sanitized = { ...event };
        if (sanitized.audio && typeof sanitized.audio === 'string' && sanitized.audio.length > 80) {
            sanitized.audio = sanitized.audio.substring(0, 40) + `...<${event.audio.length} chars>`;
        }
        if (sanitized.delta && typeof sanitized.delta === 'string' && sanitized.delta.length > 200) {
            sanitized.delta = sanitized.delta.substring(0, 80) + `...<${event.delta.length} chars>`;
        }
        // Strip bearer tokens from display
        if (sanitized.authorization && typeof sanitized.authorization === 'string') {
            sanitized.authorization = sanitized.authorization.substring(0, 20) + '...[REDACTED]';
        }
        return sanitized;
    }
}
