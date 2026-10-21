export type HostKind = "cli" | "desktop";

export interface RuntimeInfo {
  version: string;
  host: HostKind;
  dataDir: string;
  loopReady: boolean;
  workspace: string;
  baseUrlSet: boolean;
  modelSet: boolean;
  apiKeySet: boolean;
  missing: string[];
}

export interface SessionRow {
  id: string;
  title: string;
  workspace: string;
  parentId: string | null;
  kind: string;
  depth: number;
  createdAt: string;
  updatedAt: string;
  folder: string;
  pinned: boolean;
  archived: boolean;
}

export interface SessionPrefs {
  agentEngine?: "native" | "claude_code" | "opencode" | "pi";
  model?: string;
  temperature?: number;
  maxTokens?: number;
  permissionMode?: "ask" | "auto" | "deny";
  systemPrompt?: string;
  workspace?: string;
}

export interface AgentPluginInfo {
  id: "native" | "claude_code" | "opencode" | "pi";
  name: string;
  installed: boolean;
  ready: boolean;
  discovered: boolean;
  executable: string | null;
  managed: boolean;
  package: string | null;
  installDirectory: string | null;
  sourceUrl: string | null;
  ccSwitchExecutable: string | null;
  model: string | null;
}

export interface SessionBindings {
  skill: string[];
  mcp: string[];
  corpus: string[];
  knowledge: string[];
}

export interface ProjectRow {
  id: string;
  name: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  /** 目录当前是否读得到（后端 projects_list 附带）。false 只提示、不动数据。 */
  accessible?: boolean;
}

export interface TodoItem {
  id: string;
  content: string;
  status: string;
  parent?: string | null;
}

export interface SessionSearchHit {
  id: string;
  title: string;
  snippet: string;
  updatedAt: string;
}

export interface CorpusDoc {
  id: string;
  name: string;
  source: string;
  path: string;
  bytes: number;
  chunks: number;
  status: string;
  error?: string | null;
}

export interface WikiPageEntry {
  file: string;
  title: string;
  /** 目录分组标签，由后端注册表给出（旧注册表可能缺失）。 */
  group?: string | null;
  /** 页面语义："overview"（默认打开）｜"scan"（扫描索引）｜"distilled"（对话沉淀）。 */
  role?: string | null;
  /** 模型文章的证据文件已变化（后端读取时派生，不落盘）。仅模型文章会为 true。 */
  stale?: boolean;
}

/** 最近一次深度构建失败：core 记录的具体阶段与原因。 */
export interface WikiBuildError {
  stage: string;
  reason: string;
  at: string;
}

export interface WikiProfile {
  domain: "code" | "generic";
  label: string;
}

export interface WikiStatus {
  path: string;
  hasCompiled: boolean;
  version: number;
  /** 最近一次发布的模型构建版本号（文章注册表 version）；0 = 还没发布过模型构建。 */
  buildVersion: number;
  workspace?: string | null;
  compiledAt?: string | null;
  pages: WikiPageEntry[];
  sourceFiles?: number | null;
  /** 最近一次模型构建失败（阶段+原因+时间）；成功构建会清掉它。 */
  lastBuildError?: WikiBuildError | null;
}

export interface WikiPage {
  name: string;
  path: string;
  body: string;
}

export interface WikiHit {
  page: string;
  excerpt: string;
  /** "raw" = 原始源码证据（带行号，跳项目文件）；"wiki" = Wiki 页内证据。 */
  kind?: "raw" | "wiki" | null;
  /** raw 证据的 1 起始行范围（core 已校验在文件行数内）。 */
  start?: number | null;
  end?: number | null;
  /** Wiki 文章命中的依据文件已变更：只能作线索，不作当前事实（core 派生标注）。 */
  stale?: boolean;
}

/** 深度构建的逐项结果（core `BuildReport`，camelCase）。 */
export interface WikiBuildReport {
  build: number;
  incremental: boolean;
  /** 本次计划要写的全部文章。 */
  targets: string[];
  published: string[];
  /** 因人工编辑而未被重建的文章——跳过必须可见，绝不静默。 */
  skippedUserEdited: string[];
  /** 构建为通过引用校验做的显式修复（如剔除幻觉行号并标注待核实）。 */
  warnings?: string[];
  /** 因人工编辑未被覆盖、新文本待冲突合并的文章（正文在 wiki/builds/pending/）。 */
  pending?: string[];
  /** 本次构建墙钟耗时（毫秒）。 */
  elapsedMs?: number;
  /** 本次构建实际发起的模型调用次数。 */
  modelCalls?: number;
}

export interface WikiCoverageChildRepo {
  dir: string;
  manifest: string;
}

/** 扫描覆盖的真实故事（core `CoverageReport`，只读）。 */
export interface WikiCoverage {
  scannedAt: string;
  workspace: string;
  candidateFiles: number;
  includedFiles: number;
  ignoredDirs: string[];
  tooLarge: number;
  tooLargeExamples: string[];
  unreadable: number;
  overBudget: number;
  overBudgetExamples: string[];
  budgetHit: boolean;
  rootManifest: boolean;
  childRepos: WikiCoverageChildRepo[];
  /** 疑似选错根目录时 core 给出的建议子仓库；桌面只提示，不静默切换。 */
  rootSuggestion?: string | null;
}

/** `wiki_read_source` 返回的证据窗口（core `SourceWindow`）。 */
export interface WikiSourceWindow {
  rel: string;
  start: number;
  end: number;
  totalLines: number;
  lines: string[];
  truncated: boolean;
}

export interface WikiAnswer {
  answer: string;
  sources: WikiHit[];
}

/** 统一知识空间检索的单条证据（core `SpaceEvidence`，camelCase）。surface: "article" | "chunk" | "vector"。 */
export interface SpaceEvidence {
  spaceId: string;
  spaceName: string;
  surface: string;
  label: string;
  excerpt: string;
  sourceUrl?: string;
}

/**
 * 引用点击查看到的来源版本（§八 出处可打开）：space_evidence 的载荷。
 * 引用永远解析到构建时记录的 FROZEN 版本；`notice` 原样展示——
 * 「位置合法不等于结论已证实」，前端不得把可打开当作已证实。
 */
export interface SpaceCitationSource {
  spaceId: string;
  documentId: string;
  sourceKind: string;
  sourceId: string;
  /** 资料所属空间（跨空间链接时与 spaceId 不同，A5）。 */
  homeSpaceId: string;
  crossSpace: boolean;
  versionNo: number;
  parserVersion: number;
  sha256: string;
  /** 已被更新版本接替 ≠ 被撤销：接替不隐藏历史，冻结内容仍可读。 */
  superseded: boolean;
  token: string;
  locator: string;
  totalLines: number;
  rangeValid: boolean;
  excerpt: { line: number; text: string }[];
  /** 该冻结版本的全量存储正文（网页即正文快照，与"原文"同物）。 */
  content: string;
  notice: string;
}

/** 这次检索一无所获的空间（显式枚举，绝不静默丢弃）。 */
export interface EmptySpace {
  spaceId: string;
  spaceName: string;
}

/** 统一入口 space_search 的结果：命中 + 空空间名单。 */
export interface SpaceSearchResult {
  hits: SpaceEvidence[];
  emptySpaces: EmptySpace[];
}

/**
 * 统一入口 space_ask 的结果。mode: "local_extract" | "cloud_summary"；
 * 云端摘要由 core 按每个空间的外部策略闸门裁决，任何降级都在
 * policyNote 里如实说明（前端必须展示，不得吞掉）。
 */
export interface SpaceAnswer {
  answer: string;
  noAnswer: boolean;
  sources: SpaceEvidence[];
  mode: string;
  policyNote?: string | null;
}

/** —— 资料库（CustomerKnowledgePanel）契约收编：IPC 名单与形状冻结。 —— */
export interface KnowledgeSpaceRow {
  id: string;
  tenantId: string;
  customerId: string;
  name: string;
  externalPolicy: string;
}
/** 空间的资料清单（core `space_materials`）：本空间关联的每一条资料——
 * 自己的（home）或关联进来的——含绑定方式与当前实际读到的版本。
 * resolvedVersionNo 为 null 表示已关联但不产出证据（固定版本被撤回，
 * fail closed）。 */
export interface KnowledgeSpaceMaterial {
  documentId: string;
  homeSpaceId: string;
  sourceKind: string;
  sourceId: string;
  status: string;
  createdAt: string;
  binding: "follow" | "pinned" | string;
  pinnedVersionNo: number | null;
  latestPublishedVersionNo: number | null;
  resolvedVersionNo: number | null;
}
export interface KnowledgeDocumentRow {
  id: string;
  sourceKind: string;
  sourceId: string;
  status: string;
  createdAt: string;
}
export interface KnowledgeVersionRow {
  id: string;
  documentId: string;
  versionNo: number;
}
export interface KnowledgeChunkHit {
  documentId: string;
  versionId: string;
  versionNo: number;
  chunkId: string;
  ordinal: number;
  content: string;
  sourceKind: string;
  sourceId: string;
}
export interface KnowledgeExternalDecision {
  allowed: boolean;
  policy: string;
  reason: string;
}
export interface KnowledgeCollectionRow {
  id: string;
  name: string;
}
export interface KnowledgeSyncPreview {
  changed: boolean;
  incomingSha256: string;
}
export interface KnowledgeSyncSourceRow {
  id: string;
  sourceKind: string;
  sourceId: string;
  cursor?: string;
  status: string;
  retryCount: number;
}
export interface KnowledgeDeletionAuditRow {
  id: string;
  documentId: string;
  deletedAt: string;
  cascadeVersions: number;
  cascadeChunks: number;
}
export interface KnowledgeRetentionPreviewRow {
  retentionDays: number;
  eligibleVersions: number;
  oldestEligibleAt?: string;
}
export interface KnowledgeCitationRow {
  documentId: string;
  versionId: string;
  versionNo: number;
  chunkId: string;
  ordinal: number;
  sourceKind: string;
  sourceId: string;
}
/** 兼容入口 knowledge_answer 的返回（统一入口是 space_ask → SpaceAnswer）。 */
export interface KnowledgeAnswerCompat {
  answer: string;
  noAnswer: boolean;
  citations: KnowledgeCitationRow[];
}
export interface KnowledgeFileImportResult {
  imported: KnowledgeVersionRow[];
  failures: { sourceId: string; message: string }[];
}
export interface KnowledgeMemberRow {
  subjectId: string;
  role: string;
  createdAt: string;
}
export interface KnowledgeFeedbackRow {
  id: string;
  kind: string;
  comment?: string;
  status: string;
  createdAt: string;
}
export interface KnowledgeQualityMetricsRow {
  publishedDocuments: number;
  publishedChunks: number;
  citationCoverage: number;
  noAnswerRate: number;
  openFeedback: number;
  failedSyncSources: number;
}

/** A wiki proposal made in a conversation with no bound project (camelCase per core serde). */
export interface WikiDraft {
  knowledgeDocumentId?: string | null;
  projectName?: string;
  draftId: string;
  sessionId: string;
  kind: string;
  content: string;
  mode: string;
  revises?: string | null;
  idempotencyKey?: string | null;
  createdAt: string;
}

export interface WikiDraftOutcome {
  workspace: string;
  projectId: string;
  entryId: string;
  status: string;
}

export interface WikiMeta {
  version: number;
  workspace: string;
  compiledAt: string;
  pages: string[];
  sourceFiles: number;
}

/** One knowledge entry in the project wiki ledger (camelCase per core serde). */
export interface WikiEntry {
  id: string;
  kind: "flow" | "decision" | "pitfall" | "term";
  content: string;
  sessionId: string;
  createdAt: string;
  status: "pending" | "accepted" | "rejected";
  updatedAt?: string | null;
  revisionOf?: string | null;
  turn?: number | null;
}

export interface SpecHandle {
  sessionId: string;
  specId: string;
}

export interface SpecSnapshot {
  specId: string;
  sessionId: string;
  status: string;
  version: number;
  mode: string;
  path: string;
  spec?: unknown;
  plan?: unknown;
  diffMarkdown?: string | null;
}

export interface SkillListItem {
  id: string;
  description: string;
  path: string;
  framework: boolean;
  enabled: boolean;
  sizeBytes: number;
}

export interface McpServerConfig {
  id: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  url?: string | null;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string | null;
  transport?: string;
}

export interface SandboxRoots {
  workspace: string;
  extra: string[];
}

export interface ContextStatusFile {
  rel: string;
  headerName: string;
}

export interface ContextStatus {
  injected: boolean;
  kind: string | null;
  files: ContextStatusFile[];
}

export interface McpListItem {
  id: string;
  enabled: boolean;
  ready: boolean;
  error?: string | null;
  listed: number;
  inSnapshot: number;
  skippedByBudget: string[];
  toolNames: string[];
}

export interface McpVariant {
  kind: "remote" | "package";
  label: string;
  target: string;
  supported: boolean;
}

export interface McpRegistryEntry {
  name: string;
  title: string;
  description: string;
  version: string;
  repositoryUrl?: string | null;
  suggestedId: string;
  isLatest: boolean;
  variants: McpVariant[];
}

export interface McpRegistryPage {
  entries: McpRegistryEntry[];
  nextCursor?: string | null;
}

export interface McpEnvNeed {
  name: string;
  description: string;
  secret: boolean;
}

export interface McpInstallPlan {
  server: McpServerConfig;
  /** Non-empty means the server was installed disabled until these are set. */
  missingEnv: McpEnvNeed[];
  notes: string[];
}

export interface SkillInstallReport {
  items: SkillListItem[];
  /** Always true: a remotely fetched body is reviewed before it can act. */
  installedDisabled: boolean;
  notes: string[];
}

export interface SettingsGet {
  apiKeySet: boolean;
  values: Record<string, unknown>;
}

export interface ProviderProbe {
  ok: boolean;
  status: number;
  message: string;
  models: string[];
}

export interface PermissionEvent {
  requestId: string;
  sessionId: string;
  title: string;
  toolCallId?: string | null;
  options: { optionId: string; name: string; kind: string }[];
}

export interface ContentBlock {
  type: "text";
  text: string;
}

export interface ToolCallUpdate {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  content?: ToolCallContent[];
}

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "terminal"; terminalId: string };

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; messageId: string; content: ContentBlock }
  | { sessionUpdate: "_user_images"; messageId: string; files: string[] }
  | { sessionUpdate: "agent_message_chunk"; messageId: string; content: ContentBlock }
  | { sessionUpdate: "_reasoning_delta"; messageId: string; text: string }
  | { sessionUpdate: "_tool_call_progress"; name: string; argumentBytes: number }
  | ({ sessionUpdate: "tool_call_update" } & ToolCallUpdate)
  | { sessionUpdate: "state_update"; state: "running" | "idle" | "queued"; stopReason?: string }
  | { sessionUpdate: "_job_update"; jobId: string; childSessionId?: string; phase: string }
  | { sessionUpdate: "_wiki_draft"; draftId: string; kind: string; content: string; mode: string }
  | { sessionUpdate: "_wiki_update"; phase: string; version?: number; message?: string | null; workspace?: string }
  | {
      sessionUpdate: "terminal_update";
      terminalId: string;
      command?: string | null;
      cwd?: string | null;
      background?: boolean | null;
      output?: { data: string } | null;
      exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
    }
  | { sessionUpdate: "terminal_output_chunk"; terminalId: string; data: string };

export interface BusFrame {
  seq: number;
  ts: string;
  method: string;
  params: {
    sessionId: string;
    update: SessionUpdate;
  };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  /** Persisted image attachments (data_dir-relative paths). */
  imagePaths?: string[];
  /** Fetched data URLs for `imagePaths`, filled lazily for preview. */
  images?: string[];
  engineId?: string;
  reasoningText?: string;
  streaming?: boolean;
  outputMetrics?: {
    estimatedTokens: number;
    startedAt: number;
    lastChunkAt: number;
    samples: number;
  };
  toolCallId?: string;
  status?: string;
  kind?: string;
  terminalId?: string;
}

export interface LiveTerminal {
  terminalId: string;
  sessionId: string;
  command: string;
  cwd: string;
  text: string;
  exited: boolean;
  exitCode: number | null;
  background?: boolean;
  startedAt?: number;
  status?: "running" | "exited" | "killed" | "timeout";
  // 事件总线丢帧后重同步：运行已结束却没收到退出帧的终端，状态标为
  // 未确认（后端暂无终端快照可重放，只能如实标注，不许装作正常）。
  unverified?: boolean;
}

export interface BackgroundProcess {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed" | "timeout";
  exitCode: number | null;
  elapsedMs: number;
  output: string;
}

export interface FolderEntry {
  name: string;
  relativePath: string;
  isDir: boolean;
  size: number | null;
}

export interface FilePreview {
  name: string;
  relativePath: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface ReviewFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

export interface ReviewSnapshot {
  branch: string;
  files: ReviewFile[];
}

export interface GitFile {
  path: string;
  status: string;
}

export interface GitCommit {
  id: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string;
}

export interface GitSnapshot {
  root: string;
  gitAvailable: boolean;
  repository: boolean;
  branch: string;
  userName: string;
  userEmail: string;
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: GitFile[];
  history: GitCommit[];
  localBranches: GitBranch[];
  remoteBranches: GitBranch[];
}

export interface CronJobRow {
  id: string;
  expr: string;
  prompt: string;
  workspace: string;
  modelRef?: string | null;
  enabled: boolean;
  lastRun?: string | null;
  nextRun: string;
  missedPolicy: string;
  createdAt: string;
}

/** 定时任务的一次执行。每次执行是一条独立会话，点击运行记录就打开它。 */
export interface CronRunRow {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  finished: boolean;
  summary: string;
}

export interface MemoryFiles {
  soul: string;
  user: string;
  memory: string;
  soulPath: string;
  userPath: string;
  memoryPath: string;
}

export interface ChildListItem {
  childSessionId: string;
  goal: string;
  status: string;
  depth: number;
  startedAt: string;
}

export interface SessionExport {
  id: string;
  title: string;
  workspace: string;
  kind: string;
  parentId?: string | null;
  folder?: string;
  prefs?: SessionPrefs;
  totalMessages?: number;
  lastRun?: { kind?: string; status: string; stopReason?: string | null; errorMessage?: string | null; durationMs?: number | null };
  messages: {
    id?: number;
    role: string;
    content: string;
    toolCalls?: string | null;
    toolCallId?: string | null;
    engineId?: string | null;
    attachments?: string[] | null;
  }[];
}

export type TaskStatus = "running" | "queued" | "completed" | "stopped" | "idle";

export interface TaskNode extends SessionRow {
  status: TaskStatus;
  children: TaskNode[];
}

export interface HardwareProbe {
  gpuName?: string | null;
  vramMb?: number | null;
  ramMb?: number | null;
  diskFreeMb?: number | null;
  notes: string[];
}

export interface LocalModel {
  id: string;
  format: "gguf" | "mlx";
  name: string;
  path: string;
  source: string;
  quant: string;
  bytes: number;
  sha256: string;
  sha256Ok: boolean;
  active: boolean;
}

export interface QueueSnapshot {
  running: number;
  waiting: number;
  max: number;
  waitingIds: string[];
}

export interface SidecarStatus {
  kind: "stopped" | "starting" | "ready" | "failed";
  bind?: string | null;
  pid?: number | null;
  activeModel?: string | null;
  lastError?: string | null;
  errorKind?: string | null;
  queue: QueueSnapshot;
  binary?: string | null;
}

export interface ModelDownloadStatus {
  running: boolean;
  repoId: string;
  filePath: string;
  downloadedBytes: number;
  totalBytes?: number | null;
}

export interface SidecarFail {
  kind: "start" | "vram";
  message: string;
  recommend?: string;
}

export interface KnowledgeDocumentPreview {
  documentId: string;
  versionId: string;
  versionNo: number;
  sourceId: string;
  content: string;
  enabled: boolean;
}

/** Dandelion Open 更新检查：GitHub Releases 最新版本与本地版本比对结果。 */
export interface UpdateInfo { current:string;latest:string;available:boolean;name:string;notes:string;url:string }

/** Personal knowledge items share existing document/version identities. */
export interface KnowledgeItem {
  id: string; spaceId: string; versionId: string; title: string; kind: string;
  sourceId: string; body: string; notes: string; hasAsset: boolean;
  parseStatus: string; parseError: string | null; topics: string[]; suggestedTopics: string[];
  favorite: boolean; classificationStatus: string; classificationError: string | null;
  updatedAt: string; enabled: boolean; modelAllowed: boolean; manualTopics: boolean;
}
export interface KnowledgeItemInput {
  title: string; kind: string; body: string; notes: string;
  documentId?: string | null; expectedVersionId?: string | null; sourceId?: string | null;
}
export interface KnowledgeCollectResult {
  items: KnowledgeItem[]; failures: { sourceId: string; message: string }[]; skipped: string[];
}
