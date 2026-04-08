"""
Voice Live HAR → Markdown 分析转换器
用途：将浏览器 HAR（HTTP Archive）文件中的 Voice Live WebSocket 事件转为结构化 Markdown

依赖：无（仅标准库）

用法：
    python har_to_md.py <input.har> [--output report.md] [--session-id <sid>]
    python har_to_md.py customer_capture.har
    python har_to_md.py customer_capture.har --output analysis.md
    python har_to_md.py customer_capture.har --session-id sess_xxx

输出：
    - 会话摘要（session_id, 时长, response 数量, 取消率）
    - 完整事件时间线（按时间排序）
    - 取消/截断事件高亮
    - VAD speech_started / speech_stopped 统计
    - 诊断建议

注意：本脚本为支持工程师诊断用，代码仅供参考，请自行验证。
"""

import json
import sys
import argparse
import os
from datetime import datetime, timezone
from collections import defaultdict


def load_har(filepath: str) -> dict:
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


def extract_ws_messages(har: dict) -> list[dict]:
    """从 HAR 中提取 WebSocket 消息"""
    messages = []

    for entry in har.get("log", {}).get("entries", []):
        # 检查是否是 WebSocket 连接（voice-live/realtime 或 openai/realtime）
        url = entry.get("request", {}).get("url", "")
        if "voice-live/realtime" not in url and "openai/realtime" not in url:
            continue

        # 提取 URL 中的参数
        ws_url = url
        ws_params = {}
        if "?" in url:
            param_str = url.split("?", 1)[1]
            for p in param_str.split("&"):
                if "=" in p:
                    k, v = p.split("=", 1)
                    ws_params[k] = v

        # 提取 websocket 消息
        ws_msgs = entry.get("_webSocketMessages", [])
        if not ws_msgs:
            # Chrome 格式
            ws_msgs = entry.get("response", {}).get("content", {}).get("_webSocketMessages", [])

        for msg in ws_msgs:
            data = msg.get("data", "")
            if not data:
                continue

            try:
                event = json.loads(data)
            except (json.JSONDecodeError, TypeError):
                continue

            ts = msg.get("time")  # epoch ms 或 ISO string
            opcode = msg.get("opcode", msg.get("type", 0))
            # opcode 1 = text, 2 = binary; type: "send" / "receive"
            direction = "send" if msg.get("type") == "send" or opcode == 1 and msg.get("type") == "send" else "receive"
            if "type" in msg and msg["type"] in ("send", "receive"):
                direction = msg["type"]

            messages.append({
                "timestamp": ts,
                "direction": direction,
                "event": event,
                "event_type": event.get("type", "unknown"),
                "ws_url": ws_url,
                "ws_params": ws_params,
            })

    # 按时间排序
    def sort_key(m):
        ts = m["timestamp"]
        if ts is None:
            return 0
        if isinstance(ts, (int, float)):
            return ts
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except Exception:
            return 0

    messages.sort(key=sort_key)
    return messages


def analyze_messages(messages: list[dict]) -> dict:
    """分析事件流，生成统计数据"""
    stats = {
        "total_events": len(messages),
        "sent_events": 0,
        "received_events": 0,
        "sessions": {},
        "responses": defaultdict(lambda: {
            "status": "", "output_tokens": 0, "audio_tokens": 0, "text_tokens": 0,
            "created_ts": None, "done_ts": None, "reason": "",
            "audio_deltas": 0, "transcript_deltas": 0,
            "audio_done": False, "transcript_done": False,
            "transcript_text": "",
            "speech_started_during": False, "speech_started_ts": None,
        }),
        "vad_speech_start": 0,
        "vad_speech_stop": 0,
        "cancel_events": 0,
        "truncate_events": 0,
        "transcripts": [],
        "conversation_flow": [],  # [{"role": "user"/"agent", "text": ..., "status": ...}]
        "errors": [],
        "session_config": None,
        "ws_url": "",
        "ws_params": {},
        "_current_resp": None,
    }

    if messages:
        stats["ws_url"] = messages[0].get("ws_url", "")
        stats["ws_params"] = messages[0].get("ws_params", {})

    for msg in messages:
        d = msg["direction"]
        et = msg["event_type"]
        ev = msg["event"]

        if d == "send":
            stats["sent_events"] += 1
        else:
            stats["received_events"] += 1

        # Session 配置
        if et == "session.update":
            stats["session_config"] = ev.get("session", {})

        elif et == "session.created":
            session = ev.get("session", {})
            sid = session.get("id", "")
            stats["sessions"][sid] = {
                "id": sid,
                "model": session.get("model", ""),
                "created_ts": msg["timestamp"],
            }

        elif et == "session.updated":
            session = ev.get("session", {})
            if not stats["session_config"]:
                stats["session_config"] = session

        # Response 追踪
        elif et == "response.created":
            resp = ev.get("response", {})
            rid = resp.get("id", "")
            stats["_current_resp"] = rid
            stats["responses"][rid]["status"] = resp.get("status", "in_progress")
            stats["responses"][rid]["created_ts"] = msg["timestamp"]

        elif et == "response.audio.delta":
            rid = stats["_current_resp"]
            if rid:
                stats["responses"][rid]["audio_deltas"] += 1

        elif et == "response.audio_transcript.delta":
            rid = stats["_current_resp"]
            if rid:
                stats["responses"][rid]["transcript_deltas"] += 1

        elif et == "response.audio.done":
            rid = stats["_current_resp"]
            if rid:
                stats["responses"][rid]["audio_done"] = True

        elif et == "response.audio_transcript.done":
            rid = stats["_current_resp"]
            if rid:
                stats["responses"][rid]["transcript_done"] = True
                stats["responses"][rid]["transcript_text"] = ev.get("transcript", "")
            t = ev.get("transcript", "")
            if t:
                stats["transcripts"].append(f"[Agent] {t}")
                stats["conversation_flow"].append({"role": "agent", "text": t, "status": "completed", "response_id": rid})

        elif et == "response.done":
            resp = ev.get("response", {})
            rid = resp.get("id", "")
            stats["responses"][rid]["status"] = resp.get("status", "")
            stats["responses"][rid]["done_ts"] = msg["timestamp"]
            sd = resp.get("status_details") or {}
            stats["responses"][rid]["reason"] = sd.get("reason", "")
            usage = resp.get("usage", {})
            out_details = usage.get("output_token_details", {})
            stats["responses"][rid]["output_tokens"] = usage.get("output_tokens", 0)
            stats["responses"][rid]["audio_tokens"] = out_details.get("audio_tokens", 0)
            stats["responses"][rid]["text_tokens"] = out_details.get("text_tokens", 0)
            if resp.get("status") == "cancelled":
                stats["conversation_flow"].append({"role": "agent", "text": "(cancelled)", "status": "cancelled", "reason": sd.get("reason",""), "response_id": rid})
            stats["_current_resp"] = None

        # VAD
        elif et == "input_audio_buffer.speech_started":
            stats["vad_speech_start"] += 1
            rid = stats["_current_resp"]
            if rid:
                stats["responses"][rid]["speech_started_during"] = True
                stats["responses"][rid]["speech_started_ts"] = msg["timestamp"]

        elif et == "input_audio_buffer.speech_stopped":
            stats["vad_speech_stop"] += 1

        # 取消 / 截断
        elif et == "response.cancel":
            stats["cancel_events"] += 1

        elif et == "conversation.item.truncate":
            stats["truncate_events"] += 1

        # 转写
        elif et == "conversation.item.input_audio_transcription.completed":
            t = ev.get("transcript", "")
            if t:
                stats["transcripts"].append(t)
                stats["conversation_flow"].append({"role": "user", "text": t})
            else:
                stats["conversation_flow"].append({"role": "user", "text": "(empty transcript)"})

        elif et == "response.audio_transcript.done":
            pass  # handled above in response tracking

        # 错误
        elif et == "error":
            stats["errors"].append(ev.get("error", {}))

    return stats


def format_timestamp(ts) -> str:
    if ts is None:
        return "N/A"
    if isinstance(ts, (int, float)):
        if ts > 1e12:
            ts = ts / 1000
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%H:%M:%S.%f")[:-3]
    return str(ts)


def generate_markdown(messages: list[dict], stats: dict, har_filename: str, raw: bool = False) -> str:
    """生成 Markdown 报告"""
    lines = []
    lines.append(f"# Voice Live HAR 分析报告")
    lines.append(f"")
    lines.append(f"- **源文件**: `{har_filename}`")
    lines.append(f"- **分析时间**: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    lines.append(f"- **WebSocket URL**: `{stats['ws_url']}`")
    lines.append(f"")

    # URL 参数
    if stats["ws_params"]:
        lines.append(f"## 连接参数")
        lines.append(f"")
        lines.append(f"| 参数 | 值 |")
        lines.append(f"|------|-----|")
        for k, v in stats["ws_params"].items():
            lines.append(f"| `{k}` | `{v}` |")
        lines.append(f"")

    # Session 配置
    if stats["session_config"]:
        lines.append(f"## Session 配置")
        lines.append(f"")
        cfg = stats["session_config"]

        td = cfg.get("turn_detection", {})
        voice = cfg.get("voice", {})
        aec = cfg.get("input_audio_echo_cancellation", {})
        ns = cfg.get("input_audio_noise_reduction", {})
        txn = cfg.get("input_audio_transcription", {})

        lines.append(f"| 配置 | 值 |")
        lines.append(f"|------|-----|")
        lines.append(f"| Modalities | `{cfg.get('modalities', [])}` |")
        lines.append(f"| VAD Type | `{td.get('type', 'N/A')}` |")
        lines.append(f"| silence_duration_ms | `{td.get('silence_duration_ms', 'N/A')}` |")
        lines.append(f"| prefix_padding_ms | `{td.get('prefix_padding_ms', 'N/A')}` |")
        lines.append(f"| remove_filler_words | `{td.get('remove_filler_words', 'N/A')}` |")
        lines.append(f"| threshold | `{td.get('threshold', 'N/A')}` |")
        lines.append(f"| auto_truncate | `{td.get('auto_truncate', 'N/A')}` |")
        lines.append(f"| interrupt_response | `{td.get('interrupt_response', 'N/A')}` |")
        lines.append(f"| Echo Cancellation | `{aec.get('type', 'N/A')}` |")
        lines.append(f"| Noise Reduction | `{ns.get('type', 'N/A')}` |")
        lines.append(f"| Voice | `{voice.get('name', 'N/A')}` (`{voice.get('type', '')}`) |")
        lines.append(f"| Rate | `{voice.get('rate', 'N/A')}` |")
        lines.append(f"| Temperature | `{voice.get('temperature', 'N/A')}` |")
        lines.append(f"| Transcription Model | `{txn.get('model', 'N/A')}` |")
        lines.append(f"")

    # 总览统计
    lines.append(f"## 统计总览")
    lines.append(f"")

    total_resp = len(stats["responses"])
    cancelled = sum(1 for r in stats["responses"].values() if r["status"] == "cancelled")
    completed = sum(1 for r in stats["responses"].values() if r["status"] == "completed")
    cancel_rate = (cancelled / total_resp * 100) if total_resp > 0 else 0

    lines.append(f"| 指标 | 值 |")
    lines.append(f"|------|-----|")
    lines.append(f"| 总事件数 | {stats['total_events']} |")
    lines.append(f"| 发送 (client→server) | {stats['sent_events']} |")
    lines.append(f"| 接收 (server→client) | {stats['received_events']} |")
    lines.append(f"| Response 总数 | {total_resp} |")
    lines.append(f"| ✅ Completed | {completed} |")
    lines.append(f"| ❌ Cancelled | {cancelled} |")
    lines.append(f"| 🔴 取消率 | **{cancel_rate:.1f}%** |")
    lines.append(f"| VAD speech_started | {stats['vad_speech_start']} |")
    lines.append(f"| VAD speech_stopped | {stats['vad_speech_stop']} |")
    lines.append(f"| 客户端 response.cancel | {stats['cancel_events']} |")
    lines.append(f"| 客户端 item.truncate | {stats['truncate_events']} |")
    lines.append(f"| 错误事件 | {len(stats['errors'])} |")
    lines.append(f"")

    # Response 详情
    if stats["responses"]:
        lines.append(f"## Response 生命周期分析")
        lines.append(f"")
        lines.append(f"| # | Response ID | 状态 | 原因 | Audio Deltas | Transcript Deltas | audio.done | transcript.done | speech_started 打断 | Output Tokens |")
        lines.append(f"|---|------------|------|------|------|------|------|------|------|------|")
        anomalies = []
        for i, (rid, r) in enumerate(stats["responses"].items(), 1):
            status_icon = "✅" if r["status"] == "completed" else "❌" if r["status"] == "cancelled" else "⏳"
            rid_short = rid[:25] + "…" if len(rid) > 25 else rid
            speech_flag = "🔴 YES" if r["speech_started_during"] else ""
            lines.append(f"| {i} | `{rid_short}` | {status_icon} {r['status']} | {r.get('reason','')} | {r['audio_deltas']} | {r['transcript_deltas']} | {r['audio_done']} | {r['transcript_done']} | {speech_flag} | {r['output_tokens']} |")

            # 异常检测
            if r["status"] == "completed" and r["speech_started_during"]:
                anomalies.append(f"- ⚠️ **Response #{i}** (`{rid_short}`): 回复期间 speech_started 被触发 — 如果客户端在此时停止音频播放，用户会听到截断")
            if r["status"] == "completed" and r["transcript_done"] and not r["audio_done"]:
                anomalies.append(f"- 🔴 **Response #{i}** (`{rid_short}`): transcript.done 但 **audio.done 未触发** — 音频流可能被截断！")
            if r["status"] == "cancelled" and r["audio_deltas"] > 0:
                anomalies.append(f"- 🔴 **Response #{i}** (`{rid_short}`): cancelled 但已发送 {r['audio_deltas']} 个 audio delta — 用户已听到部分内容后被截断")
            if r["status"] == "cancelled" and r["audio_deltas"] == 0 and r.get("reason") == "turn_detected":
                anomalies.append(f"- ℹ️ **Response #{i}** (`{rid_short}`): 正常 barge-in（用户继续说话，VAD 取消了尚未开始的回复）")
        lines.append(f"")

        if anomalies:
            lines.append(f"### 异常模式检测")
            lines.append(f"")
            for a in anomalies:
                lines.append(a)
            lines.append(f"")

    # 对话流视图
    if stats["conversation_flow"]:
        lines.append(f"## 对话流")
        lines.append(f"")
        for item in stats["conversation_flow"]:
            role = item["role"]
            text = item["text"]
            if role == "user":
                lines.append(f"**🧑 User**: {text}")
            elif role == "agent":
                status = item.get("status", "")
                rid_short = item.get("response_id", "")[:20]
                if status == "cancelled":
                    reason = item.get("reason", "")
                    lines.append(f"**🤖 Agent**: ❌ *cancelled* (reason: {reason}) `{rid_short}`")
                else:
                    preview = text[:120] + "…" if len(text) > 120 else text
                    lines.append(f"**🤖 Agent**: ✅ {preview}")
            lines.append(f"")

    # 转写内容（保留旧格式以兼容）
    if stats["transcripts"]:
        lines.append(f"## 完整转写记录")
        lines.append(f"")
        for i, t in enumerate(stats["transcripts"], 1):
            lines.append(f"{i}. {t}")
        lines.append(f"")

    # 错误
    if stats["errors"]:
        lines.append(f"## 错误事件")
        lines.append(f"")
        for err in stats["errors"]:
            lines.append(f"- **{err.get('type', 'unknown')}**: {err.get('message', 'N/A')}")
        lines.append(f"")

    # ── Raw event dump（--raw 模式）──────────────────────────────────
    if raw:
        lines.append(f"## Raw 事件数据")
        lines.append(f"")
        lines.append(f"> 完整 raw dump，仅对 `audio` 字段做截断（前 40 字符）")
        lines.append(f"")
        for i, msg in enumerate(messages, 1):
            ts_str = format_timestamp(msg["timestamp"])
            direction = "← SEND" if msg["direction"] == "send" else "→ RECV"
            et = msg["event_type"]
            ev = dict(msg["event"])
            # 截断 audio payload
            if "audio" in ev and isinstance(ev["audio"], str) and len(ev["audio"]) > 40:
                ev["audio"] = ev["audio"][:40] + f"...<{len(msg['event']['audio'])} chars>"
            if "delta" in ev and isinstance(ev["delta"], str) and len(ev["delta"]) > 40:
                ev["delta"] = ev["delta"][:40] + f"...<{len(msg['event']['delta'])} chars>"
            lines.append(f"### [{i}] {ts_str} {direction} `{et}`")
            lines.append(f"")
            lines.append(f"```json")
            lines.append(json.dumps(ev, ensure_ascii=False, indent=2))
            lines.append(f"```")
            lines.append(f"")
        return "\n".join(lines)

    # ── 关键事件时间线（过滤模式）──────────────────────────────────
    SKIP_TYPES = {
        "input_audio_buffer.append",
        "response.audio.delta",
        "response.audio_transcript.delta",
        "response.content_part.delta",
        "response.text.delta",
    }

    lines.append(f"## 事件时间线")
    lines.append(f"")
    lines.append(f"> 已过滤 `input_audio_buffer.append` 和 `*.delta` 等高频事件")
    lines.append(f"")
    lines.append(f"| 时间 (UTC) | 方向 | 事件类型 | 关键信息 |")
    lines.append(f"|------------|------|----------|----------|")

    for msg in messages:
        et = msg["event_type"]
        if et in SKIP_TYPES:
            continue

        ts_str = format_timestamp(msg["timestamp"])
        direction = "→ recv" if msg["direction"] == "receive" else "← send"
        ev = msg["event"]

        # 提取关键信息
        info = ""
        if et == "session.created":
            s = ev.get("session", {})
            info = f"session_id=`{s.get('id', '')[:30]}`"
        elif et == "response.created":
            r = ev.get("response", {})
            info = f"id=`{r.get('id', '')[:25]}` status={r.get('status', '')}"
        elif et == "response.done":
            r = ev.get("response", {})
            u = r.get("usage", {})
            info = f"**{r.get('status', '')}** out_tokens={u.get('output_tokens', 0)}"
        elif et == "input_audio_buffer.speech_started":
            info = f"🎙️ VAD detected speech, item=`{ev.get('item_id', '')[:25]}`"
        elif et == "input_audio_buffer.speech_stopped":
            info = f"🔇 audio_end_ms={ev.get('audio_end_ms', '')}"
        elif et == "response.cancel":
            info = "⚠️ **客户端主动取消**"
        elif et == "conversation.item.truncate":
            info = f"✂️ truncate item=`{ev.get('item_id', '')[:25]}`"
        elif et == "error":
            e = ev.get("error", {})
            info = f"❌ {e.get('type', '')}: {e.get('message', '')[:60]}"
        elif et == "session.update":
            info = "配置更新"
        elif et == "session.updated":
            info = "配置已确认"
        elif et == "conversation.item.input_audio_transcription.completed":
            info = f"📝 `{ev.get('transcript', '')[:50]}`"
        elif et == "response.audio_transcript.done":
            info = f"🔊 `{ev.get('transcript', '')[:50]}`"
        elif et == "input_audio_buffer.committed":
            info = f"item=`{ev.get('item_id', '')[:25]}`"
        elif et == "conversation.item.created":
            item = ev.get("item", {})
            info = f"role={item.get('role', '')} type={item.get('type', '')}"

        # 高亮取消相关事件
        highlight = ""
        if et in ("response.cancel", "conversation.item.truncate") or (et == "response.done" and ev.get("response", {}).get("status") == "cancelled"):
            highlight = " 🔴"

        lines.append(f"| {ts_str} | {direction} | `{et}` | {info}{highlight} |")

    lines.append(f"")

    # 诊断建议
    lines.append(f"## 诊断建议")
    lines.append(f"")
    if cancel_rate > 30:
        lines.append(f"- 🔴 **取消率 {cancel_rate:.1f}% 偏高** — 建议检查 VAD 配置、终端用户声学环境、AEC 时序")
    if stats["vad_speech_start"] > total_resp * 2:
        lines.append(f"- ⚠️ **speech_started 触发频繁** ({stats['vad_speech_start']} 次 vs {total_resp} 次回复) — 可能存在回声反馈或环境噪音")
    if stats["truncate_events"] == 0 and cancelled > 0:
        lines.append(f"- ⚠️ **有取消但无 auto_truncate** — 对话历史可能与用户实际听到内容不一致，建议开启 `auto_truncate: true`")
    # 音频截断但文本完整的检测
    speech_during_completed = sum(1 for r in stats["responses"].values() if r["status"] == "completed" and r["speech_started_during"])
    if speech_during_completed > 0:
        lines.append(f"- ⚠️ **{speech_during_completed} 个 completed response 期间触发了 speech_started** — 客户端可能在 VAD 触发时停止音频播放（音频截断但文本完整的典型模式）")
    audio_incomplete = sum(1 for r in stats["responses"].values() if r["status"] == "completed" and r["transcript_done"] and not r["audio_done"])
    if audio_incomplete > 0:
        lines.append(f"- 🔴 **{audio_incomplete} 个 response 文本完成但音频未完成 (audio.done=False)** — 服务端音频流被截断")
    if not stats["errors"] and cancel_rate < 10 and speech_during_completed == 0:
        lines.append(f"- ✅ 本次会话无明显异常")
    if stats["errors"]:
        lines.append(f"- ❌ 发现 {len(stats['errors'])} 个错误事件，需进一步分析")
    lines.append(f"")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Voice Live HAR → Markdown 分析工具")
    parser.add_argument("input", help="HAR 文件路径")
    parser.add_argument("--output", "-o", default=None, help="输出 MD 文件路径（默认与输入同名 .md）")
    parser.add_argument("--session-id", default=None, help="仅分析指定 session_id 的事件")
    parser.add_argument("--raw", action="store_true", help="输出完整 raw 事件数据（不过滤，仅截断 audio payload）")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"错误：文件不存在 — {args.input}")
        sys.exit(1)

    output_path = args.output or os.path.splitext(args.input)[0] + ".md"

    print(f"读取 HAR: {args.input}")
    har = load_har(args.input)

    print("提取 WebSocket 事件…")
    messages = extract_ws_messages(har)
    print(f"  找到 {len(messages)} 条事件")

    if not messages:
        print("未找到 Voice Live WebSocket 事件。请确认 HAR 文件包含 voice-live/realtime 连接。")
        sys.exit(1)

    # 按 session_id 过滤
    if args.session_id:
        filtered = []
        for msg in messages:
            ev = msg["event"]
            sid = ev.get("session", {}).get("id", "") or ev.get("session_id", "")
            # 也从 ExtraData 或通用字段检查
            if sid == args.session_id:
                filtered.append(msg)
                continue
            # 保留所有非 session 绑定的事件（如 session.update）
            if msg["event_type"] in ("session.update", "session.created", "session.updated"):
                filtered.append(msg)
        if filtered:
            messages = filtered
            print(f"  按 session_id={args.session_id} 过滤后剩余 {len(messages)} 条")

    print("分析事件…")
    stats = analyze_messages(messages)

    print("生成报告…")
    md = generate_markdown(messages, stats, os.path.basename(args.input), raw=args.raw)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(md)

    print(f"✓ 报告已生成: {output_path}")
    print(f"  总事件: {stats['total_events']}, Response: {len(stats['responses'])}, "
          f"取消: {sum(1 for r in stats['responses'].values() if r['status'] == 'cancelled')}")


if __name__ == "__main__":
    main()
