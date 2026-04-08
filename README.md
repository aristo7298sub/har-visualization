# Voice Live HAR Visualizer

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

Browser-based visualization tool for analyzing **Voice Live / Realtime API** WebSocket sessions captured in HAR files. Includes a CLI script for converting HAR to Markdown reports.

### Prerequisites

- **Python 3** (any version, for local HTTP server)
- **Browser** (Chrome / Edge recommended)
- No other dependencies required

### Quick Start

**Windows** — double-click `start.bat`

**macOS / Linux**:
```bash
chmod +x start.sh
./start.sh
```

**Or manually**:
```bash
cd project/har-visualization
python -m http.server 8066
# Open http://localhost:8066
```

The browser will open automatically. Drop a `.har` file to start analyzing.

### Features

- **Session Overview** — Connection parameters, session config, statistics, agent info
- **Interactive Timeline** — 8 swim lanes with minimap navigation, 1x–200x zoom
- **Conversation Flow** — Chat-style view of user/agent transcripts with cancelled responses
- **Response Analysis** — Lifecycle table (tokens, duration, audio.done, speech interruptions)
- **Event Log** — Filterable event list with JSON detail inspection, resizable columns
- **Diagnostic Alerts** — Automated anomaly detection (high cancel rate, AEC issues, audio truncation)
- **Privacy** — 100% client-side processing. No data leaves your browser.

### HAR → Markdown CLI

For offline/archival analysis:

```bash
python har_to_md.py customer_capture.har              # → customer_capture.md
python har_to_md.py customer_capture.har --raw         # Full raw event dump
python har_to_md.py customer_capture.har -o report.md  # Custom output path
```

### How to Capture HAR Files

#### Chrome / Edge
1. Press F12 → DevTools → **Network** tab
2. Use Voice Live / Realtime API session
3. Right-click in the Network panel → **Save all as HAR with content**

#### Firefox
1. F12 → Network → Gear icon → **Save All as HAR**

⚠️ **Security**: HAR files may contain Bearer tokens and sensitive data. Review before sharing.

### Project Structure

```
har-visualization/
├── start.bat           # One-click start (Windows)
├── start.sh            # One-click start (macOS/Linux)
├── index.html          # Single-page app entry
├── har_to_md.py        # CLI: HAR → Markdown report (zero dependencies)
├── SKILL.md            # Usage guide, diagnostics, event reference
├── README.md           # This file
├── css/
│   └── style.css       # Light theme styles
├── js/
│   ├── app.js          # File upload & init
│   ├── har-parser.js   # HAR → structured data
│   └── visualizer.js   # Renders all views
└── .claude/skills/har2md/
    └── SKILL.md         # Claude/Copilot skill definition
```

### Key Event Types

| Event                               | Direction     | Meaning                           |
| ----------------------------------- | ------------- | --------------------------------- |
| `input_audio_buffer.speech_started` | server→client | VAD detected user speech          |
| `input_audio_buffer.speech_stopped` | server→client | VAD detected silence              |
| `response.created`                  | server→client | Model started generating response |
| `response.done`                     | server→client | Response completed or cancelled   |
| `response.cancel`                   | client→server | Client explicitly cancelled       |
| `conversation.item.truncate`        | client→server | Client truncated unplayed audio   |

### Diagnostic Patterns

| Pattern                                    | Indicator           | Likely Cause                 |
| ------------------------------------------ | ------------------- | ---------------------------- |
| speech_started during response.audio.delta | AEC failure         | Echo feeding back to VAD     |
| Many 0-token cancelled responses           | VAD oversensitivity | Ambient noise, no AEC        |
| High-token cancelled responses             | User barge-in       | Normal behavior or AEC delay |
| transcript.done but no audio.done          | Server truncation   | Backend issue                |

---

<a id="中文"></a>

## 中文

基于浏览器的可视化工具，用于分析 **Voice Live / Realtime API** 的 WebSocket 会话（HAR 文件）。同时包含 CLI 脚本，可将 HAR 转为 Markdown 报告。

### 前置条件

- **Python 3**（任意版本，用于本地 HTTP 服务器）
- **浏览器**（推荐 Chrome / Edge）
- 无需安装任何依赖

### 快速启动

**Windows** — 双击 `start.bat`

**macOS / Linux**：
```bash
chmod +x start.sh
./start.sh
```

**或手动运行**：
```bash
cd project/har-visualization
python -m http.server 8066
# 打开 http://localhost:8066
```

浏览器会自动打开，拖入 `.har` 文件即可开始分析。

### 功能

- **Session 总览** — 连接参数、Session 配置、统计数据、Agent 信息
- **交互式时间线** — 8 条 Swim Lane + Minimap 导航 + 1x–200x 缩放
- **对话流** — 聊天气泡视图（用户输入 + Agent 回复 + 取消标记）
- **Response 分析** — 生命周期表（Duration / Tokens / audio.done / speech 打断）
- **Event Log** — 可过滤事件列表，JSON 详情查看，可拖拽调整列宽
- **诊断告警** — 自动异常检测（高取消率、AEC 问题、音频截断）
- **隐私安全** — 100% 浏览器端处理，数据不离开本地

### HAR 转 Markdown（CLI）

用于离线分析和存档：

```bash
python har_to_md.py customer_capture.har              # → customer_capture.md
python har_to_md.py customer_capture.har --raw         # 完整 Raw 事件 dump
python har_to_md.py customer_capture.har -o report.md  # 指定输出路径
```

### 如何获取 HAR 文件

#### Chrome / Edge
1. 按 F12 → DevTools → **Network** 标签页
2. 使用 Voice Live 进行对话
3. 右键 Network 面板 → **Save all as HAR with content**

#### Firefox
1. F12 → Network → 齿轮图标 → **Save All as HAR**

⚠️ **安全提示**：HAR 文件可能包含 Bearer Token 等敏感信息，分享前请检查脱敏。

### 诊断模式

| 模式                                     | 表现                    | 可能原因                |
| ---------------------------------------- | ----------------------- | ----------------------- |
| speech_started 紧跟 response.audio.delta | VAD 在 Agent 说话时触发 | AEC 失效 / 回声         |
| 大量 0-token 的 cancelled                | 模型没开口就被取消      | VAD 过于灵敏 / 环境噪音 |
| 高 token 的 cancelled                    | 长句说到一半被截断      | 用户打断或 AEC 延迟     |
| transcript.done 但无 audio.done          | 服务端音频截断          | Backend 问题            |
