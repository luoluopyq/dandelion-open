export type SettingsFieldKind = "bool" | "number" | "string" | "select" | "lines";

export interface SettingsField {
  key: string;
  label: string;
  kind: SettingsFieldKind;
  options?: { value: string; label: string }[];
  step?: number;
  note?: string;
  advanced?: boolean;
}

export interface SettingsGroup {
  id: string;
  title: string;
  hint?: string;
  jump?: { dock?: "plugins" | "skills" | "mcp" | "sandbox" | "corpus"; section?: string; label: string };
  placeholder?: string;
  fields: SettingsField[];
}

/** Labels only. Values always come from Runtime settings.json. */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {id: "updates", title: "关于与更新", hint: "查看当前版本，检查并获取新版本。", fields: []},
  {
    id: "common",
    title: "概览",
    hint: "只显示开始使用所需的设置。其余参数保留默认值即可。",
    fields: [],
  },
  {
    id: "generation",
    title: "模型生成参数",
    hint: "仅在需要调整输出长度、随机性或思考开销时修改。",
    fields: [
      { key: "dandelion.temperature", label: "温度", kind: "number", step: 0.05 },
      { key: "dandelion.maxTokens", label: "最大生成 token", kind: "number" },
      { key: "dandelion.tokenBudget.enabled", label: "vLLM 动态输出额度", kind: "bool", note: "仅 vllm 后端；生成前向 /tokenize 查询实际输入和模型上下文。" },
      {
        key: "dandelion.thinkingIntensity",
        label: "思考强度",
        kind: "select",
        options: [
          { value: "xhigh", label: "xhigh" },
          { value: "medium", label: "medium" },
          { value: "low", label: "low" },
          { value: "off", label: "关闭思考（本地模型更快）" },
        ],
        note: "账单/延迟旋钮，不是正确性",
      },
    ],
  },
  {
    id: "models",
    title: "模型",
    hint: "选择新任务默认使用的模型。支持本机 GGUF、MLX，以及 API、Ollama、vLLM 模型服务。",
    fields: [
      { key: "dandelion.maxLocalConcurrency", label: "本地最大并发", kind: "number", advanced: true },
      { key: "dandelion.killSidecarOnExit", label: "退出时结束推理进程", kind: "bool", advanced: true },
      { key: "dandelion.recommendQuant", label: "推荐量化档", kind: "string", note: "留空时根据显存建议", advanced: true },
      { key: "dandelion.localModelDir", label: "模型文件目录", kind: "string", note: "留空使用应用数据目录", advanced: true },
      { key: "dandelion.sidecar.readyTimeoutMs", label: "启动等待时间（毫秒）", kind: "number", advanced: true },
      { key: "dandelion.sidecar.listenPort", label: "本地模型固定端口", kind: "number", note: "连接 CC Switch 时使用，例如 8001；留空则自动选择", advanced: true },
      { key: "dandelion.agent.ccSwitchProxyPort", label: "Claude Code 代理端口", kind: "number", note: "CC Switch CLI 首选监听端口，默认 15721；被占用时自动使用空闲本地端口", advanced: true },
      { key: "dandelion.sidecar.mlxPromptCacheBytes", label: "MLX 提示缓存上限（字节）", kind: "number", note: "内存紧张时可设为 1073741824（1 GiB）；重启模型后生效", advanced: true },
      { key: "dandelion.sidecar.mlxKvBits", label: "MLX KV 缓存量化位数", kind: "number", note: "可选 4 或 8；内存紧张时使用 4，重启模型后生效", advanced: true },
      { key: "dandelion.vision.maxImages", label: "单条消息最多图片数", kind: "number", note: "默认 8，可选 1–16；超出部分发送时会被拒绝" },
      { key: "dandelion.vision.maxImageBytes", label: "单张图片最大字节数", kind: "number", note: "默认 12582912（12 MiB）；过大的图片建议先压缩" },
    ],
  },
  {
    id: "providers",
    title: "模型",
    hint: "选择新任务默认使用的模型。可在本机运行，也可连接已有模型服务。",
    fields: [],
  },
  {
    id: "security",
    title: "权限与安全",
    hint: "查看敏感操作的授权方式、终端开关和可访问目录。",
    fields: [],
  },
  {
    id: "network",
    title: "连接与重试",
    hint: "模型服务连接不稳定时，再调整超时和重试参数。",
    fields: [
      { key: "dandelion.httpConnectTimeoutMs", label: "连接超时（毫秒）", kind: "number" },
      { key: "dandelion.sseIdleTimeoutMs", label: "响应空闲超时（毫秒）", kind: "number" },
      { key: "dandelion.sidecar.sseIdleTimeoutMs", label: "本地模型空闲超时（毫秒）", kind: "number", note: "本地模型生成长篇文件或工具参数时可能暂时不发送内容；默认 15 分钟。" },
      { key: "dandelion.retryMax", label: "重试次数", kind: "number" },
      { key: "dandelion.retryBaseMs", label: "重试基数（毫秒）", kind: "number" },
      { key: "dandelion.retryCapMs", label: "重试上限（毫秒）", kind: "number" },
    ],
  },
  {
    id: "loop",
    title: "代理执行",
    fields: [
      { key: "dandelion.maxIterations", label: "单轮最大 LLM 次数", kind: "number" },
      { key: "dandelion.tools.parallelIndependent", label: "独立读并行", kind: "bool" },
      { key: "dandelion.tools.parallelMax", label: "并行上限", kind: "number" },
      { key: "dandelion.tools.startOnReady", label: "槽完成即开工", kind: "bool" },
      { key: "dandelion.compact.enabled", label: "overflow 时 compact", kind: "bool" },
      { key: "dandelion.compact.maxPerPrompt", label: "每轮最多 compact 次数", kind: "number" },
      { key: "dandelion.compact.keepTurns", label: "保留最近完整轮数", kind: "number" },
      { key: "dandelion.compact.sourceMaxBytes", label: "compact 原文上限字节", kind: "number" },
      { key: "dandelion.compact.preflightEnabled", label: "预估 compact", kind: "bool", note: "出厂关。模型窗未知或小于 64k 建议开。关 compact.enabled 时预估与 dln compact 都拒绝。仍走同一循环。" },
      { key: "dandelion.compact.preflightReserveTokens", label: "预估预留 token", kind: "number" },
      { key: "dandelion.tokenBudget.marginTokens", label: "vLLM 上下文安全余量", kind: "number" },
      { key: "dandelion.tokenBudget.minOutputTokens", label: "最少保留输出 token", kind: "number", note: "不足时触发现有压缩流程；有思考的模型需要给正文留空间。" },
    ],
  },
  {
    id: "spec",
    title: "计划与规格",
    hint: "调整计划生成与执行的资源上限。",
    fields: [
      { key: "dandelion.spec.generateMaxIterations", label: "Spec Generator 上限", kind: "number", note: "仅 dln spec / 本页；不改 dln chat。" },
      { key: "dandelion.spec.adaptMaxIterations", label: "Spec Adapter 上限", kind: "number" },
      { key: "dandelion.spec.maxFileBytes", label: "SPEC/PLAN 单份上限字节", kind: "number" },
      { key: "dandelion.spec.executeMaxIterations", label: "Spec Execute 上限", kind: "number", note: "0 = 用全局 maxIterations" },
    ],
  },
  {
    id: "files",
    title: "文件与终端限制",
    fields: [
      { key: "dandelion.file.readDefaultLimit", label: "读文件默认行数", kind: "number" },
      { key: "dandelion.file.readMaxLimit", label: "读文件行数上限", kind: "number" },
      { key: "dandelion.file.readMaxBytes", label: "单文件读上限字节", kind: "number" },
      { key: "dandelion.file.writeMaxBytes", label: "单次写上限字节", kind: "number" },
      { key: "dandelion.search.maxResults", label: "搜索条数", kind: "number" },
      { key: "dandelion.search.maxFileBytes", label: "跳过更大文件", kind: "number" },
      { key: "dandelion.terminal.foregroundTimeoutSec", label: "前台命令超时秒", kind: "number" },
      { key: "dandelion.terminal.foregroundTimeoutMaxSec", label: "前台硬顶秒", kind: "number" },
      { key: "dandelion.terminal.outputMaxBytes", label: "回模型输出截断", kind: "number" },
      { key: "dandelion.terminal.liveChunkBytes", label: "活窗分块字节", kind: "number" },
      { key: "dandelion.terminal.liveFlushMs", label: "活窗刷新间隔 ms", kind: "number" },
      { key: "dandelion.process.logDefaultLines", label: "process log 默认行数", kind: "number" },
    ],
  },
  {
    id: "skills",
    title: "技能与项目须知",
    jump: { dock: "skills", label: "管理技能" },
    fields: [
      { key: "dandelion.skills.maxInjectBytes", label: "技能注入合计上限", kind: "number" },
      { key: "dandelion.context.enabled", label: "发现项目上下文", kind: "bool" },
      { key: "dandelion.context.maxInjectBytes", label: "project 段合计上限", kind: "number" },
      { key: "dandelion.context.maxFileBytes", label: "单份须知上限", kind: "number" },
      { key: "dandelion.contextPack.enabled", label: "注入已确认项目记忆", kind: "bool", note: "仅当前项目、已确认、未撤回且未过期的账本事实会进入同一 agent loop。" },
      { key: "dandelion.contextPack.tokenBudget", label: "账本 ContextPack token 预算", kind: "number" },
      { key: "dandelion.contextPack.maxItems", label: "账本 ContextPack 最大条目", kind: "number" },
    ],
  },
  {
    id: "mcp",
    title: "MCP 服务",
    jump: { dock: "mcp", label: "管理 MCP 服务" },
    fields: [
      { key: "dandelion.mcp.spawnTimeoutMs", label: "spawn 超时 ms", kind: "number" },
      { key: "dandelion.mcp.failureThreshold", label: "失败阈值（连续错误次数）", kind: "number" },
      { key: "dandelion.mcp.reconnectBackoffSec", label: "重连退避秒数", kind: "number" },
      { key: "dandelion.mcp.maxToolSchemaBytes", label: "单工具 schema 硬顶", kind: "number" },
      { key: "dandelion.mcp.descriptionMaxChars", label: "description 截断", kind: "number" },
      { key: "dandelion.mcp.maxSchemaBytes", label: "本轮 schema 合计软顶（0=不限制）", kind: "number" },
      { key: "dandelion.mcp.activateMaxPerTurn", label: "单次 find_tools 激活上限（超过则首轮懒加载）", kind: "number" },
    ],
  },
  {
    id: "corpus",
    title: "知识库检索",
    hint: "管理知识库检索时使用的片段数量和大小。",
    jump: { dock: "corpus", label: "管理知识库" },
    fields: [
      { key: "dandelion.space.searchMaxHits", label: "每轮知识检索片段数", kind: "number" },
      { key: "dandelion.knowledge.excerptBytes", label: "单条资料摘录字节", kind: "number", advanced: true },
      { key: "dandelion.corpus.maxHits", label: "本轮最多命中（0=不检索）", kind: "number" },
      { key: "dandelion.corpus.maxInjectBytes", label: "片段合计字节", kind: "number" },
      { key: "dandelion.corpus.chunkChars", label: "分块字符数", kind: "number" },
      { key: "dandelion.corpus.minDiskFreeMb", label: "索引前最少剩余磁盘 MiB", kind: "number" },
      { key: "dandelion.corpus.maxFileBytes", label: "单文件上限字节", kind: "number" },
    ],
  },
  {
    id: "todo",
    title: "任务列表",
    hint: "调整任务列表的容量。",
    fields: [
      { key: "dandelion.todo.maxItems", label: "单会话最多条目", kind: "number" },
      { key: "dandelion.todo.maxContentChars", label: "单条内容字符上限", kind: "number" },
    ],
  },
  {
    id: "web",
    title: "联网搜索",
    hint: "调整联网搜索和网页提取的范围与超时。",
    fields: [
      { key: "dandelion.web.timeoutMs", label: "请求超时 ms", kind: "number" },
      { key: "dandelion.web.maxResults", label: "搜索最多条数", kind: "number" },
      { key: "dandelion.web.maxExtractBytes", label: "单页提取字节上限", kind: "number" },
      { key: "dandelion.web.maxExtractUrls", label: "一次最多提取 URL 数", kind: "number" },
      { key: "dandelion.web.searchUrl", label: "搜索 URL 模板（含 {query}）", kind: "string" },
      { key: "dandelion.web.userAgent", label: "User-Agent", kind: "string" },
    ],
  },
  {
    id: "memory",
    title: "全局记忆文件",
    hint: "旧版高级功能：三个文件会在新对话开始时读取，作用于所有项目。项目专属内容请在「记忆」页面管理。",
    fields: [
      { key: "dandelion.memory.enabled", label: "在新对话中读取全局记忆", kind: "bool" },
      { key: "dandelion.memory.maxInjectBytes", label: "三个文件合计上限", kind: "number" },
      { key: "dandelion.memory.soulMaxBytes", label: "助理角色文件上限", kind: "number" },
      { key: "dandelion.memory.userMaxBytes", label: "个人偏好文件上限", kind: "number" },
      { key: "dandelion.memory.memoryMaxBytes", label: "通用笔记文件上限", kind: "number" },
      { key: "dandelion.memory.autoCandidates", label: "自动候选：对话中出现「记住…」等表述时自动生成待确认记忆", kind: "bool", note: "无论开关如何，助手也可在任务中主动提议记忆；两者都需在「记忆」页面确认后才生效。" },
    ],
  },
  {
    id: "storage",
    title: "存储与事件",
    fields: [
      { key: "dandelion.encryptApiKey", label: "加密存储 API 密钥", kind: "bool", note: "出厂开启；仅在兼容旧环境时调整。", advanced: true },
      { key: "dandelion.sqliteBusyMs", label: "SQLite busy ms", kind: "number" },
      { key: "dandelion.busCapacity", label: "广播队列容量", kind: "number" },
      { key: "dandelion.session.listLimit", label: "会话列表默认条数", kind: "number" },
    ],
  },
  {
    id: "host",
    title: "对外服务",
    hint: "配置命令行服务的本机监听地址。",
    fields: [
      {
        key: "dandelion.serve.bind",
        label: "serve.bind",
        kind: "string",
        note: "出厂 127.0.0.1:3927。非回环须 CLI 显式 --bind。",
      },
    ],
  },
  {
    id: "json",
    title: "在 settings.json 中编辑",
    hint: "与 15 同一组键。非法 JSON 红字且不覆盖文件。不含 API Key。",
    fields: [],
  },
];
