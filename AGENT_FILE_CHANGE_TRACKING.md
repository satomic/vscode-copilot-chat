# Agent File Change Tracking Feature

## 概述

这个功能为VS Code Copilot Chat扩展添加了agent模式下的文件修改统计功能。当agent进行文件修改时，系统会自动：

1. 在OUTPUT中打印增加和删除的行数统计
2. 生成JSON文件记录当前agent会话的修改统计信息

## 功能特性

### 1. 实时统计显示
- 在每次agent调用结束后，如果进行了文件修改，会在OUTPUT中显示：
  - 总文件修改数量
  - 总增加行数 (+X)
  - 总删除行数 (-Y)
  - 净变化行数
  - 每个文件的详细修改信息

### 2. JSON统计文件
- 自动在 `.vscode/agent-stats/` 目录下生成统计文件
- 文件名格式：`agent-session-{sessionId}.json`
- 包含完整的会话统计信息

## 实现文件

### 核心组件

1. **AgentFileChangeTracker** (`src/extension/tools/node/agentFileChangeTracker.tsx`)
   - 负责跟踪文件变化并计算行数差异
   - 提供统计信息的打印和保存功能

2. **AgentSessionManager** (`src/extension/tools/node/agentSessionManager.tsx`)
   - 管理agent会话的生命周期
   - 提供全局的会话统计管理

3. **EditFileResult** (`src/extension/tools/node/editFileToolResult.tsx`)
   - 集成文件变化跟踪功能
   - 在文件编辑完成后自动触发统计

### 修改的文件

- `src/extension/tools/node/agentFileChangeTracker.tsx` (新增)
- `src/extension/tools/node/agentSessionManager.tsx` (新增)
- `src/extension/tools/node/editFileToolResult.tsx` (修改)
- `src/extension/prompts/node/agent/agentPrompt.tsx` (修改)

## 使用方法

### 1. 启动Agent模式
当用户进入agent模式时，系统会自动：
- 创建新的会话跟踪器
- 开始监控文件变化

### 2. 文件修改跟踪
当agent执行文件编辑操作时：
- 自动计算修改前后的行数差异
- 实时更新会话统计信息

### 3. 统计信息显示
在每次文件修改完成后：
- 在OUTPUT中打印统计摘要
- 自动保存JSON统计文件

## 输出示例

### Console输出
```
=== Agent File Changes Summary ===
Session ID: agent-session-1703123456789-abc123def
Timestamp: 2023-12-21T10:30:45.123Z
Total Files Changed: 3
Total Lines Added: +45
Total Lines Removed: -12
Net Change: +33

File Changes:
  + src/main.js (+20, -5) [update]
  + src/utils.js (+15, -3) [update]
  + src/config.js (+10, -4) [update]
================================
```

### JSON文件内容
```json
{
  "sessionId": "agent-session-1703123456789-abc123def",
  "timestamp": "2023-12-21T10:30:45.123Z",
  "totalFilesChanged": 3,
  "totalAddedLines": 45,
  "totalRemovedLines": 12,
  "fileChanges": [
    {
      "filePath": "/path/to/src/main.js",
      "addedLines": 20,
      "removedLines": 5,
      "operation": "update"
    },
    {
      "filePath": "/path/to/src/utils.js",
      "addedLines": 15,
      "removedLines": 3,
      "operation": "update"
    },
    {
      "filePath": "/path/to/src/config.js",
      "addedLines": 10,
      "removedLines": 4,
      "operation": "update"
    }
  ]
}
```

## 技术实现

### 行数差异计算
- 使用简单的行数比较算法
- 支持新增、删除、更新三种操作类型
- 对于内容变化但行数相同的情况，标记为替换操作

### 文件操作类型
- `add`: 新文件创建
- `delete`: 文件删除
- `update`: 文件内容修改

### 统计文件存储
- 位置：`.vscode/agent-stats/`
- 格式：JSON
- 命名：`agent-session-{timestamp}-{randomId}.json`

## 遥测数据

系统会发送以下遥测事件：
- `agentFileChange`: 单个文件变化事件
- `agentSessionEnd`: 会话结束事件

## 注意事项

1. 统计文件会保存在工作区的 `.vscode/agent-stats/` 目录下
2. 每次agent会话都会生成独立的统计文件
3. 只有在实际进行文件修改时才会生成统计信息
4. 统计信息会同时显示在OUTPUT和保存到JSON文件中

## 未来改进

1. 实现更精确的diff算法（如Myers diff）
2. 添加统计数据的可视化界面
3. 支持历史统计数据的查询和分析
4. 添加配置选项来自定义统计行为