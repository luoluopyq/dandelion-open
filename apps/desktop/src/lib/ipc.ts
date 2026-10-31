import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  AgentPluginInfo,
  ContextStatus,
  FolderEntry,
  FilePreview,
  ReviewSnapshot,
  GitSnapshot,
  McpInstallPlan,
  McpListItem,
  McpRegistryPage,
  McpServerConfig,
  ProjectRow,
  RuntimeInfo,
  SandboxRoots,
  SessionBindings,
  SessionExport,
  SessionPrefs,
  SessionRow,
  SessionSearchHit,
  TodoItem,
  SettingsGet,
  SkillInstallReport,
  SkillListItem,
  KnowledgeAnswerCompat,
  KnowledgeChunkHit,
  KnowledgeCollectionRow,
  KnowledgeDeletionAuditRow,
  KnowledgeDocumentRow,
  KnowledgeExternalDecision,
  KnowledgeFeedbackRow,
  KnowledgeFileImportResult,
  KnowledgeMemberRow,
  KnowledgeQualityMetricsRow,
  KnowledgeRetentionPreviewRow,
  KnowledgeSpaceRow,
  KnowledgeSyncPreview,
  KnowledgeSyncSourceRow,
  KnowledgeVersionRow,
  SpaceAnswer,
  SpaceSearchResult,
} from "./types";

// ---- boot instrumentation (work-order §二) --------------------------------
// Local-only bookkeeping: marks are pushed with performance.now() (clock base
// = webview navigation start) and per-command IPC costs are accumulated in
// memory. Nothing is sent per call — `flushBootMarks` ships the whole buffer
// once via the thin `boot_marks` forwarder, so measuring does not perturb
// what it measures. A failed flush is swallowed: telemetry never breaks boot.
interface BootMark { phase: string; elapsedMs: number; detail: string }
const bootMarks: BootMark[] = [];
const ipcStats = new Map<string, { count: number; ms: number }>();

export function bootMark(phase: string, detail = ""): void {
  bootMarks.push({ phase, elapsedMs: Math.round(performance.now()), detail });
}

/** Compact "cmd×N(Tms)" digest, slowest first, for attaching to a mark. */
export function ipcStatsDigest(limit = 12): string {
  return [...ipcStats.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, limit)
    .map(([c, s]) => `${c}×${s.count}(${Math.round(s.ms)}ms)`)
    .join(", ");
}

/** Zero the IPC counters (called at visit boundaries so each flush carries
    only the costs accumulated since the last one). */
export function resetIpcStats(): void {
  ipcStats.clear();
}

export async function flushBootMarks(): Promise<void> {
  // The synchronous splice doubles as the concurrency guard: a second
  // in-flight caller sees an empty buffer and returns. Marks keep being
  // collectable afterwards (knowledge page is measured on every visit).
  const batch = bootMarks.splice(0);
  if (batch.length === 0) return;
  try {
    await tauriInvoke("boot_marks", { marks: batch });
  } catch {
    /* measurement must never break the app */
  }
}

async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t0 = performance.now();
  try {
    return await tauriInvoke<T>(cmd, args);
  } finally {
    const s = ipcStats.get(cmd) ?? { count: 0, ms: 0 };
    s.count += 1;
    s.ms += performance.now() - t0;
    ipcStats.set(cmd, s);
  }
}
// ---------------------------------------------------------------------------

export function agentPluginsList(): Promise<AgentPluginInfo[]> { return invoke("agent_plugins_list"); }
export function agentPluginConnect(id: string, path?: string): Promise<void> { return invoke("agent_plugin_connect", { id, path: path || null }); }
export function agentPluginInstall(id: string): Promise<void> { return invoke("agent_plugin_install", { id }); }
export function agentPluginInstallCancel(id: string): Promise<void> { return invoke("agent_plugin_install_cancel", { id }); }
export function agentPluginSetModel(id: string, model?: string): Promise<void> { return invoke("agent_plugin_set_model", { id, model: model || null }); }
export function agentPluginUninstall(id: string): Promise<void> { return invoke("agent_plugin_uninstall", { id }); }
export function agentPluginStop(id: string): Promise<void> { return invoke("agent_plugin_stop", { id }); }

export function runtimeInfo(): Promise<RuntimeInfo> {
  return invoke("runtime_info");
}

export function sessionNew(): Promise<string> {
  return invoke("session_new");
}

export function sessionPrompt(
  sessionId: string,
  text: string,
  mode: "ask" | "plan" | "auto" = "auto",
  imageUrls: string[] = [],
): Promise<string> {
  return invoke("session_prompt", { sessionId, text, mode, imageUrls });
}

export function promptRefine(text: string, sessionId?: string): Promise<string> {
  return invoke("prompt_refine", { text, sessionId: sessionId || null });
}

export function sessionCancel(sessionId: string): Promise<void> {
  return invoke("session_cancel", { sessionId });
}

export function terminalKill(terminalId: string): Promise<void> {
  return invoke("terminal_kill", { terminalId });
}

export function backgroundProcesses(sessionId: string): Promise<import("./types").BackgroundProcess[]> {
  return invoke("background_processes", { sessionId });
}

export function terminalRunUser(sessionId: string, command: string, cwd?: string): Promise<void> {
  return invoke("terminal_run_user", { sessionId, command, cwd: cwd ?? null });
}

export function folderPick(): Promise<string | null> {
  return invoke("folder_pick");
}

export function filePick(imagesOnly = false): Promise<string[]> {
  return invoke("file_pick", { imagesOnly });
}

export function fileImageDataUrl(path: string): Promise<string> {
  return invoke("file_image_data_url", { path });
}

export function attachmentDataUrl(path: string): Promise<string> {
  return invoke("attachment_data_url", { path });
}

export function agentEngineVision(engine: string): Promise<"images" | "files"> {
  return invoke("agent_engine_vision", { engine });
}

export function browserEmbedShow(url: string, x: number, y: number, width: number, height: number): Promise<void> {
  return invoke("browser_embed_show", { request: { url, x, y, width, height } });
}

export function browserEmbedHide(): Promise<void> {
  return invoke("browser_embed_hide");
}

export function folderList(root: string, relativePath = ""): Promise<FolderEntry[]> {
  return invoke("folder_list", { root, relativePath });
}

export function folderRead(root: string, relativePath: string): Promise<FilePreview> {
  return invoke("folder_read", { root, relativePath });
}

export function workspaceWriteFile(root: string, relativePath: string, content: string): Promise<FilePreview> {
  return invoke("workspace_write_file", { root, relativePath, content });
}

export function workspaceCreateEntry(root: string, relativePath: string, isDir: boolean): Promise<void> {
  return invoke("workspace_create_entry", { root, relativePath, isDir });
}

export function workspaceRenameEntry(root: string, relativePath: string, nextRelativePath: string): Promise<void> {
  return invoke("workspace_rename_entry", { root, relativePath, nextRelativePath });
}

export function workspaceDeleteEntry(root: string, relativePath: string): Promise<void> {
  return invoke("workspace_delete_entry", { root, relativePath });
}

export function workspaceReview(root: string): Promise<ReviewSnapshot> {
  return invoke("workspace_review", { root });
}

export function gitSnapshot(root: string): Promise<GitSnapshot> { return invoke("git_snapshot", { root }); }
export function gitInit(root: string): Promise<GitSnapshot> { return invoke("git_init", { root }); }
export function gitConfigure(root: string, userName: string, userEmail: string): Promise<GitSnapshot> { return invoke("git_configure", { root, userName, userEmail }); }
export function gitDiff(root: string, path?: string, staged = false): Promise<string> { return invoke("git_diff", { root, path: path ?? null, staged }); }
export function gitStage(root: string, path: string, staged = false): Promise<GitSnapshot> { return invoke("git_stage", { root, path, staged }); }
export function gitCommit(root: string, message: string): Promise<GitSnapshot> { return invoke("git_commit", { root, message }); }
export function gitRestoreFile(root: string, path: string, staged = false): Promise<GitSnapshot> { return invoke("git_restore_file", { root, path, staged }); }
export function gitResetHard(root: string, commit: string): Promise<GitSnapshot> { return invoke("git_reset_hard", { root, commit }); }
export function gitSwitchBranch(root: string, branch: string, remote = false): Promise<GitSnapshot> { return invoke("git_switch_branch", { root, branch, remote }); }
export function gitFetch(root: string): Promise<GitSnapshot> { return invoke("git_fetch", { root }); }
export function gitPull(root: string): Promise<GitSnapshot> { return invoke("git_pull", { root }); }
export function gitPush(root: string): Promise<GitSnapshot> { return invoke("git_push", { root }); }

export function sessionExport(sessionId: string): Promise<SessionExport> {
  return invoke("session_export", { sessionId });
}

export function sessionExportWindow(sessionId: string, offset = 0, limit = 60): Promise<SessionExport> {
  return invoke("session_export_window", { sessionId, offset, limit });
}

export function sessionsList(limit?: number, offset?: number): Promise<SessionRow[]> {
  return invoke("sessions_list", { limit, offset });
}

export function sessionSetTitle(sessionId: string, title: string): Promise<void> {
  return invoke("session_set_title", { sessionId, title });
}

export function sessionDelete(sessionId: string): Promise<void> {
  return invoke("session_delete", { sessionId });
}

export function sessionOccupy(sessionId: string, surface: string): Promise<void> {
  return invoke("session_occupy", { sessionId, surface });
}

export function sessionRelease(sessionId: string, surface: string): Promise<void> {
  return invoke("session_release", { sessionId, surface });
}

export function sessionOccupancy(sessionId: string): Promise<string | null> {
  return invoke("session_occupancy", { sessionId });
}

export function sessionDetachedIds(): Promise<string[]> {
  return invoke("session_detached_ids");
}

export function sessionFocusDetached(sessionId: string): Promise<boolean> {
  return invoke("session_focus_detached", { sessionId });
}

export function sessionDetach(sessionId: string): Promise<void> {
  return invoke("session_detach", { sessionId });
}

export function sessionPrefsGet(sessionId: string): Promise<SessionPrefs> {
  return invoke("session_prefs_get", { sessionId });
}

export function sessionPrefsSet(sessionId: string, prefs: SessionPrefs): Promise<void> {
  return invoke("session_prefs_set", { sessionId, prefs });
}

export function projectsList(): Promise<ProjectRow[]> {
  return invoke("projects_list");
}

export function projectCreate(workspace: string): Promise<ProjectRow> {
  return invoke("project_create", { workspace });
}

/**
 * 删除工作空间。
 *
 * `purgeSessions` 默认 true：工作空间是会话的归属单位，留着会话却没有空间可进，
 * 那些对话就没有入口了。传 false 才是只撤掉书签、把会话归档。
 */
export function projectDelete(id: string, purgeSessions = true): Promise<void> {
  return invoke("project_delete", { id, purgeSessions });
}

/**
 * 改空间的显示名。只改 `projects.name`：目录不动、会话归属不动，所以没有级联。
 */
export function projectRename(id: string, name: string): Promise<void> {
  return invoke("project_rename", { id, name });
}

/**
 * 把空间从列表里撤掉，保留它的对话。
 *
 * 和 `projectDelete` 的分工：那个是「销毁空间及其对话」，这个是「不再把它当空间」——
 * 目录还在磁盘上、对话还在库里，只是不再登记，于是那些对话落进「未归属」。
 */
export function projectUnlist(id: string): Promise<void> {
  return invoke("project_unlist", { id });
}

/** 在系统文件管理器里打开这个空间的目录。 */
export function projectReveal(workspace: string): Promise<void> {
  return invoke("project_reveal", { workspace });
}

// 「目录当前不存在就连空间带对话批量删除」的 projectsPruneMissing 已删除。
// 启动/刷新时目录读不到多半是移动盘、网络盘还没就位，不是用户要删；误接一次
// 就是不可恢复的数据丢失，所以这个 IPC 入口整个拿掉，删除只走 project_delete。

/**
 * 清掉一个对话都没有的工作空间，返回被清掉的那些。
 *
 * `dryRun` 为真时只返回名单不落库 —— 界面先拿它弹确认，用户看过要删哪几个再真删。
 * 判据在后端按 SQL 算：前端 rows 只有最近一页，不能用来判断空间是否为空。
 */
export function projectsPruneEmpty(dryRun = false): Promise<ProjectRow[]> {
  return invoke("projects_prune_empty", { dryRun });
}
export function sessionSetPinned(sessionId: string, pinned: boolean): Promise<void> { return invoke("session_set_pinned", { sessionId, pinned }); }
export function sessionSetArchived(sessionId: string, archived: boolean): Promise<void> { return invoke("session_set_archived", { sessionId, archived }); }

export function todoList(sessionId: string): Promise<TodoItem[]> {
  return invoke("todo_list", { sessionId });
}

export function sessionReplaceBindings(
  sessionId: string,
  kind: string,
  ids: string[],
): Promise<void> {
  return invoke("session_replace_bindings", { sessionId, kind, ids });
}

export function sessionDuplicate(sessionId: string): Promise<string> {
  return invoke("session_duplicate", { sessionId });
}

export function sessionTaskBindings(sessionId: string): Promise<SessionBindings> {
  return invoke("session_task_bindings", { sessionId });
}

export function knowledgeLocalSpaces(): Promise<KnowledgeSpaceRow[]> {
  return invoke("knowledge_local_spaces");
}

/** 知识面命令共用的作用域四元组；空间归属只认这些 id（名称/路径不是身份）。 */
export type KnowledgeScope = { tenantId: string; customerId: string; spaceId: string; subjectId: string };

/**
 * 统一知识空间检索（core `space_search`）：一条显式空间列表同时过
 * 存在性、归档、成员授权与外部策略四道闸门——任何一个空间不可读，
 * 整个调用失败且不回显其中内容；命中按 article/chunk/vector 三个面合并。
 */
export function spaceSearch(
  subjectId: string,
  spaceIds: string[],
  query: string,
  maxHits?: number,
): Promise<SpaceSearchResult> {
  return invoke("space_search", { subjectId, spaceIds, query, maxHits: maxHits ?? null });
}

/**
 * 统一知识空间问答（core `space_ask`）：云端摘要按【每个】空间的外部策略
 * 裁决，任何一个 local_only 空间都会把整包降级为本机摘录；降级原因在
 * policyNote，界面必须原样展示。
 */
export function spaceAsk(
  subjectId: string,
  spaceIds: string[],
  question: string,
  maxHits?: number,
  allowCloud?: boolean,
): Promise<SpaceAnswer> {
  return invoke("space_ask", {
    subjectId,
    spaceIds,
    question,
    maxHits: maxHits ?? null,
    allowCloud: allowCloud ?? null,
  });
}

/**
 * 统一阅读入口（core `space_status`）：按空间 id 读取该空间自己的 Wiki
 * 文章目录。与 space_search 走同一道 fail-closed 读闸（存在→归档→Reader
 * 授权→本机检索裁决），身份只认空间 id，绝不按名称/路径找路。
 */
export function spaceStatus(subjectId: string, spaceId: string): Promise<import("./types").WikiStatus> {
  return invoke("space_status", { subjectId, spaceId });
}

/** 统一阅读入口（core `space_show`）：读本空间的一页（page 省略=全部页）。 */
export function spaceShow(subjectId: string, spaceId: string, page?: string): Promise<import("./types").WikiPage[]> {
  return invoke("space_show", { subjectId, spaceId, page: page ?? null });
}

/**
 * 出处可打开（core `space_evidence`）：把读者点开的引用 token（`路径:Lx-Ly`）
 * 解析到构建时记录的 FROZEN 来源版本——摘录行 + 全量冻结内容。与其余空间
 * 读面同一道 fail-closed 闸；拒绝有明确原因（无法定位/来源已撤下/格式非法），
 * 载荷自带 notice「位置合法不等于结论已证实」。
 */
export function spaceEvidence(subjectId: string, spaceId: string, citation: string): Promise<import("./types").SpaceCitationSource> {
  return invoke("space_evidence", { subjectId, spaceId, citation });
}

/**
 * 空间台账审核入口（core `space_entries`）：按空间 id 列该空间全部提议
 * （submit_wiki 空间归属落 `wiki/spaces/<id>/`，与 workspace 键的
 * wikiEntries 对纯空间够不到的补齐）。fail-closed：存在→归档拒名→Reader
 * 授权；身份只认空间 id。
 */
export function spaceEntries(subjectId: string, spaceId: string): Promise<import("./types").WikiEntry[]> {
  return invoke("space_entries", { subjectId, spaceId });
}

/** 空间台账审核（core `space_review_entry`）：approve / reject / undo。Editor 起。 */
export function spaceReviewEntry(
  subjectId: string,
  spaceId: string,
  id: string,
  action: string,
): Promise<void> {
  return invoke("space_review_entry", { subjectId, spaceId, id, action });
}

/** 空间台账编辑（core `space_edit_entry`）：改内容/类别。Editor 起。 */
export function spaceEditEntry(
  subjectId: string,
  spaceId: string,
  id: string,
  content?: string,
  kind?: string,
): Promise<void> {
  return invoke("space_edit_entry", {
    subjectId,
    spaceId,
    id,
    content: content ?? null,
    kind: kind ?? null,
  });
}

/**
 * 空间页面保存（core `space_page_save`）：创建或整体替换一篇人写的 Wiki
 * 页（新建 = 起名，编辑 = 覆盖正文）。Editor 起的 fail-closed 闸门在
 * core 内；改名/路径分隔符/超 wiki_proposal_max_bytes 全部拒绝。改到机器
 * 构建的页会【保护】它：protected=true 意味着下次深度构建保留人写的正文、
 * 把机器文本作为待裁决冲突归档。页面经 switch_version 立即可读。
 */
export function spacePageSave(
  subjectId: string,
  spaceId: string,
  page: string,
  content: string,
): Promise<{ file: string; protected: boolean; version: number }> {
  return invoke("space_page_save", { subjectId, spaceId, page, content });
}

/**
 * 修改空间外部模型策略（core `space_set_policy`，空间 Owner）：
 * allow_summary | local_only | deny_cloud。只改策略，不重写任何内容——
 * 下一次问答/构建开始/发布前复核都会重新读取它。
 */
export function spaceSetPolicy(
  subjectId: string,
  spaceId: string,
  policy: string,
): Promise<void> {
  return invoke("space_set_policy", { subjectId, spaceId, policy });
}

/**
 * 空间的资料清单（core `space_materials`，Reader 起闸）：本空间关联的每条
 * 资料——自己的（home）或关联进来的（link）——含绑定方式 follow/pinned 与
 * 当前实际读到的版本 resolvedVersionNo。它为 null 表示已关联但不产出证据
 * （固定版本被撤回，fail closed）。
 */
export function spaceMaterials(
  subjectId: string,
  spaceId: string,
): Promise<import("./types").KnowledgeSpaceMaterial[]> {
  return invoke("space_materials", { subjectId, spaceId });
}

/**
 * 把已有资料关联进本空间（core `space_link_add`）：同一份资料、同一条版本
 * 历史，绝不产生第二套更新记录。两侧都必须有成员身份（本空间 Editor、资料
 * 所在空间 Reader），关联永远不能穿透权限的墙。初始绑定 follow。
 */
export function spaceLinkAdd(
  subjectId: string,
  spaceId: string,
  documentId: string,
): Promise<void> {
  return invoke("space_link_add", { subjectId, spaceId, documentId });
}

/**
 * 改绑定（core `space_link_set`，Editor）：pinned 把本空间冻结在一个已发布
 * 版本上（被取代的历史版本可以固定；草稿与被撤回的版本一律拒绝），follow
 * 放回跟随当前有效版本。
 */
export function spaceLinkSet(
  subjectId: string,
  spaceId: string,
  documentId: string,
  binding: "follow" | "pinned" | string,
  pinnedVersionNo?: number | null,
): Promise<void> {
  return invoke("space_link_set", { subjectId, spaceId, documentId, binding, pinnedVersionNo: pinnedVersionNo ?? null });
}

/** 只解除【本空间】的关联（core `space_link_remove`）：资料与其历史在别处
 * 原样存在，之后可以重新关联。从未关联过会如实报错。 */
export function spaceLinkRemove(
  subjectId: string,
  spaceId: string,
  documentId: string,
): Promise<void> {
  return invoke("space_link_remove", { subjectId, spaceId, documentId });
}

/**
 * 空间深度构建（core `space_build_llm`）：先把该空间【已发布】文档从库中
 * 物化成空间自己的 sources 镜像（单向派生，不是第三套存储），再走与
 * wikiBuildDeep 完全相同的规划→证据文章→概览、全成或全败管线。Editor 起
 * 的 fail-closed 闸门在 core 内。进度走 `_wiki_update`，其 workspace 字段
 * 是空间的 sources 目录（含空间 id，视图按 id 认领，绝不按名称匹配）。
 */
export function spaceBuildDeep(
  subjectId: string,
  spaceId: string,
  incremental?: boolean,
): Promise<import("./types").WikiBuildReport> {
  return invoke("space_build_deep", { subjectId, spaceId, incremental: incremental ?? null });
}

/** 叫停该空间进行中的深度构建；false = 没有在跑（请求不被记住）。 */
export function spaceBuildCancel(subjectId: string, spaceId: string): Promise<boolean> {
  return invoke("space_build_cancel", { subjectId, spaceId });
}

/** 空间 Wiki 知识域设置；null = 未设置，构建按资料形态启发。 */
export function spaceProfile(subjectId: string, spaceId: string): Promise<import("./types").WikiProfile | null> {
  return invoke("space_profile", { subjectId, spaceId });
}

/** 设置空间 Wiki 知识域（"code" | "generic"）；保存的设置总是压过启发式。 */
export function spaceSetProfile(
  subjectId: string,
  spaceId: string,
  profile: import("./types").WikiProfile,
): Promise<void> {
  return invoke("space_set_profile", { subjectId, spaceId, profile });
}

/** 兼容入口：单空间已发布分块检索。新代码用 spaceSearch。 */
export function knowledgeSearch(scope: KnowledgeScope, query: string, limit: number): Promise<KnowledgeChunkHit[]> {
  return invoke("knowledge_search", { ...scope, query, limit });
}

/** 兼容入口：单空间问答。新代码用 spaceAsk（外部策略在 core 侧闸门）。 */
export function knowledgeAnswer(scope: KnowledgeScope, question: string, limit: number): Promise<KnowledgeAnswerCompat> {
  return invoke("knowledge_answer", { ...scope, question, limit });
}

export function knowledgeDocuments(scope: KnowledgeScope): Promise<KnowledgeDocumentRow[]> {
  return invoke("knowledge_documents", { ...scope });
}

export function knowledgeCollections(scope: KnowledgeScope): Promise<KnowledgeCollectionRow[]> {
  return invoke("knowledge_collections", { ...scope });
}

export function knowledgeSyncSources(scope: KnowledgeScope): Promise<KnowledgeSyncSourceRow[]> {
  return invoke("knowledge_sync_sources", { ...scope });
}

/** 只读展示用；真正的云端裁决在 core（space_ask / knowledge_answer 内部）。 */
export function knowledgeExternalDecision(scope: KnowledgeScope, requestedMode: string): Promise<KnowledgeExternalDecision> {
  return invoke("knowledge_external_decision", { ...scope, requestedMode });
}

export function knowledgeDeletionAudits(scope: KnowledgeScope, limit = 50): Promise<KnowledgeDeletionAuditRow[]> {
  return invoke("knowledge_deletion_audits", { ...scope, limit });
}

export function knowledgeRetentionPreview(scope: KnowledgeScope): Promise<KnowledgeRetentionPreviewRow | null> {
  return invoke("knowledge_retention_preview", { ...scope });
}

export function knowledgeMembers(scope: KnowledgeScope): Promise<KnowledgeMemberRow[]> {
  return invoke("knowledge_members", { ...scope });
}

export function knowledgeFeedbackList(scope: KnowledgeScope): Promise<KnowledgeFeedbackRow[]> {
  return invoke("knowledge_feedback", { ...scope });
}

export function knowledgeQualityMetrics(scope: KnowledgeScope): Promise<KnowledgeQualityMetricsRow> {
  return invoke("knowledge_quality_metrics", { ...scope });
}

export function knowledgeSetMember(spaceId: string, subjectId: string, role: string): Promise<void> {
  return invoke("knowledge_set_member", { spaceId, subjectId, role });
}

export function knowledgeImportDocument(
  scope: KnowledgeScope,
  sourceKind: string,
  sourceId: string,
  content: string,
  chunkChars: number,
): Promise<[KnowledgeDocumentRow, KnowledgeVersionRow]> {
  return invoke("knowledge_import_document", { ...scope, sourceKind, sourceId, content, chunkChars });
}

export function knowledgeImportPick(scope: KnowledgeScope, folder: boolean): Promise<KnowledgeFileImportResult | null> {
  return invoke("knowledge_import_pick", { ...scope, folder });
}

export function knowledgePublishVersion(scope: KnowledgeScope, documentId: string, versionId: string): Promise<void> {
  return invoke("knowledge_publish_version", { ...scope, documentId, versionId });
}

export function knowledgeRevokeVersion(scope: KnowledgeScope, documentId: string, versionId: string): Promise<void> {
  return invoke("knowledge_revoke_version", { ...scope, documentId, versionId });
}

export function knowledgeSyncPreview(scope: KnowledgeScope, sourceKind: string, sourceId: string, content: string): Promise<KnowledgeSyncPreview> {
  return invoke("knowledge_sync_preview", { ...scope, sourceKind, sourceId, content });
}

export function knowledgeSyncApply(
  scope: KnowledgeScope,
  sourceKind: string,
  sourceId: string,
  content: string,
  cursor?: string | null,
): Promise<[KnowledgeSyncPreview, KnowledgeVersionRow | null]> {
  return invoke("knowledge_sync_apply", { ...scope, sourceKind, sourceId, content, cursor: cursor ?? null });
}

export function knowledgeSyncSetPaused(scope: KnowledgeScope, sourceKind: string, sourceId: string, paused: boolean): Promise<void> {
  return invoke("knowledge_sync_set_paused", { ...scope, sourceKind, sourceId, paused });
}

export function knowledgeDeleteDocument(scope: KnowledgeScope, documentId: string): Promise<void> {
  return invoke("knowledge_delete_document", { ...scope, documentId });
}

export function knowledgeExportSave(scope: KnowledgeScope): Promise<string | null> {
  return invoke("knowledge_export_save", { ...scope });
}

export function knowledgeSetRetentionDays(scope: KnowledgeScope, retentionDays: number): Promise<void> {
  return invoke("knowledge_set_retention_days", { ...scope, retentionDays });
}

export function knowledgeRemoveMember(scope: KnowledgeScope, actorId: string, memberId: string): Promise<void> {
  return invoke("knowledge_remove_member", { ...scope, actorId, memberId });
}

export function knowledgeCreateLocalSpace(subjectId: string, name: string, externalPolicy: string): Promise<KnowledgeSpaceRow> {
  return invoke("knowledge_create_local_space", { subjectId, name, externalPolicy });
}

export function knowledgeCreateCollection(scope: KnowledgeScope, name: string): Promise<void> {
  return invoke("knowledge_create_collection", { ...scope, name });
}

export function knowledgeAssignCollection(scope: KnowledgeScope, collectionId: string, documentId: string): Promise<void> {
  return invoke("knowledge_assign_collection", { ...scope, collectionId, documentId });
}

export function knowledgeManageMember(scope: KnowledgeScope, actorId: string, memberId: string, role: string): Promise<void> {
  return invoke("knowledge_manage_member", { ...scope, actorId, memberId, role });
}

export function knowledgeCreateApiClient(
  scope: KnowledgeScope,
  label: string,
  maxRequestsPerMinute: number,
  maxAnswerTokens: number,
): Promise<{ token: string }> {
  return invoke("knowledge_create_api_client", { ...scope, label, maxRequestsPerMinute, maxAnswerTokens });
}

export function knowledgeSubmitFeedback(scope: KnowledgeScope, kind: string, comment?: string | null): Promise<void> {
  return invoke("knowledge_submit_feedback", { ...scope, kind, comment: comment ?? null });
}

export function knowledgeReviewFeedback(
  scope: KnowledgeScope,
  reviewerId: string,
  feedbackId: string,
  status: string,
  note?: string | null,
): Promise<void> {
  return invoke("knowledge_review_feedback", { ...scope, reviewerId, feedbackId, status, note: note ?? null });
}

/**
 * 搜索对话。`workspace` 传字符串时只在那个工作空间内搜（会话按空间隔离，
 * 搜索框不能把别的空间捞出来）；传 null 搜全部。
 */
export function sessionsSearch(
  query: string,
  workspace?: string | null,
): Promise<SessionSearchHit[]> {
  return invoke("sessions_search", { query, workspace: workspace ?? null });
}

export function skillsList(): Promise<SkillListItem[]> {
  return invoke("skills_list");
}

export function mcpList(): Promise<McpListItem[]> {
  return invoke("mcp_list");
}

export function mcpStart(id: string): Promise<void> {
  return invoke("mcp_start", { id });
}

export function mcpStop(id: string): Promise<void> {
  return invoke("mcp_stop", { id });
}

export function mcpUpsert(server: McpServerConfig): Promise<void> {
  return invoke("mcp_upsert", { server });
}

export function mcpRemove(id: string): Promise<void> {
  return invoke("mcp_remove", { id });
}

export function skillsImportPick(folder: boolean): Promise<SkillListItem | null> {
  return invoke("skills_import_pick", { folder });
}

export function skillsSetEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke("skills_set_enabled", { id, enabled });
}

export function skillsOpen(id: string): Promise<void> {
  return invoke("skills_open", { id });
}

export function skillsExportPick(id: string): Promise<string | null> {
  return invoke("skills_export_pick", { id });
}

export function skillsRemove(id: string): Promise<string> {
  return invoke("skills_remove", { id });
}

export function skillsInstallUrl(url: string): Promise<SkillInstallReport> {
  return invoke("skills_install_url", { url });
}

export function skillsInstallGit(
  url: string,
  subdir?: string | null,
): Promise<SkillInstallReport> {
  return invoke("skills_install_git", { url, subdir: subdir || null });
}

export function registryMcpSearch(
  query: string,
  cursor?: string | null,
): Promise<McpRegistryPage> {
  return invoke("registry_mcp_search", { query, cursor: cursor || null });
}

export function registryMcpInstall(
  name: string,
  version?: string | null,
): Promise<McpInstallPlan> {
  return invoke("registry_mcp_install", { name, version: version || null });
}

export function sandboxRoots(): Promise<SandboxRoots> {
  return invoke("sandbox_roots");
}

export function sandboxAddRoot(path: string): Promise<string> {
  return invoke("sandbox_add_root", { path });
}

export function sandboxAddPick(): Promise<string | null> {
  return invoke("sandbox_add_pick");
}

export function sandboxRemoveRoot(path: string): Promise<void> {
  return invoke("sandbox_remove_root", { path });
}

export function contextStatus(sessionId?: string): Promise<ContextStatus> {
  return invoke("context_status", { sessionId: sessionId ?? null });
}

export function sessionExportSave(sessionId: string): Promise<string | null> {
  return invoke("session_export_save", { sessionId });
}

export function settingsGet(): Promise<SettingsGet> {
  return invoke("settings_get");
}

export function settingsApiKeyReveal(): Promise<string | null> {
  return invoke("settings_api_key_reveal");
}

export function settingsPatch(
  patch: Record<string, unknown>,
): Promise<RuntimeInfo> {
  return invoke("settings_patch", { patch });
}

export function settingsJson(): Promise<string> {
  return invoke("settings_json");
}

export function settingsPutJson(text: string): Promise<RuntimeInfo> {
  return invoke("settings_put_json", { text });
}

export function providerProbe(
  baseUrl?: string,
  apiKey?: string,
): Promise<import("./types").ProviderProbe> {
  return invoke("provider_probe", {
    baseUrl: baseUrl || null,
    apiKey: apiKey || null,
  });
}

/** 保存某条服务配置（profile）自己的 API 密钥（加密存于数据目录，不进 settings.json）。 */
export function providerKeyPut(profileId: string, apiKey: string): Promise<void> {
  return invoke("provider_key_put", { profileId, apiKey });
}

/** 读出某条服务配置保存的 API 密钥，供“显示/隐藏”与切换时热应用。 */
export function providerKeyReveal(profileId: string): Promise<string | null> {
  return invoke("provider_key_reveal", { profileId });
}

export function providerKeyForget(profileId: string): Promise<void> {
  return invoke("provider_key_forget", { profileId });
}

export function cronList(): Promise<import("./types").CronJobRow[]> {
  return invoke("cron_list");
}

export function cronAdd(input: {
  expr: string;
  prompt: string;
  workspace?: string;
  model?: string;
  missedPolicy?: string;
}): Promise<import("./types").CronJobRow> {
  return invoke("cron_add", {
    expr: input.expr,
    prompt: input.prompt,
    workspace: input.workspace || null,
    model: input.model || null,
    missedPolicy: input.missedPolicy || "skip",
  });
}

export function cronRuns(id: string, limit?: number): Promise<import("./types").CronRunRow[]> {
  return invoke("cron_runs", { id, limit });
}

export function cronPause(id: string): Promise<void> {
  return invoke("cron_pause", { id });
}

export function cronResume(id: string): Promise<void> {
  return invoke("cron_resume", { id });
}

export function cronRemove(id: string): Promise<void> {
  return invoke("cron_remove", { id });
}

export function cronRunNow(id: string): Promise<string> {
  return invoke("cron_run_now", { id });
}

export function cronStopCurrent(id: string): Promise<string> {
  return invoke("cron_stop_current", { id });
}

export function memoryFiles(): Promise<import("./types").MemoryFiles> {
  return invoke("memory_files");
}

export function memorySet(kind: "soul" | "user" | "memory", body: string): Promise<void> {
  return invoke("memory_set", { kind, body });
}

export function memoryOpenDir(): Promise<void> {
  return invoke("memory_open_dir");
}

export function hooksOpenDir(): Promise<void> {
  return invoke("hooks_open_dir");
}

export function childrenList(sessionId: string): Promise<import("./types").ChildListItem[]> {
  return invoke("children_list", { sessionId });
}

export function hardwareProbe(): Promise<import("./types").HardwareProbe> {
  return invoke("hardware_probe");
}

export function localModels(): Promise<import("./types").LocalModel[]> {
  return invoke("local_models");
}

export function localModelImportPick(): Promise<import("./types").LocalModel | null> {
  return invoke("local_model_import_pick");
}

export function localModelImportMlxPick(): Promise<import("./types").LocalModel | null> {
  return invoke("local_model_import_mlx_pick");
}

export function localModelImportMlxPath(path: string): Promise<import("./types").LocalModel> {
  return invoke("local_model_import_mlx_path", { path });
}

export function mlxRunnerInstall(): Promise<string> {
  return invoke("mlx_runner_install");
}

export function localModelDownloadModelscope(repoId: string, filePath: string): Promise<import("./types").LocalModel> {
  return invoke("local_model_download_modelscope", { repoId, filePath });
}

export function modelDownloadStatus(): Promise<import("./types").ModelDownloadStatus> {
  return invoke("model_download_status");
}

export function localModelDelete(id: string): Promise<void> {
  return invoke("local_model_delete", { id });
}

export function localModelVerify(id: string): Promise<import("./types").LocalModel> {
  return invoke("local_model_verify", { id });
}

export function localModelActivate(id: string): Promise<import("./types").LocalModel> {
  return invoke("local_model_activate", { id });
}

export function sidecarStatus(): Promise<import("./types").SidecarStatus> {
  return invoke("sidecar_status");
}

export function sidecarLogs(): Promise<string> {
  return invoke("sidecar_logs");
}

export function sidecarStart(): Promise<string> {
  return invoke("sidecar_start");
}

export function sidecarStop(): Promise<void> {
  return invoke("sidecar_stop");
}

export function sidecarRestart(): Promise<string> {
  return invoke("sidecar_restart");
}

export function corpusList(): Promise<import("./types").CorpusDoc[]> {
  return invoke("corpus_list");
}

export function corpusImportPick(): Promise<import("./types").CorpusDoc | null> {
  return invoke("corpus_import_pick");
}

export function corpusDelete(id: string): Promise<void> {
  return invoke("corpus_delete", { id });
}

export function wikiStatus(workspace?: string): Promise<import("./types").WikiStatus> {
  return invoke("wiki_status", { workspace: workspace ?? null });
}

export function wikiShow(page?: string, workspace?: string): Promise<import("./types").WikiPage[]> {
  return invoke("wiki_show", { page: page ?? null, workspace: workspace ?? null });
}

export function wikiSearch(query: string, workspace?: string): Promise<import("./types").WikiHit[]> {
  return invoke("wiki_search", { query, workspace: workspace ?? null });
}

export function wikiCompile(workspace?: string): Promise<import("./types").WikiMeta> {
  return invoke("wiki_compile", { workspace: workspace ?? null });
}

/** 深度模型构建（概览＋分主题证据文章，全成或全败）。进度走 `_wiki_update`。 */
export function wikiBuildDeep(workspace?: string, incremental?: boolean): Promise<import("./types").WikiBuildReport> {
  return invoke("wiki_build_deep", { workspace: workspace ?? null, incremental: incremental ?? null });
}

/** 叫停进行中的深度构建；false = 没有在跑（请求不被记住，不会误杀下一次）。 */
export function wikiBuildCancel(workspace?: string): Promise<boolean> {
  return invoke("wiki_build_cancel", { workspace: workspace ?? null });
}

/** 扫描覆盖的真实故事；从未扫描过 = null。只读。 */
export function wikiCoverage(workspace?: string): Promise<import("./types").WikiCoverage | null> {
  return invoke("wiki_coverage", { workspace: workspace ?? null });
}

/** 首建前的覆盖预览：跑与构建扫描阶段同一趟索引（不落页面、不调模型）。 */
export function wikiCoveragePreview(workspace?: string): Promise<import("./types").WikiCoverage> {
  return invoke("wiki_coverage_preview", { workspace: workspace ?? null });
}

/** 打开证据引用 `rel:Lx-Ly`——core 校验路径必须在绑定项目内，越界即报错。 */
export function wikiReadSource(
  rel: string,
  start: number,
  end: number,
  workspace?: string,
): Promise<import("./types").WikiSourceWindow> {
  return invoke("wiki_read_source", { workspace: workspace ?? null, rel, start, end });
}

export function wikiAsk(question: string, workspace?: string): Promise<import("./types").WikiAnswer> {
  return invoke("wiki_ask", { question, workspace: workspace ?? null });
}

export function wikiOpenDir(workspace?: string): Promise<void> {
  return invoke("wiki_open_dir", { workspace: workspace ?? null });
}

export function wikiDistill(sessionId: string, workspace?: string): Promise<number> {
  return invoke("wiki_distill", { sessionId, workspace: workspace ?? null });
}

export function wikiProfile(workspace?: string): Promise<import("./types").WikiProfile | null> {
  return invoke("wiki_profile", { workspace: workspace ?? null });
}

export function wikiSetProfile(profile: import("./types").WikiProfile, workspace?: string): Promise<void> {
  return invoke("wiki_set_profile", { profile, workspace: workspace ?? null });
}

export function wikiEntries(workspace?: string): Promise<import("./types").WikiEntry[]> {
  return invoke("wiki_entries", { workspace: workspace ?? null });
}

export function wikiDrafts(sessionId: string): Promise<import("./types").WikiDraft[]> {
  return invoke("wiki_drafts", { sessionId });
}

export function wikiResolveDraft(payload: {
  draftId: string;
  mode: "project" | "directory" | "new";
  projectId?: string;
  path?: string;
  parent?: string;
  name?: string;
  publish?: boolean;
}): Promise<import("./types").WikiDraftOutcome> {
  return invoke("wiki_resolve_draft", {
    draftId: payload.draftId,
    mode: payload.mode,
    projectId: payload.projectId ?? null,
    path: payload.path ?? null,
    parent: payload.parent ?? null,
    name: payload.name ?? null,
    publish: payload.publish ?? false,
  });
}

export function wikiCancelDraft(draftId: string): Promise<boolean> {
  return invoke("wiki_cancel_draft", { draftId });
}

export function wikiReviewEntry(
  id: string,
  action: "approve" | "reject" | "undo",
  workspace?: string,
): Promise<void> {
  return invoke("wiki_review_entry", { id, action, workspace: workspace ?? null });
}

export function wikiEditEntry(
  id: string,
  content?: string,
  kind?: string,
  workspace?: string,
): Promise<void> {
  return invoke("wiki_edit_entry", { id, content: content ?? null, kind: kind ?? null, workspace: workspace ?? null });
}

export function specStart(
  mode: string,
  text: string,
  sessionId?: string,
): Promise<import("./types").SpecHandle> {
  return invoke("spec_start", { mode, text, sessionId: sessionId ?? null });
}

export function specRevise(specId: string, text: string): Promise<unknown> {
  return invoke("spec_revise", { specId, text });
}

export function specShow(specId: string): Promise<import("./types").SpecSnapshot> {
  return invoke("spec_show", { specId });
}

export function specDiff(specId: string): Promise<unknown> {
  return invoke("spec_diff", { specId });
}

export function specApprove(specId: string): Promise<import("./types").SpecSnapshot> {
  return invoke("spec_approve", { specId });
}

export function specRun(specId: string, text?: string): Promise<string> {
  return invoke("spec_run", { specId, text: text ?? null });
}

export function hostPermissionRespond(requestId: string, optionId: string): Promise<void> {
  return invoke("host_permission_respond", {
    answer: { requestId, optionId },
  });
}

export function hostPermissionPending(): Promise<import("./types").PermissionEvent[]> {
  return invoke("host_permission_pending");
}

/** Open an immutable chunk citation after rechecking its live permissions. */
export function spaceChunkSource(subjectId: string, spaceId: string, chunkId: string): Promise<KnowledgeChunkHit> {
  return invoke("space_chunk_source", { subjectId, spaceId, chunkId });
}

export function spaceDocumentPreview(subjectId: string, spaceId: string, documentId: string): Promise<import("./types").KnowledgeDocumentPreview> {
  return invoke("space_document_preview", { subjectId, spaceId, documentId });
}

// Project memory stays on the existing core ledger and project-scope gates.
export function projectMemoryList(projectId: string): Promise<import('./memory-view').ProjectMemoryEvent[]> {
  return invoke('context_memory_list', { domain: 'internal', scope: { projectId } });
}
export function projectMemoryAdd(projectId: string, content: string, kind: 'fact' | 'preference'): Promise<import('./memory-view').ProjectMemoryEvent> {
  return invoke('context_memory_add', { projectId, content, kind });
}
export function projectMemoryRevise(projectId: string, eventId: string, content: string): Promise<import('./memory-view').ProjectMemoryEvent> {
  return invoke('context_memory_revise', { domain: 'internal', scope: { projectId }, eventId, content });
}
export function projectMemoryConfirm(projectId: string, candidateId: string): Promise<import('./memory-view').ProjectMemoryEvent> {
  return invoke('context_memory_confirm_candidate', { domain: 'internal', scope: { projectId }, candidateId });
}
export function projectMemoryForget(projectId: string, eventId: string): Promise<import('./memory-view').ProjectMemoryEvent> {
  return invoke('context_memory_forget', { domain: 'internal', scope: { projectId }, eventId, reason: 'user requested forget' });
}
export function projectMemoryPreview(projectId: string, query: string, sessionId: string, tokenBudget: number, maxItems: number): Promise<import('./memory-view').MemoryPreviewPack> {
  return invoke('context_build_preview', { request: { sessionId, domain: 'internal', scope: { projectId }, query, tokenBudget, maxItems } });
}
export function projectMemoryGraph(projectId: string): Promise<{ nodes: unknown[]; edges: unknown[] }> {
  return invoke('context_entity_graph_projection', { domain: 'internal', scope: { projectId } });
}
export function projectMemoryMetrics(): Promise<{ total: number; degraded: number; averageLatencyMs: number }> {
  return invoke('preflight_metrics', { limit: 200 });
}

// Dandelion Open：无账号服务。更新检查走 GitHub Releases（Rust 侧做缓存与
// 地址白名单），下载在系统浏览器中完成。force=true 跳过后端 15 分钟缓存。
export const checkUpdate=(force=false)=>invoke<import('./types').UpdateInfo>('check_update',force?{force:true}:{});
export const openDownload=()=>invoke<void>('open_download');
export const openExternalUrl = (url: string) => invoke<void>("open_external_url", { url });

export function wikiSuggestProjectName(draftId:string):Promise<string>{return invoke("wiki_suggest_project_name",{draftId});}

export const knowledgeItemList = (query = "") => invoke<import("./types").KnowledgeItem[]>("knowledge_item_list", { query });
export const knowledgeItemGet = (id: string) => invoke<import("./types").KnowledgeItem>("knowledge_item_get", { id });
export const knowledgeItemSave = (input: import("./types").KnowledgeItemInput) => invoke<import("./types").KnowledgeItem>("knowledge_item_save", { input });
export const knowledgeItemsPick = (folder = false) => invoke<import("./types").KnowledgeCollectResult | null>("knowledge_items_pick", { folder });
export const knowledgeItemRetry = (id: string) => invoke<import("./types").KnowledgeItem>("knowledge_item_retry", { id });
export const knowledgeItemOrganize = (id: string, versionId: string, topics?: string[], favorite?: boolean) => invoke<void>("knowledge_item_organize", { id, versionId, topics: topics ?? null, favorite: favorite ?? null });
export const knowledgeItemAiPolicy = (enabled?: boolean) => invoke<boolean>("knowledge_item_ai_policy", { enabled: enabled ?? null });
export const knowledgeItemClassify = (id: string) => invoke<import("./types").KnowledgeItem>("knowledge_item_classify", { id });
export const knowledgeItemDelete = (id: string) => invoke<void>("knowledge_item_delete", { id });
export const knowledgeItemSaveDraft = (draftId: string) => invoke<import("./types").KnowledgeItem>("knowledge_item_save_draft", { draftId });
export const knowledgeItemExport = (id: string, original = false) => invoke<string | null>("knowledge_item_export", { id, original });
