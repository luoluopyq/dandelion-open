<template>
  <section class="chat">
    <div class="chat-row">
      <div class="chat-col" :class="{ full: !session.workspaceOpen }">
        <div ref="scroller" class="transcript" @scroll.passive="onScroll">
          <template v-if="!session.messages.length">
            <div class="welcome">
              <div class="logo"><BrandMark /></div>
              <h1>{{ session.detached ? "蒲公英 · 独立窗口" : "蒲公英" }}</h1>
              <p class="sub">
                本地 AI 助手。配置好模型后，在下方输入你的任务，Agent
                会在右侧实时展示执行过程。
              </p>
              <div class="model">
                <span class="dot" :class="session.info?.loopReady ? 'ok' : 'warn'" />
                <span>{{ session.info?.loopReady ? "已配置" : "未配置" }}</span>
                <span class="model-name">{{ modelLabel }}</span>
              </div>
              <!-- 三张能力卡片（设计稿）。空态原先只有一句提示，卡片把产品主张说清楚。 -->
              <div class="welcome-cards">
                <div class="welcome-card">
                  <span class="wc-icon">⚡</span>
                  <span class="wc-text"><strong>高效执行</strong><small>专业模型 · 快速响应</small></span>
                </div>
                <div class="welcome-card">
                  <span class="wc-icon">✦</span>
                  <span class="wc-text"><strong>智能协作</strong><small>让复杂任务更简单</small></span>
                </div>
                <div class="welcome-card">
                  <span class="wc-icon">⛨</span>
                  <span class="wc-text"><strong>数据安全</strong><small>本地运行 · 隐私可控</small></span>
                </div>
              </div>
              <p class="welcome-tagline"><span>从一个想法开始，创造无限可能</span></p>
              <p class="hint">Enter 发送 · Shift+Enter 换行 · {{ session.active?.kind ?? "任务" }} 会话</p>
            </div>
          </template>
          <template v-else>
            <div v-if="session.active?.historyRemaining" class="history-load">
              <button type="button" :disabled="session.active.loadingHistory" :aria-busy="session.active.loadingHistory" @click="loadOlderHistory">
                <span class="history-load-glyph" :class="{ spinning: session.active.loadingHistory }" aria-hidden="true">{{ session.active.loadingHistory ? "" : "↑" }}</span>
                <span>{{ session.active.loadingHistory ? "正在加载更早消息" : "加载更早消息" }}</span>
                <span v-if="!session.active.loadingHistory" class="history-load-count">{{ session.active.historyRemaining }}</span>
              </button>
            </div>
            <!-- 子代理只读。必须指名父会话是哪一条并提供跳转，否则「发给父会话」
                 这句话没有可执行性 —— 用户看不到父是谁，也没有入口。 -->
            <p v-if="session.readOnly" class="reason readonly-note">
              <span>子代理会话只读，回复请发给父会话</span>
              <button
                v-if="session.active?.parentId"
                type="button"
                :title="`跳转到父会话：${parentTitle}`"
                @click="session.promptParent(session.active.id)"
              >
                ↑ 父会话：{{ parentTitle }}
              </button>
              <button v-if="!session.detached" type="button" @click="session.viewTree()">在对话列表中查看子任务</button>
            </p>
            <!-- cron 会话可以继续聊（同一个 agent_loop），这里只说明来源并给个管理出口。 -->
            <p v-else-if="isCronSession" class="reason cron-note">
              <span>由定时任务创建，可以继续对话。</span>
              <button type="button" @click="session.openCron()">打开定时任务</button>
            </p>
            <template v-for="g in grouped" :key="groupKey(g)">
              <MessageBubble v-if="g.type === 'msg'" :msg="g.msg" @retry="retryPrompt" />
              <!-- 组里一条工具都没有的中间旁白：弱化展示，不配空思考卡片 -->
              <p v-else-if="g.type === 'narration'" class="narration-line">{{ g.msg.text }}</p>
              <ThinkingGroup v-else :items="g.items" />
            </template>
            <!-- 无项目会话的 Wiki 引导：用户完成选择后原草稿直接提交，无需重新输入。 -->
            <WikiDraftCard v-for="draft in wikiDraftList" :key="draft.draftId" :draft="draft" />
            <p v-if="hasDelegate || session.readOnly" class="row-btns pad">
              <button v-if="!session.detached && !session.readOnly" type="button" @click="session.viewTree()">在对话列表中查看子任务</button>
              <button
                v-if="session.active?.parentId"
                type="button"
                @click="session.promptParent(session.active.id)"
              >
                发给父
              </button>
              <button
                v-if="session.active"
                type="button"
                @click="session.stopTree(session.active.id)"
              >
                停止整棵树
              </button>
            </p>
          </template>
          <!-- 点击到首帧之间：目标对话立刻可见的加载态，不等 occupy/消息两轮 IPC。 -->
          <p v-if="session.pendingOpenId" class="gen" role="status">正在打开对话…</p>
          <p v-if="session.queued" class="gen" role="status">排队中（等待本地 sidecar 槽）… 停止可出队</p>
          <p v-else-if="session.running" class="gen" role="status">
            <template v-if="!session.messages.length">正在连接模型并准备任务…</template>
            <template v-else-if="session.activeToolGeneration">正在生成 {{ session.activeToolGeneration.name }} 的内容 · {{ formatBytes(session.activeToolGeneration.argumentBytes) }} · 已运行 {{ elapsedLabel }}</template>
            <template v-else>模型正在生成 · 已运行 {{ elapsedLabel }}</template>
          </p>
          <p v-else-if="taskEnded" class="done" :class="{ stopped: !!session.stopReason && session.stopReason !== 'end_turn' }">
            {{ session.stopReason && session.stopReason !== 'end_turn' ? "⛔ 任务已停止：" + session.stopReason : "✅ 任务已完成" }}
          </p>
          <article v-if="session.failedAttempt" class="prompt-failure" role="alert">
            <strong>任务未完成 · {{ engineName(session.failedAttempt.engineId) }}</strong>
            <p class="prompt-failure-reason">{{ session.failedAttempt.error }}</p>
            <p class="prompt-failure-label">原始任务</p>
            <pre>{{ session.failedAttempt.prompt }}</pre>
            <div class="prompt-failure-actions">
              <button type="button" @click="copyFailedPrompt">{{ failureCopied ? "已复制" : "复制提示词" }}</button>
              <button type="button" :disabled="!session.canSend || session.running || session.queued" @click="retryFailedPrompt">{{ session.failedAttempt.error.includes("蒲公英本机模型服务未运行") ? "启动模型并重试" : "按原任务重试" }}</button>
            </div>
          </article>
          <p v-if="session.error" class="err" role="alert">{{ session.error }}</p>
        </div>

        <!-- 用户上滑读历史时显示：一键回到最新消息 -->
        <button
          v-if="!atBottom && newSinceUnread > 0"
          type="button"
          class="jump-bottom"
          @click="jumpToBottom"
        >
          ↓ {{ newSinceUnread }} 条新消息
        </button>

        <BackgroundTaskBar />
        <form ref="composerRoot" class="composer" @submit.prevent="onSend">
          <div v-if="refineSource" class="composer-refine-status">
            <span>✦ 已整理，可直接修改</span>
            <button type="button" :aria-expanded="showOriginal" @click="showOriginal = !showOriginal">{{ showOriginal ? "收起原文" : "查看原文" }}</button>
            <button type="button" @click="undoRefinement">撤销整理</button>
          </div>
          <p v-if="refineSource && showOriginal" class="composer-original">{{ refineSource }}</p>
          <p v-if="refineError" class="prompt-refine-error" role="alert">{{ refineError }}</p>
          <textarea ref="composerInput" v-model="draft" :class="{ 'is-refined': refineSource }" :disabled="(!!session.active && !session.canSend && !session.running) || session.readOnly" :placeholder="session.readOnly ? readOnlyPlaceholder : '输入消息。Enter 发送，Shift+Enter 换行'" rows="1" @keydown="onKey" @input="autoResize" @paste="onPaste" />
          <div v-if="attachments.length" class="composer-attachments">
            <template v-for="item in attachments" :key="item.path">
              <!-- 图片附件显示缩略图（点击放大）；纯路径附件仍是芯片。 -->
              <span v-if="item.dataUrl" class="attachment-thumb" :title="item.path">
                <button type="button" class="attachment-thumb-img" title="点击放大" @click="lightbox = item.dataUrl || ''"><img :src="item.dataUrl" :alt="item.name" loading="lazy" /></button>
                <button type="button" class="attachment-thumb-remove" title="移除" aria-label="移除附件" @click="removeAttachment(item.path)">×</button>
              </span>
              <span v-else class="attachment-chip" :title="item.path">{{ item.kind === 'image' ? '▧' : item.kind === 'folder' ? '▣' : '▤' }} {{ item.name }}<button type="button" title="移除" @click="removeAttachment(item.path)">×</button></span>
            </template>
          </div>
          <p v-if="hasImageAttachment && engineVision === 'files'" class="composer-vision-note">当前 Agent 没有图像输入通道，图片将保存为本地文件并要求它用自己的工具查看。</p>
          <div class="composer-footer">
            <div class="composer-left">
              <div class="composer-menu-root" data-composer-menu="attach">
                <button type="button" class="composer-icon" title="添加上下文" aria-label="添加上下文" :disabled="session.readOnly" @click="attachOpen = !attachOpen">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                </button>
                <div v-if="attachOpen" class="composer-menu composer-attach-menu">
                  <p class="composer-menu-title">添加上下文</p>
                  <button type="button" class="composer-attach-action" @click="attachFolder">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l1.8 2H20.5v8.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z" /></svg>
                    <span><b>文件夹</b><small>作为本次任务的工作区</small></span>
                  </button>
                  <button type="button" class="composer-attach-action" @click="attachFiles(false)">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h7l4 4v13H6.5zM13.5 3.5v4h4M8.5 12h7M8.5 16h7" /></svg>
                    <span><b>文件</b><small>附加路径供 Agent 读取</small></span>
                  </button>
                  <button type="button" class="composer-attach-action" @click="attachFiles(true)">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m5.5 17 4.5-4 3 2.5 2.5-2 3 3.5" /></svg>
                    <span><b>图片</b><small>也可直接粘贴或拖拽进输入框</small></span>
                  </button>
                  <div class="composer-auto-routing">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" /></svg>
                    <p v-if="!externalAgent"><b>扩展能力</b><small>Skill 需在下方为当前对话选用；MCP 按任务配置使用。</small></p>
                    <p v-else><b>使用外部 Agent 插件</b><small>本地知识可按需检索；蒲公英的技能和其他 MCP 配置由各引擎分别管理。</small></p>
                  </div>
                </div>
              </div>
              <span v-if="session.selectedFolder" class="composer-workspace-chip" :title="`当前工作区：${session.selectedFolder}`"><span>▣</span><strong>{{ workspaceName }}</strong><button type="button" title="移除当前工作区" aria-label="移除当前工作区" @click="clearWorkspace">×</button></span>
              <div class="composer-menu-root" data-composer-menu="agent"><button type="button" class="composer-chip" :title="session.running || session.queued ? '任务运行中，结束后可切换 Agent' : '手动选择当前任务的 Agent'" :disabled="session.readOnly || session.running || session.queued" @click="agentOpen = !agentOpen">{{ agentLabel }} <span>⌄</span></button><div v-if="agentOpen" class="composer-menu mode-menu"><button type="button" @click="selectAgent('native')"><b>蒲公英原生</b><small>默认 Agent</small></button><button v-for="plugin in session.agentPlugins.filter(p => p.id !== 'native' && p.installed)" :key="plugin.id" type="button" :disabled="!plugin.ready" @click="selectAgent(plugin.id)"><b>{{ plugin.name }}</b><small>{{ plugin.ready ? '使用已配置插件' : '程序未找到，请先配置' }}</small></button><button type="button" @click="agentOpen = false; session.openPlugins()"><b>管理 Agent 插件</b></button></div></div>
              <div v-if="!externalAgent && !session.running && !session.queued" class="composer-menu-root" data-composer-menu="skill"><button type="button" class="composer-chip" title="选择当前对话使用的技能" :disabled="session.readOnly" @click="skillOpen = !skillOpen">技能 {{ selectedSkillCount }} <span>⌄</span></button><div v-if="skillOpen" class="composer-menu mode-menu"><p class="composer-menu-title">当前对话使用的技能</p><p v-if="!availableSkills.length">暂无可用技能，请先到插件页添加。</p><p v-if="session.panelError" role="alert">{{ session.panelError }}</p><button v-for="skill in availableSkills" :key="skill.id" type="button" :class="{ selected: session.active?.skillIds.includes(skill.id) }" @click="toggleSkill(skill.id)"><b>{{ session.active?.skillIds.includes(skill.id) ? '✓ ' : '' }}{{ skill.id }}</b><small>{{ skill.description }}</small></button><p>只需生成文字时，可选“问答”模式以避免调用工具。</p><button type="button" @click="skillOpen = false; session.openPlugins()"><b>管理技能</b></button></div></div>
              <div class="composer-menu-root" data-composer-menu="mode"><button type="button" class="composer-chip" :title="session.running || session.queued ? '任务运行中，结束后可切换模式' : activeModeHint" :disabled="session.readOnly || session.running || session.queued" @click="modeOpen = !modeOpen">{{ modeLabel }} <span>⌄</span></button><div v-if="modeOpen" class="composer-menu mode-menu"><button v-for="item in taskModes" :key="item.id" type="button" :class="{ selected: mode === item.id }" :disabled="externalAgent && item.id !== 'auto'" @click="selectMode(item.id)"><b>{{ item.label }}</b><small>{{ item.hint }}</small></button></div></div>
              <div class="composer-menu-root" data-composer-menu="perm"><button type="button" class="composer-chip" :title="restrictedExternal ? '受限运行：敏感操作不会执行；点选可改为自动批准' : '设置当前任务的授权方式，选定即生效'" :disabled="session.readOnly" @click="permOpen = !permOpen">◌ {{ permissionLabel }} <span>⌄</span></button><div v-if="permOpen" class="composer-menu mode-menu"><p class="composer-menu-title">本任务的授权方式</p><button v-for="item in permissionOptions" :key="item.id" type="button" :class="{ selected: effectivePermission === item.id }" @click="selectPermission(item.id)"><b>{{ effectivePermission === item.id ? '✓ ' : '' }}{{ item.label }}</b><small>{{ item.hint }}</small></button><p v-if="restrictedExternal">受限运行：OpenCode 仅允许读取，Pi 不使用工具。需要编辑或执行命令请选「自动批准」。</p><button v-if="session.active?.prefs.permissionMode" type="button" @click="selectPermission(null)"><b>跟随全局设置</b><small>本任务不再单独指定（全局当前为「{{ globalPermissionLabel }}」）</small></button></div></div>
            </div>
            <div class="composer-right">
              <button v-if="!session.running && !session.queued && !refineSource" type="button" class="composer-refine" :disabled="!draft.trim() || refining || (!!session.active && !session.canSend) || session.readOnly" title="用当前模型整理任务，结果直接填入输入框" @click="refineTask">{{ refining ? "整理中…" : "✦ 整理任务" }}</button>
              <div class="composer-menu-root composer-model-menu-root" data-composer-menu="model">
                <button type="button" class="composer-model" :title="session.running || session.queued ? '任务运行中，结束后可切换模型' : `切换模型：${composerModel}`" :disabled="session.readOnly || session.running || session.queued" @click="toggleModelMenu"><span class="composer-model-name">{{ composerModel }}</span><span class="composer-model-caret" aria-hidden="true">⌄</span></button>
                <div v-if="modelOpen" class="composer-menu mode-menu">
                  <p class="composer-menu-title">模型服务</p>
                  <p v-if="session.panelError" role="alert">{{ session.panelError }}</p>
                  <p v-if="!session.providerProfiles.length" class="composer-menu-title">尚未保存服务地址。</p>
                  <button v-for="p in session.providerProfiles" :key="p.id" type="button" :class="{ selected: p.id === session.activeProviderProfile?.id }" :disabled="switchingModel" @click="chooseProfile(p.id)"><b>{{ p.id === session.activeProviderProfile?.id ? '✓ ' : '' }}{{ p.name }}</b><small>{{ backendKind(p.backend) }} · {{ p.baseUrl }}</small></button>
                  <p class="composer-menu-title">本机模型</p>
                  <p v-if="!session.localModels.length" class="composer-menu-title">本机还没有导入模型。</p>
                  <button v-for="m in session.localModels" :key="m.id" type="button" :class="{ selected: isLocalDefault(m.id) }" :disabled="switchingModel" @click="chooseLocalModel(m.id)"><b>{{ isLocalDefault(m.id) ? '✓ ' : '' }}{{ m.name }}</b><small>{{ m.format.toUpperCase() }} · {{ m.quant }}</small></button>
                  <button type="button" @click="modelOpen = false; session.openSettings('models')"><b>管理模型</b></button>
                </div>
              </div>
              <button v-if="session.running || session.stopping || session.queued" type="button" class="composer-send stop" :disabled="session.stopping" title="停止生成" @click="session.stop()">■</button>
              <button v-else type="submit" class="composer-send" :disabled="(!!session.active && !session.canSend) || (!draft.trim() && !attachments.length) || session.readOnly" :title="refineSource ? '发送整理后的任务' : '发送'" :aria-label="refineSource ? '发送整理后的任务' : '发送'"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0-6 6m6-6 6 6" /></svg></button>
            </div>
          </div>
          <div v-if="dragActive" class="composer-drop" aria-hidden="true">松手添加：图片作为视觉输入，文件按路径附加</div>
        </form>

      </div>

    </div>

    <Teleport to="body">
      <div v-if="lightbox" class="image-lightbox" role="dialog" aria-label="图片预览" @click="lightbox = ''">
        <img :src="lightbox" alt="图片预览" @click.stop />
        <button type="button" class="image-lightbox-close" aria-label="关闭" @click="lightbox = ''">×</button>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { providerBackendLabel, useSessionStore } from "../stores/session";
import { agentEngineVision, fileImageDataUrl, filePick, promptRefine } from "../lib/ipc";
import { groupKey, groupMessages } from "../lib/group-messages";
import MessageBubble from "./MessageBubble.vue";
import BrandMark from "./BrandMark.vue";
import ThinkingGroup from "./ThinkingGroup.vue";
import WikiDraftCard from "./WikiDraftCard.vue";
import BackgroundTaskBar from "./BackgroundTaskBar.vue";

const session = useSessionStore();
const failureCopied = ref(false);
const clockNow = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
const elapsedLabel = computed(() => {
  const startedAt = session.runState[session.sessionId]?.startedAt ?? clockNow.value;
  const secs = Math.max(0, Math.floor((clockNow.value - startedAt) / 1000));
  return secs < 60 ? `${secs} 秒` : `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`;
});
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
const workspaceName = computed(() => session.selectedFolder?.split(/[\\/]/).filter(Boolean).pop() || "工作区");
const hasDelegate = computed(() =>
  session.messages.some(
    (m) => m.kind === "delegate_task" || (m.role === "tool" && m.text.includes("delegate_task")),
  ),
);

// 欢迎页显示的模型名（当前任务 prefs 优先，否则用全局默认）
const modelLabel = computed(() => {
  const rec = session.active;
  const g = session.settings?.values ?? {};
  return rec?.prefs.model || String(g["dandelion.defaultModel"] ?? "模型未设");
});

// 任务是否已结束（非运行/排队、无报错、且已产生过助手回复）——用于显示"结束状态"标识
const taskEnded = computed(() => {
  if (session.running || session.queued) return false;
  if (session.error || session.failedAttempt || session.stopReason === "error") return false;
  return session.messages.some((m) => m.role === "assistant");
});

// 连续工具调用合并成"思考过程"块
const grouped = computed(() => groupMessages(session.messages));
// 当前对话的 Wiki 草稿（无项目引导），按会话隔离展示。
const wikiDraftList = computed(() => (session.active ? session.wikiDrafts[session.active.id] ?? [] : []));
const drafts = ref<Record<string, string>>({});
const emptyDraft = ref("");
const refining = ref(false);
const refineSource = ref("");
const showOriginal = ref(false);
const refineError = ref("");
let refineVersion = 0;
type Attachment = { path: string; name: string; kind: "file" | "image" | "folder"; dataUrl?: string };
const attachments = ref<Attachment[]>([]);
const lightbox = ref("");
const dragActive = ref(false);
// 引擎图像入口：images=结构化图像块直达模型；files=落盘后由引擎工具读取（降级）。
const engineVision = ref<"images" | "files">("images");
watch(() => session.active?.prefs.agentEngine || "native", (engine) => {
  agentEngineVision(engine).then((mode) => { engineVision.value = mode; }, () => { engineVision.value = "images"; });
}, { immediate: true });
const hasImageAttachment = computed(() => attachments.value.some((item) => item.kind === "image"));
const attachOpen = ref(false);
const agentOpen = ref(false);
const modeOpen = ref(false);
const skillOpen = ref(false);
const permOpen = ref(false);
const mode = ref<"ask" | "plan" | "auto">("auto");
const taskModes: { id: "ask" | "plan" | "auto"; label: string; hint: string }[] = [
  { id: "ask", label: "问答", hint: "只基于对话回答，不调用工具" },
  { id: "plan", label: "规划", hint: "需要时只读分析工作区，不做修改" },
  { id: "auto", label: "执行", hint: "按任务需要使用工具完成工作" },
];
const activeModeHint = computed(() => taskModes.find((item) => item.id === mode.value)?.hint ?? "");
const modeLabel = computed(() => taskModes.find((item) => item.id === mode.value)?.label ?? "执行");
const externalAgent = computed(() => !!session.active?.prefs.agentEngine && session.active.prefs.agentEngine !== "native");
const availableSkills = computed(() => session.skills.filter((item) => !item.framework && item.enabled));
const selectedSkillCount = computed(() => session.active?.skillIds.filter((id) => availableSkills.value.some((item) => item.id === id)).length ?? 0);
function toggleSkill(id: string) {
  const current = session.active?.skillIds ?? [];
  const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
  void session.setSkillIds(next);
}
function engineName(id: string) { return ({ native: "蒲公英原生", claude_code: "Claude Code", opencode: "OpenCode", pi: "Pi" } as Record<string, string>)[id] || id; }
const agentLabel = computed(() => engineName(session.active?.prefs.agentEngine || "native"));
// 授权从「跳去设置里改」改成「输入栏原地选」：授权是逐任务的决定，就该在使用
// 它的那一行原地改，和 Agent/模式芯片同一交互语法。选项与任务配置面板同词表。
const effectivePermission = computed<"ask" | "auto" | "deny">(() => {
  const value = String(session.active?.prefs.permissionMode ?? session.settings?.values["dandelion.permissionMode"] ?? "ask");
  return value === "auto" || value === "deny" || value === "ask" ? value : "ask";
});
// Pi / OpenCode 弹不出蒲公英的逐项授权框，ask 实际是只读受限模式 —— 芯片如实标注。
// Claude Code 有桥接授权弹窗，不算受限。
const restrictedExternal = computed(() => ["pi", "opencode"].includes(session.active?.prefs.agentEngine || "") && effectivePermission.value === "ask");
const permissionOptions: { id: "ask" | "auto" | "deny"; label: string; hint: string }[] = [
  { id: "ask", label: "敏感操作询问", hint: "敏感工具逐次经你确认后才执行" },
  { id: "auto", label: "自动批准", hint: "工具操作直接执行，不再弹确认" },
  { id: "deny", label: "拒绝需确认操作", hint: "遇到需确认的操作直接拒绝" },
];
const permissionLabel = computed(() => restrictedExternal.value
  ? "受限运行"
  : permissionOptions.find((item) => item.id === effectivePermission.value)?.label ?? "敏感操作询问");
const effectiveGlobalPermission = computed<"ask" | "auto" | "deny">(() => {
  const value = String(session.settings?.values["dandelion.permissionMode"] ?? "ask");
  return value === "auto" || value === "deny" || value === "ask" ? value : "ask";
});
const globalPermissionLabel = computed(() => permissionOptions.find((item) => item.id === effectiveGlobalPermission.value)?.label ?? "敏感操作询问");
async function selectPermission(next: "ask" | "auto" | "deny" | null) {
  permOpen.value = false;
  // 白纸上还没有任务可挂权限 —— 先落那条空白任务（有未命名的空任务则复用），
  // 与选工作区 setTaskWorkspace 的处理同构。
  if (!session.active) await session.newTask();
  // null = 撤销本任务覆盖、回到全局值；序列化时 undefined 键会被剥掉。
  await session.savePrefs({ permissionMode: next ?? undefined });
}
const composerModel = computed(() => {
  if (session.active?.prefs.model) return session.active.prefs.model;
  const values = session.settings?.values ?? {};
  const model = String(values["dandelion.defaultModel"] ?? "");
  if (values["dandelion.defaultBackend"] === "sidecar" && model && model !== session.localModels.find((item) => item.active)?.id) return "模型配置待检查";
  return model || "选择模型";
});

// 输入栏里直接选已配置好的模型：服务地址列表（含历史保存的 API）+ 本机模型。
// 切换即热应用全局默认，只影响之后的任务；运行中禁用，不动正在流的连接。
const modelOpen = ref(false);
const switchingModel = ref(false);
function backendKind(backend: string) { return providerBackendLabel(backend); }
function isLocalDefault(id: string) {
  const values = session.settings?.values ?? {};
  return values["dandelion.defaultBackend"] === "sidecar" && String(values["dandelion.defaultModel"] ?? "") === id;
}
function toggleModelMenu() {
  modelOpen.value = !modelOpen.value;
  if (modelOpen.value) {
    // 老单地址配置可能还没进列表（比如首次引导刚保存）；打开时补一次引导。
    void session.ensureProviderProfilesSeeded().catch(() => undefined);
    void session.refreshSidecar().catch(() => undefined);
  }
}
async function chooseProfile(id: string) {
  if (switchingModel.value || session.running || session.queued) return;
  switchingModel.value = true;
  const ok = await session.applyProviderProfile(id);
  switchingModel.value = false;
  if (ok) modelOpen.value = false;
}
async function chooseLocalModel(id: string) {
  if (switchingModel.value || session.running || session.queued) return;
  switchingModel.value = true;
  const ok = await session.switchToLocalModel(id);
  switchingModel.value = false;
  if (ok) modelOpen.value = false;
}

// 只读现在只剩子代理一种（cron 已放开为可写）。
// 光说「发给父会话」没用 —— 得让人知道父是哪一条、并且能直接跳过去。
const parentRow = computed(() => {
  const pid = session.active?.parentId;
  if (!pid) return null;
  return session.rows.find((row) => row.id === pid) ?? null;
});
const parentTitle = computed(() => parentRow.value?.title || "未命名任务");
const readOnlyPlaceholder = "子代理会话只读，回复请发给父会话";

// cron 会话可写，但得让人知道它是定时任务产出的，并给一个去管理的出口。
const isCronSession = computed(() => session.active?.kind === "cron");
const draft = computed({
  get: () => (session.sessionId ? drafts.value[session.sessionId] ?? "" : emptyDraft.value),
  set: (value: string) => {
    if (!session.sessionId) { emptyDraft.value = value; return; }
    drafts.value = { ...drafts.value, [session.sessionId]: value };
  },
});
const scroller = ref<HTMLElement | null>(null);
const composerRoot = ref<HTMLFormElement | null>(null);
const composerInput = ref<HTMLTextAreaElement | null>(null);
let composerObserver: ResizeObserver | null = null;
let lastComposerWidth = 0;

// 用户是否"贴底"——仅用于决定是否显示"↓ N 条新消息"按钮
// 不再用来阻止自动滚动：新消息永远要可见
const atBottom = ref(true);
const loadingOlderHistory = ref(false);
// 用户上滑后新到的消息数：决定按钮文案
const newSinceUnread = ref(0);
let lastSeenCount = 0;

function onScroll() {
  const el = scroller.value;
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  const wasAtBottom = atBottom.value;
  atBottom.value = distance < 48;
  // 刚贴回底 → 重置未读计数
  if (atBottom.value && !wasAtBottom) {
    newSinceUnread.value = 0;
    lastSeenCount = session.messages.length;
  }
}

// 把 transcript 滚到底：rAF 保证布局完成（markdown / 代码块渲染后才量真实高度）
function scrollToBottom() {
  const el = scroller.value;
  if (!el) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const e = scroller.value;
      if (e) e.scrollTop = e.scrollHeight;
    });
  });
}

async function loadOlderHistory() {
  const el = scroller.value;
  if (!el || loadingOlderHistory.value) return;
  const previousHeight = el.scrollHeight;
  const previousTop = el.scrollTop;
  loadingOlderHistory.value = true;
  try {
    await session.loadOlderMessages();
    await nextTick();
    if (scroller.value === el) el.scrollTop = previousTop + el.scrollHeight - previousHeight;
  } finally {
    loadingOlderHistory.value = false;
    lastSeenCount = session.messages.length;
  }
}

// 关键：监视消息数量（新增消息）+ 文本长度（流式 chunk）
// 任一变化都强制滚到底，不被"是否贴底"拦截
// flush: 'post' 保证 DOM 已更新再读 scrollHeight
watch(
  () => session.messages.length,
  (newLen) => {
    if (loadingOlderHistory.value) {
      lastSeenCount = newLen;
      return;
    }
    if (newLen > lastSeenCount) {
      newSinceUnread.value += newLen - lastSeenCount;
      lastSeenCount = newLen;
    }
    scrollToBottom();
  },
  { flush: "post" },
);

watch(
  () => session.messages.map((m) => m.text.length).join(","),
  () => {
    if (loadingOlderHistory.value) return;
    scrollToBottom();
  },
  { flush: "post" },
);

watch(() => session.sessionId, (_newId, oldId) => {
  if (refineSource.value) {
    if (oldId) drafts.value = { ...drafts.value, [oldId]: refineSource.value };
    else emptyDraft.value = refineSource.value;
  }
  clearRefinement();
  attachments.value = [];
  attachOpen.value = false;
  modeOpen.value = false;
  agentOpen.value = false;
  skillOpen.value = false;
  modelOpen.value = false;
}, { immediate: true });
watch(externalAgent, (active) => { if (active) mode.value = "auto"; });

function jumpToBottom() {
  scrollToBottom();
  newSinceUnread.value = 0;
  lastSeenCount = session.messages.length;
}

function onKey(ev: KeyboardEvent) {
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    void onSend();
  }
}

function autoResize(ev?: Event) {
  const input = (ev?.target as HTMLTextAreaElement | null) ?? composerInput.value;
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

function clearRefinement() {
  refineVersion++;
  refineSource.value = "";
  showOriginal.value = false;
  refineError.value = "";
  refining.value = false;
}

async function undoRefinement() {
  if (!refineSource.value) return;
  const original = refineSource.value;
  clearRefinement();
  draft.value = original;
  await nextTick();
  autoResize();
  composerInput.value?.focus();
}

async function refineTask() {
  const source = draft.value;
  if (!source.trim() || refining.value || session.running || session.queued) return;
  const version = ++refineVersion;
  const sessionId = session.sessionId || undefined;
  refining.value = true;
  refineError.value = "";
  try {
    const result = await promptRefine(source, sessionId);
    if (version !== refineVersion || draft.value !== source || session.sessionId !== (sessionId || "")) return;
    refineSource.value = source;
    draft.value = result;
    await nextTick();
    autoResize();
    composerInput.value?.focus();
  } catch (error) {
    if (version === refineVersion) refineError.value = `整理失败：${error instanceof Error ? error.message : String(error)}。可以直接发送原文。`;
  } finally {
    if (version === refineVersion) refining.value = false;
  }
}

function selectMode(next: "ask" | "plan" | "auto") { mode.value = next; modeOpen.value = false; }
async function selectAgent(id: "native" | "claude_code" | "opencode" | "pi") {
  agentOpen.value = false;
  if (session.running || session.queued) return;
  await session.savePrefs({ agentEngine: id });
  mode.value = "auto";
}

// 点击菜单外部 / 按 Esc 关闭输入栏的下拉菜单（各自只对自己的 composer-menu-root 免疫）
function onDocumentPointer(event: PointerEvent) {
  const root = (event.target as HTMLElement | null)?.closest?.("[data-composer-menu]") as HTMLElement | null;
  const which = root?.dataset.composerMenu;
  if (which !== "attach") attachOpen.value = false;
  if (which !== "mode") modeOpen.value = false;
  if (which !== "agent") agentOpen.value = false;
  if (which !== "skill") skillOpen.value = false;
  if (which !== "perm") permOpen.value = false;
  if (which !== "model") modelOpen.value = false;
}
function onDocumentEscape(event: KeyboardEvent) {
  if (event.key !== "Escape" || (!attachOpen.value && !modeOpen.value && !agentOpen.value && !skillOpen.value && !permOpen.value && !modelOpen.value)) return;
  attachOpen.value = false;
  modeOpen.value = false;
  agentOpen.value = false;
  skillOpen.value = false;
  permOpen.value = false;
  modelOpen.value = false;
}
onMounted(() => {
  // ChatPane 在设置/记忆等页面切走时被卸载、切回时重新挂载。重新挂载时
  // store 里的消息并未变化，length/text 两个 watcher 都不触发，新的 scroller
  // 停在顶部（看起来像"定位在中间"）。挂载即贴到底部，回到最新一条。
  lastSeenCount = session.messages.length;
  atBottom.value = true;
  void nextTick(scrollToBottom);
  void session.refreshAgentPlugins();
  document.addEventListener("pointerdown", onDocumentPointer);
  window.addEventListener("keydown", onDocumentEscape);
  // 拖拽走 Tauri 的原生桥（HTML5 drop 在 webview 里拿不到真实路径）：
  // 图片读成 data URL 作为视觉输入，其余文件按路径附加给 Agent。
  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      dragActive.value = false;
      void addDroppedPaths(event.payload.paths ?? []);
    } else if (event.payload.type === "enter" || event.payload.type === "over") {
      dragActive.value = !session.readOnly;
    } else {
      dragActive.value = false;
    }
  }).then((fn) => { unlistenDragDrop = fn; });
  if (composerRoot.value) {
    composerObserver = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === lastComposerWidth) return;
      lastComposerWidth = entry.contentRect.width;
      autoResize();
    });
    composerObserver.observe(composerRoot.value);
  }
  clockTimer = window.setInterval(() => { clockNow.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointer);
  window.removeEventListener("keydown", onDocumentEscape);
  unlistenDragDrop?.();
  composerObserver?.disconnect();
  if (clockTimer) window.clearInterval(clockTimer);
});
let unlistenDragDrop: (() => void) | undefined;

async function copyFailedPrompt() {
  const prompt = session.failedAttempt?.prompt;
  if (!prompt) return;
  try {
    await navigator.clipboard.writeText(prompt);
    failureCopied.value = true;
    window.setTimeout(() => { failureCopied.value = false; }, 1500);
  } catch {
    session.error = "复制失败，请手动选中提示词复制。";
  }
}

async function retryFailedPrompt() {
  await session.retryFailedPrompt();
}

async function retryPrompt(text: string) {
  if (!session.canSend || session.running || session.queued) return;
  const sent = await session.sendOrCreate(text, "auto");
  if (!sent) {
    draft.value = text;
    await nextTick();
    autoResize();
    composerInput.value?.focus();
  }
}

function attachmentName(path: string) { return path.split(/[\\/]/).filter(Boolean).pop() || path; }
function addAttachments(paths: string[], kind: Attachment["kind"]) {
  const known = new Set(attachments.value.map((item) => item.path));
  attachments.value = [...attachments.value, ...paths.filter((path) => !known.has(path)).map((path) => ({ path, name: attachmentName(path), kind }))];
}
function removeAttachment(path: string) { attachments.value = attachments.value.filter((item) => item.path !== path); }
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取剪贴板图片"));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("剪贴板图片格式无效"));
    reader.readAsDataURL(file);
  });
}
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
async function addDroppedPaths(paths: string[]) {
  if (!paths.length || session.readOnly) return;
  const known = new Set(attachments.value.map((item) => item.path));
  for (const path of paths) {
    if (known.has(path)) continue;
    if (IMAGE_EXT.test(path)) {
      try {
        attachments.value.push({ path, name: attachmentName(path), kind: "image", dataUrl: await fileImageDataUrl(path) });
      } catch (error) {
        session.error = `${attachmentName(path)}：${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      attachments.value.push({ path, name: attachmentName(path), kind: "file" });
    }
  }
}

async function onPaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (!files.length) return;
  event.preventDefault();
  try {
    const dataUrls = await Promise.all(files.map(readAsDataUrl));
    const stamp = Date.now();
    attachments.value = [...attachments.value, ...dataUrls.map((dataUrl, index) => ({
      path: `clipboard-image-${stamp}-${index + 1}`,
      name: `剪贴板图片 ${index + 1}`,
      kind: "image" as const,
      dataUrl,
    }))];
  } catch (error) {
    session.error = error instanceof Error ? error.message : String(error);
  }
}
async function attachFolder() { const folder = await session.selectFolder(); if (folder) await session.setTaskWorkspace(folder); attachOpen.value = false; }
function clearWorkspace() { void session.clearTaskWorkspace(); }
async function attachFiles(imagesOnly: boolean) {
  attachOpen.value = false;
  const paths = await filePick(imagesOnly);
  if (!paths.length) return;
  if (!imagesOnly) { addAttachments(paths, "file"); return; }
  // 选图必须真的发图：读取成 data URL，和粘贴/拖拽同一条视觉输入通道。
  await addDroppedPaths(paths);
}

async function onSend() {
  const text = draft.value;
  if ((!text.trim() && !attachments.value.length) || (session.active && !session.canSend)) return;
  const reviewed = refineSource.value && text.trim()
    ? `[原始任务]\n${refineSource.value}\n\n[用户确认的任务说明]\n${text.trim()}\n\n请按用户确认的任务说明执行；原始任务用于核对，不要添加未确认的要求。`
    : text;
  const imageLabel = engineVision.value === "images" ? "视觉图片（已作为模型图像输入发送）" : "图片（已保存为本地文件，请用自己的文件/图像工具查看）";
  const attachmentContext = attachments.value.length ? `\n\n[已附加本地上下文]\n${attachments.value.map((item) => `- ${item.kind === "image" ? imageLabel : item.kind === "folder" ? "文件夹" : "文件"}: ${item.path}`).join("\n")}` : "";
  const pendingAttachments = attachments.value;
  const pendingRefinement = refineSource.value;
  // Clear optimistically.  The first prompt can create a task (and therefore
  // switch the draft key) while it is being submitted; waiting until that
  // completes leaves the submitted text stranded in the composer.
  draft.value = "";
  emptyDraft.value = "";
  attachments.value = [];
  clearRefinement();
  await nextTick();
  autoResize();
  let sent = false;
  try {
    sent = await session.sendOrCreate(reviewed + attachmentContext, mode.value, pendingAttachments.flatMap((item) => item.dataUrl ? [item.dataUrl] : []));
  } catch (error) {
    // Creating the first task can fail before send() gets to record an error.
    // Never restore the draft without explaining why it was not submitted.
    session.error = error instanceof Error ? error.message : String(error);
  }
  if (sent) return;
  // A transport/validation failure has not created a message, so keep the
  // user's work available for correction and retry.
  draft.value = text;
  attachments.value = pendingAttachments;
  refineSource.value = pendingRefinement;
  await nextTick();
  autoResize();
}
</script>

<style scoped>
/* 模型菜单贴着输入栏右缘，向左展开，避免窄窗口时越过窗口右边界。 */
.composer-model-menu-root .composer-menu { left: auto; right: 0; }
</style>
