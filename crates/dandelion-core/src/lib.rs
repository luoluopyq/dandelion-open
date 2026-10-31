//! Dandelion agent core.
//!
//! This crate is the **only** place the agent loop lives. The CLI (`dln`) and
//! the future Tauri app (`apps/desktop`) are hosts: they construct a [`Runtime`],
//! send [`Command`]s, and subscribe to [`bus::BusFrame`]s.

pub mod acp;
pub mod agent_plugins;
pub mod agent_loop;
pub mod bus;
mod cc_switch;
pub mod config;
pub mod context;
pub mod context_os;
pub mod corpus;
pub mod cron;
pub mod error;
pub mod eval;
pub mod hooks;
pub mod host;
pub mod ids;
pub mod jobs;
pub mod mcp;
pub mod memory;
mod mlx_install;
pub mod permission;
pub mod preflight;
pub mod provider;
pub mod registry;
pub mod runtime;
pub mod sandbox;
pub mod secret;
pub mod sidecar;
pub mod skills;
pub mod space_qa;
pub mod spec;
pub mod store;
pub mod subagent;
pub mod tools;
pub mod trace;
pub mod wiki;
pub mod wiki_adapters;
pub mod wiki_bridge;
pub mod wiki_build;
pub mod wiki_index;
pub mod wiki_locator;
pub mod wiki_space_migrate;
pub mod worktree;

pub use bus::BusFrame;
pub use agent_plugins::PluginInfo as AgentPluginInfo;
pub use config::{
    McpServerConfig, PermissionMode, PermissionRules, Settings, SettingsOverlay, ThinkingIntensity,
};
pub use context::{ContextKind, ContextStatus};
pub use context_os::{
    Authority, ContextBuildRequest, ContextCacheStatus, ContextItem, ContextPack,
    ContextRankSignals, EntityGraphEdge, EntityGraphNode, EntityGraphProjection, MemoryDomain,
    MemoryEvent, MemoryEventDraft, MemoryEventKind, MemoryScope, RoutingDecision, RoutingRoute,
    Sensitivity, SourceRef, TemporalProjectionItem,
};
pub use corpus::{CorpusDoc, CorpusHit};
pub use error::{Error, Result};
pub use host::{
    product_data_dir, AgentHost, CliHost, DesktopHost, HostKind, PermissionSink, RecordingHost,
};
pub use ids::{MessageId, SessionId, ToolCallId};
pub use mcp::McpListItem;
pub use memory::{FrozenMemory, MemoryFiles, MemoryKind};
pub use preflight::{
    evaluate as evaluate_preflight, CircuitBreaker, LocalInference, OpenAiCompatibleInference,
    PreflightStatus, RuleInference,
};
pub use provider::{ProviderProbe, ScriptedProvider};
pub use registry::{
    McpEnvNeed, McpInstallPlan, McpRegistryEntry, McpRegistryPage, McpVariant, McpVariantKind,
    SkillInstallReport,
};
pub use runtime::{Command, PromptRequest, Runtime, RuntimeInfo, SandboxRoots, TaskMode};
pub use sandbox::{validate_sandbox_root, WorkspaceFs};
pub use sidecar::{
    HardwareProbe, LocalModel, ModelDownloadStatus, QueueSnapshot, SidecarStatus,
    SidecarStatusKind, VramCheck,
};
pub use skills::SkillListItem;
pub use space_qa::{EmptySpace, SpaceAnswer, SpaceEvidence, SpaceSearchResult};
pub use spec::{SpecDiff, SpecHandle, SpecMode, SpecSnapshot, SpecStatus};
pub use store::{
    AgentRunRow, CronJobRow, CronRunRow, KnowledgeAnswer, KnowledgeApiClient,
    KnowledgeApiProvision, KnowledgeCitation, KnowledgeCollection, KnowledgeCustomer,
    KnowledgeDeletionAudit, KnowledgeDeletionProof, KnowledgeDocument, KnowledgeDocumentVersion,
    KnowledgeExternalDecision, KnowledgeFeedback, KnowledgeMember, KnowledgeQualityMetrics,
    KnowledgeRetentionPreview, KnowledgeRole, KnowledgeSearchHit, KnowledgeSpace,
    KnowledgeSpaceMaterial, KnowledgeSyncPreview, KnowledgeSyncSource, KnowledgeTenant,
    PreflightMetrics, PreflightRun,
    ProjectRow, SessionPrefs, SessionRow, SessionSearchHit, TodoItem,
};
pub use subagent::ChildListItem;
pub use trace::{RunId, TraceEvent};
pub use wiki::{
    DistilledEntry, WikiAnswer, WikiHit, WikiMeta, WikiPage, WikiPageEntry, WikiProfile, WikiStatus,
};

/// Crate version compiled into both CLI and (later) the desktop binary.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Human product name.
pub const PRODUCT_NAME: &str = "Dandelion";

/// CLI binary name (also the optional extra binary inside a desktop installer).
pub const CLI_BIN: &str = "dln";
