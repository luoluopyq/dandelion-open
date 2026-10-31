<template>
  <section class="space-view">
    <div class="space-navigation">
      <nav class="space-tabs" aria-label="知识库内容">
        <button v-for="item in TABS" :key="item.id" type="button" :class="{ active: tab === item.id }" :aria-current="tab === item.id ? 'page' : undefined" @click="tab = item.id">{{ item.label }}</button>
      </nav>
      <details class="space-manage"><summary>管理</summary><div>
        <button type="button" @click="tab = 'settings'">知识库设置</button>
        <button type="button" @click="tab = 'ledger'">提议记录</button>
      </div></details>
    </div>
    <p v-if="error" class="corpus-error" role="alert">{{ error }}</p>

    <!-- 阅读：空间自己的 Wiki 文章（space_status/space_show，与检索同一道读闸）。 -->
    <section v-show="tab === 'read'" class="space-tab-body" aria-label="文章阅读">
      <div class="article-build">
        <h2>知识文章</h2>
        <p class="hub-help">把资料整理成有出处的主题文章。资料更新后，可在这里更新文章。</p>
        <div v-if="deepBusy" class="build-progress" role="status">
          <span>{{ deepLabel }}</span>
          <button type="button" :disabled="build.cancelling" @click="cancelBuild">{{ build.cancelling ? "正在取消…" : "取消构建" }}</button>
        </div>
        <p v-else-if="deepError" class="corpus-error" role="alert">构建失败：{{ deepError }}。上一版本的文章仍然完整可读。</p>
        <p v-else-if="build.error" class="corpus-error" role="alert">{{ build.error }}</p>
        <p v-else-if="build.report" class="hub-help" role="status">
          <template v-if="build.report.published.length">构建完成：第 {{ build.report.build }} 版，发布 {{ build.report.published.length }} 篇{{ build.report.skippedUserEdited.length ? `，${build.report.skippedUserEdited.length} 篇因人工编辑未重写` : "" }}。</template>
          <template v-else>构建完成：没有需要重写的文章。</template>
        </p>
        <div class="ledger-actions">
          <button type="button" class="button-primary" :disabled="!spaceId || build.running || deepBusy" @click="runBuild(false)">{{ build.running ? "正在生成…" : (reader.status?.pages.length ? "重新生成" : "生成文章") }}</button>
          <button v-if="reader.status?.pages.length" type="button" :disabled="!spaceId || build.running || deepBusy" @click="runBuild(true)">更新文章</button>
        </div>
      </div>

      <div v-if="reader.status && reader.status.pages.length" class="reader-grid">
        <aside class="reader-toc">
          <div v-for="group in tocGroups" :key="group.group" class="reader-group">
            <h3>{{ group.group }}</h3>
            <button v-for="page in group.pages" :key="page.file" type="button" :class="{ active: page.file === reader.page }" @click="openPage(page.file)">
              {{ page.title }}<small v-if="page.stale" class="reader-stale">待更新</small>
            </button>
          </div>
        </aside>
        <article class="reader-body">
          <div v-if="!pageEdit.open" class="reader-toolbar">
            <button type="button" class="button-quiet" :disabled="!reader.page || busy" @click="startPageEdit(false)">编辑本页</button>
            <button type="button" class="button-quiet" :disabled="busy" @click="startPageEdit(true)">新建页面</button>
          </div>
          <p v-if="reader.loading" class="hub-help">加载中…</p>
          <p v-else-if="!reader.body" class="hub-help">这一页读不出来，可能是发布状态已变化。点左上角文章名重试，或换个页面。</p>
          <!-- 正文是 core 落盘的文章；renderMarkdown 经 DOMPurify 消毒。 -->
          <div v-else class="reader-markdown" v-html="readerHtml" @click="onReaderClick" @auxclick="onReaderClick"></div>
        </article>
      </div>
      <div v-else class="space-empty">
        <p v-if="reader.loading" class="hub-help">加载中…</p>
        <template v-else>
          <strong>资料就位后，让知识有一份目录</strong>
          <p class="hub-help">先在「本地资料」添加文件，再点击上方「生成文章」。你也可以直接写下第一篇笔记。</p>
          <button type="button" class="button-quiet" :disabled="busy" @click="startPageEdit(true)">新建页面</button>
        </template>
      </div>
      <!-- 引用出处抽屉（§八 出处可打开）：点开正文里任一 `路径:Lx-Ly`，展示
           引用解析到的 FROZEN 来源版本与摘录行。能打开只说明可追溯，不等于
           已证实——notice 由 core 给出、原样展示，前端不加"已验证"类文案；
           拒绝（无法定位引用来源 / 来源已撤下 / 格式无法解析）是 core 的明确
           原因，就地在抽屉里回显，不混进全局错误条。 -->
      <aside v-if="cite.open" class="cite-drawer" aria-label="引用出处">
        <div class="cite-head">
          <strong>引用出处</strong>
          <code>{{ cite.data?.locator ?? cite.token }}</code>
          <button type="button" :disabled="cite.busy" @click="cite.open = false">关闭</button>
        </div>
        <p v-if="cite.busy" class="hub-help">正在打开来源……</p>
        <p v-else-if="cite.error" class="corpus-error" role="alert">{{ cite.error }}</p>
        <template v-else-if="cite.data">
          <p class="hub-help">
            资料 {{ cite.data.sourceKind }}/{{ cite.data.sourceId }} · 版本 v{{ cite.data.versionNo }} ·
            解析器 v{{ cite.data.parserVersion }} · 共 {{ cite.data.totalLines }} 行
            <template v-if="cite.data.crossSpace"> · 跨空间引用：资料属于其它空间（{{ cite.data.homeSpaceId }}）</template>
            <template v-if="cite.data.superseded"> · 已被新版本接替（冻结内容仍可核对）</template>
          </p>
          <div v-if="cite.data.excerpt.length" class="cite-excerpt">
            <p v-for="line in cite.data.excerpt" :key="line.line"><span class="cite-lineno">{{ line.line }}</span><span>{{ line.text }}</span></p>
          </div>
          <p v-else class="hub-help">该范围没有可展示的摘录，请对照全文人工核对。</p>
          <button type="button" @click="cite.showFull = !cite.showFull">{{ cite.showFull ? "收起全文" : "展开冻结全文" }}</button>
          <pre v-if="cite.showFull" class="cite-full">{{ cite.data.content }}</pre>
          <p class="cite-notice">{{ cite.data.notice }}</p>
        </template>
      </aside>
      <!-- 人写页面编辑器（core `space_page_save`，Editor 起）：新建=起名，
           编辑=覆盖正文。保存经 switch_version 立即发布可读；改到机器构建的
           页会被保护——下次深度构建保留人写的正文。保存+重读在同一道身份
           闸里执行（与台账写操作同一纪律，晚到 ≠ 最新）。 -->
      <form v-if="pageEdit.open" class="page-editor" @submit.prevent="savePage">
        <input v-if="pageEdit.creating" v-model.trim="pageEdit.name" aria-label="新页面名" placeholder="页面名（如 runbook，可省 .md）" :disabled="pageEdit.saving" />
        <textarea v-model="pageEdit.draft" rows="14" aria-label="页面正文" placeholder="Markdown 正文" :disabled="pageEdit.saving"></textarea>
        <div class="ledger-actions">
          <button type="submit" class="button-primary" :disabled="pageEdit.saving || !pageEdit.draft.trim() || (pageEdit.creating && !pageEdit.name)">{{ pageEdit.saving ? "保存中…" : "保存" }}</button>
          <button type="button" class="button-quiet" :disabled="pageEdit.saving" @click="closePageEdit">取消</button>
        </div>
        <p class="settings-note">{{ pageEdit.creating ? "保存后立即发布为新页面，出现在左侧目录。" : "保存会整体替换本页；若本页由机器构建，你的正文将被保护，下次构建不再重写它。" }}</p>
      </form>
    </section>

    <!-- 资料：既有资料库管理原样嵌入（导入/发布/成员/保留等），不再复制一套。 -->
    <CustomerKnowledgePanel v-show="tab === 'docs'" embedded hide-search :selected-space-id="spaceId" @space-change="id => emit('spaceChange', id)" @spaces-loaded="items => emit('spacesLoaded', items)" />

    <!-- 台账：空间键审核入口（space_entries/space_review_entry/space_edit_entry）。
         submit_wiki 的空间归属提议就落在这里——纯空间（无注册工作区）此前
         没有应用内审核入口，这一页签补上。写操作同样过空间身份闸。 -->
    <section v-show="tab === 'ledger'" class="space-tab-body" aria-label="提议台账">
      <p v-if="!spaceId" class="hub-help">先选择一个知识空间。</p>
      <template v-else>
        <div class="ledger-head">
          <p class="hub-help">会话里提交并归属到本空间的知识提议在这里审核：通过/拒绝记录在空间台账里，撤销会把条目从台账移除。绑定了工作区的空间通过后会自动重新编译 Wiki 页面；纯空间的文章由知识构建流程生成，台账即审核记录本身。列表每次操作后按最新重读，晚到的旧响应不会覆盖。</p>
          <button type="button" :disabled="ledger.loading" @click="loadLedger">{{ ledger.loading ? '读取中…' : '刷新' }}</button>
        </div>
        <ul v-if="ledger.entries.length" class="ledger-list">
          <li v-for="entry in ledger.entries" :key="entry.id" class="ledger-entry">
            <div class="ledger-meta">
              <span class="ledger-kind">{{ KIND_LABELS[entry.kind] ?? entry.kind }}</span>
              <span class="ledger-status" :data-status="entry.status">{{ STATUS_LABELS[entry.status] ?? entry.status }}</span>
              <small>{{ entry.sessionId }} · {{ entry.createdAt }}</small>
            </div>
            <p v-if="ledger.editing !== entry.id" class="ledger-content">{{ entry.content }}</p>
            <template v-else>
              <textarea v-model="ledger.draft" class="ledger-edit" rows="4" aria-label="编辑提议内容"></textarea>
              <div class="ledger-actions">
                <select v-model="ledger.draftKind" aria-label="条目类型"><option value="flow">流程</option><option value="decision">决策</option><option value="pitfall">坑</option><option value="term">术语</option></select>
                <button type="button" class="button-primary" :disabled="busy || !ledger.draft.trim()" @click="saveEdit(entry.id)">保存</button>
                <button type="button" :disabled="busy" @click="ledger.editing = ''">取消</button>
              </div>
            </template>
            <div v-if="ledger.editing !== entry.id" class="ledger-actions">
              <template v-if="entry.status === 'pending'">
                <button type="button" class="button-primary" :disabled="busy" @click="review(entry.id, 'approve')">通过</button>
                <button type="button" :disabled="busy" @click="review(entry.id, 'reject')">拒绝</button>
              </template>
              <button type="button" :disabled="busy" @click="startEdit(entry)">编辑</button>
              <button type="button" :disabled="busy" @click="review(entry.id, 'undo')">撤销</button>
            </div>
          </li>
        </ul>
        <p v-else-if="!ledger.loading" class="hub-help">这个空间还没有提议。会话中通过 submit_wiki 归属到本空间的知识会出现在这里。</p>
      </template>
    </section>

    <!-- 设置：外部策略现在可改（core `space_set_policy`，空间 Owner 起的
         fail-closed 闸门），其余仍是 core 裁决的只读展示。改策略只改策略，
         不重写任何内容——下一次问答/构建开始/发布前复核重新读取它。 -->
    <section v-show="tab === 'settings'" class="space-tab-body" aria-label="空间设置">
      <div class="settings-card">
        <h2>知识库设置</h2>
        <p class="hub-help">选择这些资料能否用于外部模型。保存后，对后续问答和文章生成生效。</p>
        <dl v-if="settings.row">
          <dt>资料库</dt><dd>{{ settings.row.name }}</dd>
          <dt>外部策略</dt><dd>{{ settings.row.externalPolicy }}</dd>
          <dt>云端摘要裁决</dt><dd>{{ settings.decision ? (settings.decision.allowed ? '允许' : '拒绝') : '读取中…' }}</dd>
          <template v-if="settings.decision"><dt>裁决依据</dt><dd>{{ settings.decision.reason }}</dd></template>
        </dl>
        <p v-else-if="!settings.loading" class="hub-help">没有读到这个资料库的信息，它可能已被删除。</p>
        <div v-if="settings.row" class="ledger-actions">
          <select v-model="policy.draft" aria-label="外部策略" :disabled="policy.saving">
            <option value="allow_summary">允许外部模型</option>
            <option value="local_only">仅在本机使用</option>
            <option value="deny_cloud">禁止外部模型</option>
          </select>
          <button type="button" class="button-primary" :disabled="policy.saving || policy.draft === settings.row.externalPolicy" @click="savePolicy">{{ policy.saving ? "保存中…" : "修改策略" }}</button>
        </div>
        <p v-if="settings.row" class="settings-note">只有知识库所有者可以修改此设置。</p>
      </div>

      <!-- 知识域：构建按什么视角规划文章。保存过的设置总是压过形态启发；
           没有应用内清除入口（与项目 Wiki 一致），所以"自动判断"只在未设置
           时是事实状态，不提供假的"清除"按钮。 -->
      <div class="settings-card">
        <h2>知识域</h2>
        <p class="hub-help">未设置时构建按资料形态自动判断（纯文档 ⇒ 资料与业务）；这里保存过的设置优先于自动判断。</p>
        <p v-if="settings.profile" class="hub-help">当前：{{ settings.profile.label }}（已保存）</p>
        <p v-else-if="!settings.loading" class="hub-help">当前：自动判断（未保存设置）</p>
        <div class="ledger-actions">
          <button type="button" :disabled="!spaceId || build.savingProfile || settings.profile?.domain === 'generic'" @click="saveProfile('generic')">设为资料与业务</button>
          <button type="button" :disabled="!spaceId || build.savingProfile || settings.profile?.domain === 'code'" @click="saveProfile('code')">设为软件项目</button>
        </div>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import CustomerKnowledgePanel from "./CustomerKnowledgePanel.vue";
import {
  knowledgeExternalDecision,
  knowledgeLocalSpaces,
  spaceBuildCancel,
  spaceBuildDeep,
  spaceEditEntry,
  spaceEntries,
  spaceEvidence,
  spacePageSave,
  spaceProfile,
  spaceReviewEntry,
  spaceSetPolicy,
  spaceSetProfile,
  spaceShow,
  spaceStatus,
} from "../lib/ipc";
import type { KnowledgeScope } from "../lib/ipc";
import type { KnowledgeSpaceRow, SpaceCitationSource, WikiBuildReport, WikiEntry, WikiPageEntry, WikiProfile, WikiStatus } from "../lib/types";
import { useSessionStore } from "../stores/session";
import { createSpaceGate, runSpaceRead, spaceTargetKey } from "../lib/space-gate";
import { groupPages, resolveSelectedPage } from "../lib/wiki-view";
import { citationTarget, linkifyCitations } from "../lib/wiki-evidence";
import { renderMarkdown } from "../lib/markdown";
import { relativeWikiPage } from "../lib/links";

// 资料与文章为主导航，管理操作使用空间原有权限闸门。
const SUBJECT = "local-user";
const TABS = [
  { id: "docs", label: "本地资料" },
  { id: "read", label: "知识文章" },
] as const;
type TabId = (typeof TABS)[number]["id"] | "ledger" | "settings";

const props = defineProps<{ spaceId: string }>();
const emit = defineEmits<{
  spaceChange: [id: string];
  spacesLoaded: [spaces: { id: string; name: string }[]];
}>();

const tab = ref<TabId>("docs");
const busy = ref(false);
const error = ref("");
const gate = createSpaceGate();
const key = () => spaceTargetKey(props.spaceId ? [props.spaceId] : []);
// 深度构建进度走全局 bus（session store 转发 `_wiki_update`），本页只认领
// 属于当前空间的事件：事件的 workspace 是空间 sources 目录，路径里含唯一
// 的十六进制空间 id，用户内容不会出现它，所以按子串认领是精确的（Windows
// 反斜杠也让 samePath 这类路径相等判断不可靠，这里刻意不用）。
const sessions = useSessionStore();

const reader = reactive<{ status: WikiStatus | null; page: string; body: string; loading: boolean }>({ status: null, page: "", body: "", loading: false });
const settings = reactive<{ row: KnowledgeSpaceRow | null; decision: Awaited<ReturnType<typeof knowledgeExternalDecision>> | null; profile: WikiProfile | null; loading: boolean }>({ row: null, decision: null, profile: null, loading: false });
const build = reactive<{ running: boolean; cancelling: boolean; error: string; report: WikiBuildReport | null; savingProfile: boolean }>({ running: false, cancelling: false, error: "", report: null, savingProfile: false });
const KIND_LABELS: Record<WikiEntry["kind"], string> = { flow: "流程", decision: "决策", pitfall: "坑", term: "术语" };
const STATUS_LABELS: Record<WikiEntry["status"], string> = { pending: "待审核", accepted: "已通过", rejected: "已拒绝" };
const ledger = reactive<{ entries: WikiEntry[]; loading: boolean; editing: string; draft: string; draftKind: WikiEntry["kind"] }>({ entries: [], loading: false, editing: "", draft: "", draftKind: "flow" });
// 人写页面编辑态：open=表单可见，creating=新建（要起名），编辑=覆盖当前页。
const pageEdit = reactive<{ open: boolean; creating: boolean; name: string; draft: string; saving: boolean }>({ open: false, creating: false, name: "", draft: "", saving: false });
// 外部策略草稿（Owner 才能改，闸门在 core；draft 随 settings 重读同步回真值）。
const policy = reactive<{ draft: string; saving: boolean }>({ draft: "", saving: false });

const tocGroups = computed(() => groupPages(reader.status?.pages ?? []));
const tocFiles = computed<WikiPageEntry[]>(() => reader.status?.pages ?? []);

// 引用出处（§八 出处可打开）：正文渲染后把 `路径:Lx-Ly` 变成按钮
// （linkifyCitations 与项目 wiki 共用；pre/code 内不动），点击后交给 core
// `space_evidence`——引用只认构建时记录的 FROZEN 版本，拒绝/摘录/notice
// 全部由 core 定稿，前端原样展示。同样过身份闸：换空间后旧回包作废。
const cite = reactive<{ open: boolean; busy: boolean; token: string; error: string; showFull: boolean; data: SpaceCitationSource | null }>({ open: false, busy: false, token: "", error: "", showFull: false, data: null });
const readerHtml = computed(() => linkifyCitations(renderMarkdown(reader.body), "查看来源版本"));

function onReaderClick(event: MouseEvent) {
  if (event.type === "auxclick" && event.button !== 1) return;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (link) {
    const page = relativeWikiPage(link.getAttribute("href") ?? "");
    if (page) { event.preventDefault(); openPage(page); }
    return;
  }
  const button = (event.target as HTMLElement).closest(".wiki-cite") as HTMLElement | null;
  if (!button) return;
  const target = citationTarget(button.dataset);
  if (!target || target.mode !== "source" || !target.rel || target.start == null) return;
  void openCite(`${target.rel}:L${target.start}${target.end != null && target.end !== target.start ? `-L${target.end}` : ""}`);
}

function openCite(token: string) {
  cite.open = true;
  cite.busy = true;
  cite.token = token;
  cite.error = "";
  cite.showFull = false;
  cite.data = null;
  return runSpaceRead<SpaceCitationSource>(gate, key(), "cite", {
    read: () => spaceEvidence(SUBJECT, props.spaceId, token),
    write: data => { cite.busy = false; cite.data = data; },
    // core 的拒绝原因就是答案（无法定位/已撤下/格式无法解析），就地回显。
    writeError: err => { cite.busy = false; cite.error = err instanceof Error ? err.message : String(err); },
  });
}

async function withBusy(action: () => Promise<void>) {
  busy.value = true;
  try { await action(); } finally { busy.value = false; }
}

async function loadReader() {
  if (!props.spaceId) { reader.status = null; reader.page = ""; reader.body = ""; return; }
  reader.loading = true;
  await runSpaceRead<WikiStatus>(gate, key(), "reader", {
    read: () => spaceStatus(SUBJECT, props.spaceId),
    write: status => {
      reader.status = status;
      const keep = resolveSelectedPage(tocFiles.value, reader.page);
      reader.page = keep;
      reader.loading = false;
      if (keep) void loadPage(keep);
      else reader.body = "";
    },
    writeError: err => { reader.loading = false; error.value = String(err); },
  });
}

function loadPage(file: string) {
  reader.page = file;
  reader.loading = true;
  // 切页即收抽屉：旧页的出处绝不冒充新页的。
  cite.open = false;
  return runSpaceRead<Awaited<ReturnType<typeof spaceShow>>>(gate, key(), "page", {
    read: () => spaceShow(SUBJECT, props.spaceId, file),
    write: pages => { reader.loading = false; reader.body = pages[0]?.body ?? ""; },
    writeError: err => { reader.loading = false; reader.body = ""; error.value = String(err); },
  });
}

function openPage(file: string) { void withBusy(() => loadPage(file)); }

async function loadSettings() {
  if (!props.spaceId) return;
  settings.loading = true;
  const spaceId = props.spaceId;
  await runSpaceRead<{ row: KnowledgeSpaceRow | null; decision: Awaited<ReturnType<typeof knowledgeExternalDecision>> | null; profile: WikiProfile | null }>(gate, key(), "settings", {
    read: async () => {
      const rows = await knowledgeLocalSpaces();
      const row = rows.find(item => item.id === spaceId) ?? null;
      if (!row) return { row: null, decision: null, profile: null };
      const scope: KnowledgeScope = { tenantId: row.tenantId, customerId: row.customerId, spaceId: row.id, subjectId: SUBJECT };
      // 只读展示；真正的云端裁决在 core（space_ask 内部逐空间执行）。
      const decision = await knowledgeExternalDecision(scope, "cloud_summary");
      const profile = await spaceProfile(SUBJECT, spaceId).catch(() => null);
      return { row, decision, profile };
    },
    write: result => {
      settings.row = result.row; settings.decision = result.decision; settings.profile = result.profile; settings.loading = false;
      // 策略选择器跟随 core 存储的真值（保存失败/被拒后草稿回正，不悬着假值）。
      if (result.row && !policy.saving) policy.draft = result.row.externalPolicy;
    },
    writeError: err => { settings.loading = false; error.value = String(err); },
  });
}

// —— 人写页面（core `space_page_save`，Editor 起，闸门与拒绝文案在 core）——
// 保存 + 重读目录在同一道身份闸里执行（与台账写操作同一纪律：晚到 ≠ 最新）。
function startPageEdit(creating: boolean) {
  if (pageEdit.saving) return;
  pageEdit.open = true;
  pageEdit.creating = creating;
  pageEdit.name = creating ? "" : reader.page;
  pageEdit.draft = creating ? "" : reader.body;
}

function closePageEdit() {
  if (pageEdit.saving) return;
  pageEdit.open = false; pageEdit.name = ""; pageEdit.draft = "";
}

async function savePage() {
  if (!props.spaceId || pageEdit.saving) return;
  const spaceId = props.spaceId;
  const name = pageEdit.creating ? pageEdit.name : reader.page;
  const content = pageEdit.draft;
  if (!name || !content.trim()) return;
  pageEdit.saving = true;
  await withBusy(() => runSpaceRead<{ out: Awaited<ReturnType<typeof spacePageSave>>; status: WikiStatus }>(gate, key(), "reader", {
    read: async () => {
      const out = await spacePageSave(SUBJECT, spaceId, name, content);
      return { out, status: await spaceStatus(SUBJECT, spaceId) };
    },
    write: ({ out, status }) => {
      reader.status = status;
      pageEdit.open = false; pageEdit.saving = false; pageEdit.name = ""; pageEdit.draft = "";
      // 落盘文件名是 core 规范化结果（补 .md），按它回显正文。
      void loadPage(out.file);
    },
    writeError: err => { pageEdit.saving = false; error.value = String(err); },
  }));
}

// —— 知识构建（core `space_build_llm`，与 WikiPanel 深度构建同一 deep 词表）——
const DEEP_PHASES = new Set(["build_started", "build_plan", "build_article", "build_finished", "build_error"]);
const claimsSpace = (workspace?: string | null) => !!workspace && !!props.spaceId && workspace.includes(props.spaceId);
const deepEvent = computed(() => {
  const c = sessions.wikiCompile;
  return c && DEEP_PHASES.has(c.phase) && claimsSpace(c.workspace) ? c : null;
});
const deepBusy = computed(() => !!deepEvent.value && ["build_started", "build_plan", "build_article"].includes(deepEvent.value.phase));
const deepError = computed(() => (deepEvent.value?.phase === "build_error" ? deepEvent.value.message || "未知错误" : ""));
const deepLabel = computed(() => {
  const c = deepEvent.value;
  if (!c) return "";
  if (c.phase === "build_article") return `正在撰写《${c.message || "文章"}》…`;
  return c.phase === "build_plan" ? "资料扫描完成，正在规划文章目录…" : "正在扫描资料并准备生成文章…";
});

async function runBuild(incremental: boolean) {
  if (!props.spaceId || build.running) return;
  const spaceId = props.spaceId;
  build.running = true;
  build.error = "";
  build.report = null;
  try {
    // 闸门（Editor/存在/归档/绑定拒绝）都在 core，拒绝原因原样回显。
    const report = await spaceBuildDeep(SUBJECT, spaceId, incremental);
    if (props.spaceId === spaceId) { build.report = report; await loadReader(); }
  } catch (err) {
    if (props.spaceId === spaceId) build.error = String(err);
  } finally {
    build.running = false;
  }
}

async function cancelBuild() {
  if (!props.spaceId || build.cancelling) return;
  build.cancelling = true;
  try {
    const hit = await spaceBuildCancel(SUBJECT, props.spaceId);
    if (!hit) build.error = "当前没有进行中的构建（取消请求不会被记住，不会误停下一次）。";
  } catch (err) {
    build.error = String(err);
  } finally {
    build.cancelling = false;
  }
}

async function saveProfile(domain: WikiProfile["domain"]) {
  if (!props.spaceId || build.savingProfile) return;
  const spaceId = props.spaceId;
  const next: WikiProfile = { domain, label: domain === "code" ? "软件项目" : "资料与业务" };
  build.savingProfile = true;
  try {
    await spaceSetProfile(SUBJECT, spaceId, next);
    if (props.spaceId === spaceId) settings.profile = next;
  } catch (err) {
    if (props.spaceId === spaceId) error.value = String(err);
  } finally {
    build.savingProfile = false;
  }
}

// 修改外部策略（core `space_set_policy`，空间 Owner；拒绝原因原样回显）。
// 保存成功后重读设置：策略、云端裁决、裁决依据一起回到 core 的真值。
async function savePolicy() {
  if (!props.spaceId || policy.saving) return;
  const spaceId = props.spaceId;
  policy.saving = true;
  try {
    await spaceSetPolicy(SUBJECT, spaceId, policy.draft);
  } catch (err) {
    if (props.spaceId === spaceId) error.value = String(err);
  } finally {
    policy.saving = false;
  }
  if (props.spaceId === spaceId) void loadSettings();
}

// 台账读写。写操作（审核/编辑）也走 runSpaceRead：动作 + 重列在同一道
// 身份闸里执行，只有代次仍是当前空间时结果才回写——换空间后，旧空间的
// 审核回包绝不落进新空间的列表（晚到 ≠ 最新）。
async function loadLedger() {
  if (!props.spaceId) { ledger.entries = []; return; }
  ledger.loading = true;
  const spaceId = props.spaceId;
  await runSpaceRead<WikiEntry[]>(gate, key(), "ledger", {
    read: () => spaceEntries(SUBJECT, spaceId),
    write: entries => { ledger.entries = entries; ledger.loading = false; },
    writeError: err => { ledger.loading = false; error.value = String(err); },
  });
}

async function review(id: string, action: "approve" | "reject" | "undo") {
  if (!props.spaceId) return;
  const spaceId = props.spaceId;
  await withBusy(() => runSpaceRead<WikiEntry[]>(gate, key(), "ledger", {
    read: async () => { await spaceReviewEntry(SUBJECT, spaceId, id, action); return spaceEntries(SUBJECT, spaceId); },
    write: entries => { ledger.entries = entries; ledger.editing = ""; },
    writeError: err => { error.value = String(err); },
  }));
}

function startEdit(entry: WikiEntry) {
  ledger.editing = entry.id;
  ledger.draft = entry.content;
  ledger.draftKind = entry.kind;
}

async function saveEdit(id: string) {
  if (!props.spaceId || !ledger.draft.trim()) return;
  const spaceId = props.spaceId;
  const content = ledger.draft;
  const kind = ledger.draftKind;
  await withBusy(() => runSpaceRead<WikiEntry[]>(gate, key(), "ledger", {
    read: async () => { await spaceEditEntry(SUBJECT, spaceId, id, content, kind); return spaceEntries(SUBJECT, spaceId); },
    write: entries => { ledger.entries = entries; ledger.editing = ""; },
    writeError: err => { error.value = String(err); },
  }));
}

function clearAll() {
  reader.status = null; reader.page = ""; reader.body = ""; reader.loading = false;
  cite.open = false; cite.busy = false; cite.token = ""; cite.error = ""; cite.showFull = false; cite.data = null;
  ledger.entries = []; ledger.loading = false; ledger.editing = "";
  settings.row = null; settings.decision = null; settings.profile = null; settings.loading = false;
  build.running = false; build.cancelling = false; build.error = ""; build.report = null; build.savingProfile = false;
  // 编辑器和策略草稿都属于旧空间：一并清空（在途回写已由代次作废，这里清的是残影）。
  pageEdit.open = false; pageEdit.creating = false; pageEdit.name = ""; pageEdit.draft = ""; pageEdit.saving = false;
  policy.draft = ""; policy.saving = false;
  error.value = "";
}

// 本空间的深度构建发布完成：清掉这条已完成的状态（避免下次进来还挂着），
// 重读文章目录。失败/进行中不清——错误要留在屏上。
watch(() => sessions.wikiCompile, c => {
  if (c?.phase === "build_finished" && claimsSpace(c.workspace)) {
    sessions.wikiCompile = null;
    if (props.spaceId) void loadReader();
  }
});

// 换空间：升代次（在途旧响应全体作废）+ 清空全部页签状态，再按当前页签重载。
watch(() => props.spaceId, () => { gate.bind(key()); clearAll(); if (tab.value === "read") void loadReader(); if (tab.value === "ledger") void loadLedger(); if (tab.value === "settings") void loadSettings(); });
watch(tab, value => {
  if (value === "read" && !reader.status) void loadReader();
  if (value === "ledger" && !ledger.entries.length) void loadLedger();
  if (value === "settings" && !settings.row) void loadSettings();
});
onMounted(() => { gate.bind(key()); if (tab.value === "read") void loadReader(); });
</script>

<style scoped>
.space-view { display: grid; gap: 14px; }
.space-navigation { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); gap: 12px; }
.space-tabs { display: flex; gap: 24px; }
.space-tabs button { padding: 11px 0 13px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
.space-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.space-manage { position: relative; font-size: var(--fs-sm); color: var(--muted); }
.space-manage summary { cursor: pointer; padding: 8px; }
.space-manage > div { position: absolute; right: 0; z-index: 3; display: grid; min-width: 160px; padding: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); box-shadow: var(--shadow-menu); }
.space-manage button { padding: 10px; background: transparent; border: 0; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.space-manage button:hover { background: var(--hover); }
.space-tab-body { display: grid; gap: 20px; padding: 20px 0; }
.article-build { display: grid; grid-template-columns: 1fr auto; gap: 8px 20px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
.article-build h2 { margin: 0; font-size: var(--fs-lg); }
.article-build > .hub-help { grid-column: 1; }
.article-build > .ledger-actions { grid-column: 2; grid-row: 1 / 3; align-items: center; }
.article-build > .build-progress, .article-build > .corpus-error, .article-build > [role="status"] { grid-column: 1 / -1; }
.space-view button:focus-visible, .space-manage summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.hub-help { margin: 0; color: var(--muted); font-size: var(--fs-sm); line-height: 1.55; }
.tab-query { display: flex; gap: 8px; }.tab-query input { flex: 1; min-width: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-2); color: var(--text); font: inherit; }
.tab-results, .tab-answer ol { padding-left: 20px; margin: 0; }.tab-results li, .tab-answer li { margin: 10px 0; }.tab-results li span, .tab-answer li small { color: var(--accent); font-size: var(--fs-xs); }.tab-results p, .tab-answer p { margin: 4px 0 0; white-space: pre-wrap; line-height: 1.6; }
.tab-answer { display: grid; gap: 8px; border-top: 1px solid var(--border); padding-top: 12px; }.tab-answer p { margin: 0; white-space: pre-wrap; line-height: 1.6; }
.reader-grid { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 18px; align-items: start; }
.reader-toc { display: grid; gap: 4px; position: sticky; top: 0; }
.reader-group h3 { margin: 10px 0 4px; font-size: var(--fs-xs); color: var(--muted); }
.reader-toc button { display: flex; justify-content: space-between; gap: 6px; padding: 7px 9px; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--text); text-align: left; cursor: pointer; font: inherit; font-size: var(--fs-sm); }
.reader-toc button.active { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
.reader-stale { color: var(--warn, #b45309); font-size: var(--fs-xs); }
.reader-body { min-width: 0; }
.reader-toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 10px; }
.reader-markdown { line-height: 1.7; font-size: var(--fs-sm); }
/* 引用 token 是可点击按钮（linkifyCitations 生成）；样式与项目 wiki 的
   引用入口一致，虚下划线暗示"可点开出处"，不假扮正文。 */
.reader-markdown :deep(.wiki-cite) { border: 0; padding: 0; background: none; color: var(--accent, #7360be); text-decoration: underline dotted; text-underline-offset: 2px; cursor: pointer; font: inherit; word-break: break-all; }
.cite-drawer { display: grid; gap: 10px; padding: 14px 16px; border: 1px solid var(--accent); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--accent) 6%, var(--bg)); }
.cite-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }.cite-head code { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--accent); font-size: var(--fs-sm); }
.cite-excerpt { display: grid; gap: 2px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); overflow-x: auto; }
.cite-excerpt p { display: flex; gap: 10px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono, ui-monospace, monospace); font-size: var(--fs-xs); line-height: 1.6; }
.cite-lineno { flex: none; min-width: 3ch; text-align: right; color: var(--muted); user-select: none; }
.cite-full { margin: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono, ui-monospace, monospace); font-size: var(--fs-xs); line-height: 1.6; max-height: 420px; overflow-y: auto; }
/* notice 是 core 的定稿文案（"位置合法不等于结论已证实"），展示不加工。 */
.cite-notice { margin: 0; color: var(--muted); font-size: var(--fs-xs); border-top: 1px dashed var(--border); padding-top: 8px; }
.page-editor { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-2); }
.page-editor input, .page-editor textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); color: var(--text); font: inherit; font-size: var(--fs-sm); }
.space-empty { display: grid; gap: 14px; justify-items: center; text-align: center; padding: 70px 24px; border: 1px dashed var(--border); border-radius: 12px; }.space-empty .hub-help { max-width: 420px; }
.settings-card { display: grid; gap: 8px; }.settings-card h2 { margin: 0; font-size: var(--fs-lg); }
.settings-card dl { display: grid; grid-template-columns: 120px 1fr; gap: 6px 12px; margin: 0; }.settings-card dt { color: var(--muted); font-size: var(--fs-sm); }.settings-card dd { margin: 0; font-size: var(--fs-sm); }
.settings-note { margin: 0; color: var(--muted); font-size: var(--fs-xs); }
.build-progress { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--accent); border-radius: var(--radius-md); background: color-mix(in srgb, var(--accent) 8%, var(--bg)); font-size: var(--fs-sm); }
.ledger-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.ledger-list { display: grid; gap: 10px; list-style: none; margin: 0; padding: 0; }
.ledger-entry { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-2); }
.ledger-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }.ledger-meta small { color: var(--muted); font-size: var(--fs-xs); }
.ledger-kind { color: var(--accent); font-size: var(--fs-xs); }
.ledger-status { font-size: var(--fs-xs); }.ledger-status[data-status="pending"] { color: var(--warn, #b45309); }.ledger-status[data-status="rejected"] { color: var(--muted); }
.ledger-content { margin: 0; white-space: pre-wrap; line-height: 1.6; font-size: var(--fs-sm); }
.ledger-edit { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); color: var(--text); font: inherit; font-size: var(--fs-sm); }
.ledger-actions { display: flex; flex-wrap: wrap; gap: 8px; }.ledger-actions select { padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); color: var(--text); font: inherit; font-size: var(--fs-sm); }
@media (max-width: 720px) { .article-build { grid-template-columns: 1fr; }.article-build > .ledger-actions { grid-column: 1; grid-row: auto; } .reader-grid { grid-template-columns: 1fr; }.reader-toc { position: static; } }
</style>
