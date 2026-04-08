---
name: har2md
description: Voice Live / Realtime API 的 HAR 文件分析工具集。包含浏览器可视化（Swim Lane 时间线 + Minimap）和 CLI 转 Markdown 两种方式。用于调查语音截断、VAD 误判、AEC 失效、取消率异常等问题。
---

# HAR 分析工具集 — Voice Live / Realtime API

## 工具总览

| 工具 | 形式 | 用途 | 路径 |
|------|------|------|------|
| **HAR Visualizer** | 浏览器 SPA | 交互式可视化（Swim Lane 时间线、Minimap、事件过滤） | `index.html` |
| **har_to_md.py** | Python CLI | HAR → 结构化 Markdown 报告（存档 / Copilot 分析） | `har_to_md.py` |

## 何时使用

当客户提供了浏览器 HAR (HTTP Archive) 文件，需要分析 Voice Live 或 Realtime API 的 WebSocket 事件时：
- 语音播报被截断 / 提前结束
- VAD（语音活动检测）误触发
- 回声消除 (AEC) 失效导致自打断
- 需要确认 session 配置、模型、voice 等参数
- 需要查看对话转写内容
- 需要统计 response 完成/取消比例

## 工具 1：HAR Visualizer（浏览器可视化）

### 启动

```bash
cd project/har-visualization
python -m http.server 8066
# 打开 http://localhost:8066
```

### 功能

- **Overview** — 连接参数、Session 配置、统计总览、诊断告警
- **Timeline** — 8 条 Swim Lane + Minimap 全局导航 + 1x–200x 缩放
- **Conversation** — 聊天气泡视图（用户 + Agent + 取消标记）
- **Responses** — Response 生命周期表（Duration / Tokens / audio.done / speech 打断）
- **Event Log** — 可切换高频事件、点击查看 JSON、可拖拽调整列宽

## 工具 2：har_to_md.py（CLI）

### 用法

```bash
# 基本用法 — 输出同名 .md 文件
python har_to_md.py customer_capture.har

# 指定输出
python har_to_md.py customer_capture.har --output analysis.md

# 完整 Raw 事件 dump（audio payload 截断至 40 字符）
python har_to_md.py customer_capture.har --raw

# 仅分析指定 session
python har_to_md.py customer_capture.har --session-id sess_xxx
```

**无外部依赖**，仅使用 Python 标准库。

### 输出报告包含

| 模块 | 内容 |
|------|------|
| 连接参数 | WebSocket URL, api-version, model, agent-name |
| Session 配置 | VAD 类型/参数、AEC、降噪、Voice、Rate、Transcription model |
| 统计总览 | 总事件数、Response 完成/取消数、取消率、VAD 触发次数 |
| Response 生命周期 | ID、状态、异常模式检测（AEC 打断 / 音频截断） |
| 对话流 | 用户输入 + Agent 回复 |
| 事件时间线 | 过滤 audio delta 后的关键事件流 |
| 诊断建议 | 基于统计自动生成 |

## 典型工作流

```
1. 客户提供 HAR 文件
   └─ 浏览器 DevTools → Network → 右键 → Save all as HAR with content

2. 快速交互分析 → Visualizer
   └─ python -m http.server 8066 → 上传 HAR → Timeline + Responses

3. 存档报告 → har_to_md.py
   └─ python har_to_md.py customer.har
   └─ --raw 模式可供 Copilot/Claude 深入分析

4. 结合 Kusto 后端日志
   ├─ session_id → TraceCallResult (cogsvc)
   ├─ response_id → VoiceLive_ResponseDone
   └─ 对比前后端事件时间差
```

## HAR 获取方法（给客户）

### Chrome / Edge
1. F12 → Network
2. 使用 Voice Live 对话
3. 右键 → **Save all as HAR with content**

### Firefox
1. F12 → Network → 齿轮 → **Save All as HAR**

> ⚠️ HAR 可能含 Bearer token，提醒客户脱敏。大文件建议压缩发送。

## 关键事件参考

| 事件 | 方向 | 含义 |
|------|------|------|
| `input_audio_buffer.speech_started` | server→client | VAD 检测到说话 |
| `input_audio_buffer.speech_stopped` | server→client | VAD 检测到静音 |
| `response.cancel` | client→server | 客户端主动取消 |
| `conversation.item.truncate` | client→server | 截断未播放音频 |
| `response.done` (status=cancelled) | server→client | 回复取消确认 |

## 诊断模式

| 模式 | 表现 | 可能原因 |
|------|------|---------|
| speech_started 紧跟 audio.delta | VAD 在 Agent 说话时触发 | AEC 失效 / 回声 |
| 大量 0-token cancelled | 模型没开口就被取消 | VAD 过灵敏 / 噪音 |
| 高 token cancelled | 长句说一半被截断 | 用户打断 / AEC 延迟 |
| speech_started >> response 数 | VAD 过度触发 | 设备问题 / 无 AEC |
| transcript.done 无 audio.done | 服务端音频截断 | Backend 问题 |
