import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Usage } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { type Component, Spacer, Text, TruncatedText } from "@oh-my-pi/pi-tui";
import type { AdvisorMessageDetails } from "../../advisor";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "../../collab/protocol";
import { settings } from "../../config/settings";
import { getEditClipboard } from "../../edit/edit-clipboard";
import { getFileSnapshotStore } from "../../edit/file-snapshot-store";
import { createAdvisorMessageCard } from "../../modes/components/advisor-message";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { createBackgroundTanDispatchBlock } from "../../modes/components/background-tan-message";
import { BashExecutionComponent } from "../../modes/components/bash-execution";
import { detectCacheInvalidation } from "../../modes/components/cache-invalidation-marker";
import { CollabPromptMessageComponent } from "../../modes/components/collab-prompt-message";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
} from "../../modes/components/compaction-summary-message";
import { CustomMessageComponent } from "../../modes/components/custom-message";
import { DynamicBorder } from "../../modes/components/dynamic-border";
import { EvalExecutionComponent } from "../../modes/components/eval-execution";
import {
	type LateDiagnosticsFile,
	LateDiagnosticsMessageComponent,
} from "../../modes/components/late-diagnostics-message";
import {
	groupedReadUsageCallIds,
	ReadToolGroupComponent,
	readArgsCollapseIntoGroup,
} from "../../modes/components/read-tool-group";
import { SkillMessageComponent } from "../../modes/components/skill-message";
import { StrippedToolCallsPlaceholder } from "../../modes/components/stripped-tool-calls-placeholder";
import { ToolExecutionComponent, type ToolExecutionHandle } from "../../modes/components/tool-execution";
import { TranscriptBlock } from "../../modes/components/transcript-container";
import { createUsageRowBlock } from "../../modes/components/usage-row";
import { UserMessageComponent } from "../../modes/components/user-message";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "../../modes/controllers/tool-args-reveal";
import { materializeImageReferenceLinksSync } from "../../modes/image-references";
import { theme } from "../../modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext, RenderSessionContextOptions } from "../../modes/types";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "../../session/messages";
import type { SessionContext, StrippedToolCallsMarker } from "../../session/session-context";
import { replaceTabs } from "../../tools/render-utils";
import { buildSkillCommandPrompt, invokeSkillCommandFromText, isKnownSkillCommand } from "../skill-command";
import { createAssistantMessageComponent } from "./interactive-context-helpers";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	buildAsyncResultBlock,
	buildFileMentionBlock,
	buildIrcMessageCard,
	normalizeToolArgs,
	resolveAssistantErrorPresentation,
	splitAssistantMessageToolTimeline,
} from "./transcript-render-helpers";

type TextBlock = { type: "text"; text: string };
interface RenderInitialMessagesOptions {
	preserveExistingChat?: boolean;
	clearTerminalHistory?: boolean;
}

/**
 * Sizing knobs for the windowed initial transcript render. Resuming a large
 * session used to synchronously construct a component for every transcript
 * message before the first paint (a minute-long frozen frame on multi-thousand
 * message sessions). The initial render now covers only a tail window sized to
 * roughly a viewport of markdown, and the older prefix backfills lazily in
 * event-loop chunks afterwards.
 */
export interface TranscriptWindowConfig {
	/** Below this many context messages the full render is cheap enough; no windowing. */
	minTotalMessages: number;
	/** Hard cap on messages rendered synchronously in the initial tail window. */
	maxWindowMessages: number;
	/** Soft floor: the window always covers at least this many tail messages. */
	minWindowMessages: number;
	/** Estimated content bytes the initial window may carry before expanding stops. */
	windowByteBudget: number;
	/** Event-loop budget per backfill chunk; the loop yields between chunks. */
	chunkBudgetMs: number;
}

const DEFAULT_TRANSCRIPT_WINDOW_CONFIG: TranscriptWindowConfig = {
	minTotalMessages: 120,
	maxWindowMessages: 120,
	minWindowMessages: 24,
	// Calibrated against the real 7MB/2.4k-message resume fixture: ~35ms per
	// content-KB of component construction puts the window render at ~1s.
	windowByteBudget: 32 * 1024,
	chunkBudgetMs: 24,
};

/**
 * Output target for transcript reconstruction. The live tail renders straight
 * into the chat container; a backfill renders the older prefix through a
 * front-inserting sink so those blocks land above the already-rendered tail.
 */
interface TranscriptRenderSink {
	addChild(component: Component): void;
	removeChild(component: Component): void;
	isBlockUncommitted(component: Component): boolean;
	/** The most recently emitted block (the chat container's last child for the live tail). */
	lastChild(): Component | undefined;
}

/** Execution parameters for one rendered range of the transcript message list. */
interface TranscriptRangeRuntime {
	/** First context message index to render (inclusive). */
	start: number;
	/** Last context message index to render (exclusive). */
	end: number;
	/** Tool-call component registry for this range; the live tail uses ctx.pendingTools. */
	pendingTools: Map<string, ToolExecutionHandle>;
	/** Cache-invalidation baseline carried into the range (the prefix's last billed usage). */
	seedLastAssistantUsage: Usage | undefined;
	/**
	 * "tail": the range ends at the transcript tail — run the full end-of-render
	 * resolution (streaming handoff included). "boundary": the range ends right
	 * before a user prompt — resolve carried state exactly as a full replay does
	 * when that prompt is processed (seal snapshots, never the streaming handoff).
	 */
	trailing: "tail" | "boundary";
}

/** Where the tail window starts and what state the window render must carry in. */
interface TranscriptWindowPlan {
	/** First windowed message index; messages before it backfill lazily. */
	cut: number;
	/** The prefix's last billed assistant usage — the window's cache-invalidation baseline. */
	carryUsage: Usage | undefined;
}

/** In-flight prefix backfill: the generator, its front-insert sink, and resume bookkeeping. */
interface TranscriptBackfillState {
	/** Chat-container mutation epoch captured at schedule time; a bump means the container was rebuilt. */
	epoch: number;
	/** The prefix render, pumped message-at-a-time across event-loop turns. */
	range: Generator<void, void, void>;
	sink: TranscriptRenderSink;
	/** Next child index for front-inserts; everything below it is already-backfilled prefix. */
	insertIndex: number;
	/** The prefix render's cache-invalidation baseline, parked between chunks. */
	prefixUsage: Usage | undefined;
	scheduled: boolean;
}

/**
 * Index of the first tool result at/after `cut` whose call sits before `cut`
 * (a pair split by the window boundary), or -1 when every pair is contained.
 * Each replayed range pairs results against its own registry, so a straddling
 * pair would orphan the result block.
 */
function firstStraddlingToolResult(messages: AgentMessage[], cut: number): number {
	const prefixCallIds = new Set<string>();
	for (let i = 0; i < cut; i++) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		for (const content of message.content) {
			if (content.type === "toolCall") prefixCallIds.add(content.id);
		}
	}
	for (let i = cut; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role === "toolResult" && prefixCallIds.has(message.toolCallId)) return i;
	}
	return -1;
}

/**
 * Rough render-cost proxy for one message: text/thinking bytes dominate
 * markdown lex+highlight time, tool-call arguments carry write/edit payloads.
 * Image data is materialized to links and never lexed, so it is not counted.
 */
function estimateMessageRenderBytes(message: AgentMessage): number {
	if (!("content" in message)) return 256;
	const content = message.content;
	if (typeof content === "string") return content.length + 64;
	if (!Array.isArray(content)) return 256;
	let bytes = 64;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		if ("text" in block && typeof block.text === "string") bytes += block.text.length;
		if ("thinking" in block && typeof block.thinking === "string") bytes += block.thinking.length;
		if ("arguments" in block && block.arguments !== undefined) bytes += JSON.stringify(block.arguments).length;
	}
	return bytes;
}

type QueuedMessages = {
	steering: string[];
	followUp: string[];
};
type AddMessageOptions = {
	populateHistory?: boolean;
	imageLinks?: readonly (string | undefined)[];
	reuseSettledComponent?: boolean;
};

function imageLinksForMessage(
	message: Extract<AgentMessage, { role: "developer" | "user" }>,
	putBlobSync: InteractiveModeContext["sessionManager"]["putBlobSync"],
): (string | undefined)[] | undefined {
	if (typeof message.content === "string") return undefined;
	const images = message.content.filter(
		(content): content is ImageContent =>
			content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
	);
	return materializeImageReferenceLinksSync(images, putBlobSync);
}

export class UiHelpers {
	#lastWarningMessage: string | undefined = undefined;
	#lastWarningCount = 0;
	private ctx: InteractiveModeContext;
	readonly #windowConfig: TranscriptWindowConfig;
	/** Set only while a backfill chunk pumps synchronously; live renders always hit the default sink. */
	#transcriptSink: TranscriptRenderSink | null = null;
	#backfill: TranscriptBackfillState | null = null;
	readonly #defaultTranscriptSink: TranscriptRenderSink = {
		addChild: component => this.ctx.chatContainer.addChild(component),
		removeChild: component => this.ctx.chatContainer.removeChild(component),
		isBlockUncommitted: component => this.ctx.chatContainer.isBlockUncommitted(component),
		lastChild: () => {
			const children = this.ctx.chatContainer.children;
			return children[children.length - 1];
		},
	};

	constructor(ctx: InteractiveModeContext, transcriptWindow?: Partial<TranscriptWindowConfig>) {
		this.ctx = ctx;
		this.#windowConfig = { ...DEFAULT_TRANSCRIPT_WINDOW_CONFIG, ...transcriptWindow };
	}

	/** Extract text content from a user message */
	getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((content): content is TextBlock => content.type === "text");
		return textBlocks.map(block => block.text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	showStatus(message: string, options?: { dim?: boolean }): void {
		const children = this.ctx.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;
		const useDim = options?.dim ?? true;
		// Resolve the dim color lazily so a later theme change re-shapes the line
		// instead of leaving the palette that was active when it was presented.
		const styleFn = useDim ? (t: string) => theme.fg("dim", t) : undefined;

		if (last && secondLast && last === this.ctx.lastStatusText && secondLast === this.ctx.lastStatusSpacer) {
			this.ctx.lastStatusText.setStyleFn(styleFn);
			this.ctx.lastStatusText.setText(message);
			this.ctx.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(message, 1, 0).setStyleFn(styleFn);
		this.ctx.present([spacer, text]);
		this.ctx.lastStatusSpacer = spacer;
		this.ctx.lastStatusText = text;
	}

	addMessageToChat(message: AgentMessage, options?: AddMessageOptions): Component[] {
		const sink = this.#transcriptSink ?? this.#defaultTranscriptSink;
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				sink.addChild(component);
				break;
			}
			case "pythonExecution": {
				const component = new EvalExecutionComponent(message.code, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				sink.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom": {
				if (message.display) {
					if (message.customType === "async-result") {
						sink.addChild(buildAsyncResultBlock(message));
						break;
					}
					if (message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
						const details = (
							message as CustomMessage<{
								files?: LateDiagnosticsFile[];
							}>
						).details;
						const component = new LateDiagnosticsMessageComponent(details?.files ?? []);
						component.setExpanded(this.ctx.toolOutputExpanded);
						sink.addChild(component);
						break;
					}
					if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
						const component = new CollabPromptMessageComponent(message as CustomMessage<CollabPromptDetails>);
						sink.addChild(component);
						break;
					}
					if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
						const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
						component.setExpanded(this.ctx.toolOutputExpanded);
						sink.addChild(component);
						break;
					}
					if (
						message.customType === "irc:incoming" ||
						message.customType === "irc:autoreply" ||
						message.customType === "irc:relay"
					) {
						const card = buildIrcMessageCard(message, () => this.ctx.toolOutputExpanded);
						sink.addChild(card);
						return [card];
					}
					if (message.customType === "advisor") {
						const details = (message as CustomMessage<AdvisorMessageDetails>).details;
						sink.addChild(createAdvisorMessageCard(details, () => this.ctx.toolOutputExpanded, theme));
						break;
					}
					if (message.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
						sink.addChild(createBackgroundTanDispatchBlock(message as CustomMessage<unknown>));
						break;
					}
					const handoffComponent = createHandoffSummaryMessageComponent(
						message as CustomMessage<unknown>,
						this.ctx.toolOutputExpanded,
					);
					if (handoffComponent) {
						sink.addChild(handoffComponent);
						break;
					}
					const renderer = this.ctx.viewSession.extensionRunner?.getMessageRenderer(message.customType);
					// Both HookMessage and CustomMessage have the same structure, cast for compatibility
					const component = new CustomMessageComponent(message as CustomMessage<unknown>, renderer);
					component.setExpanded(this.ctx.toolOutputExpanded);
					sink.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				sink.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				sink.addChild(component);
				break;
			}
			case "fileMention": {
				// Render compact file mention display
				const block = buildFileMentionBlock(message.files, 0);
				if (block.children.length > 0) sink.addChild(block);
				break;
			}
			case "user":
			case "developer": {
				const textContent = this.ctx.getUserMessageText(message);
				if (textContent) {
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					const cached = options?.reuseSettledComponent
						? this.ctx.transcriptMessageComponents.get(message)
						: undefined;
					let userComponent: UserMessageComponent;
					if (cached instanceof UserMessageComponent) {
						userComponent = cached;
					} else {
						const imageLinks =
							options?.imageLinks ??
							imageLinksForMessage(
								message,
								this.ctx.viewSession.sessionManager.putBlobSync.bind(this.ctx.viewSession.sessionManager),
							);
						userComponent = new UserMessageComponent(textContent, isSynthetic, imageLinks);
						this.ctx.transcriptMessageComponents.set(message, userComponent);
					}
					sink.addChild(userComponent);
					if (options?.populateHistory && message.role === "user" && !isSynthetic) {
						this.ctx.editor.addToHistory(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const cached = options?.reuseSettledComponent
					? this.ctx.transcriptMessageComponents.get(message)
					: undefined;
				const assistantComponent =
					cached instanceof AssistantMessageComponent
						? cached
						: createAssistantMessageComponent(this.ctx, splitAssistantMessageToolTimeline(message).beforeTools);
				if (cached !== assistantComponent) {
					this.ctx.transcriptMessageComponents.set(message, assistantComponent);
				}
				sink.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				message satisfies never;
			}
		}
		return [];
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	renderSessionContext(sessionContext: SessionContext, options: RenderSessionContextOptions = {}): void {
		const range = this.#renderTranscriptRange(sessionContext, options, {
			start: 0,
			end: sessionContext.messages.length,
			pendingTools: this.ctx.pendingTools,
			seedLastAssistantUsage: undefined,
			trailing: "tail",
		});
		// Full replay: pump the range generator to completion in one go. The
		// yields exist for the windowed resume path (see renderInitialMessages),
		// which pumps the same generator in event-loop-bounded chunks.
		while (!range.next().done) {
			// drain
		}
		this.ctx.ui.requestRender();
	}

	/**
	 * Reconstruct transcript components for context messages [start, end).
	 * Yields after each message so a caller can bound event-loop occupancy; the
	 * loop state (read-group merging, deferred usage rows, displaceable
	 * snapshots) lives on the generator frame, so a chunked prefix replay is
	 * byte-identical to an uninterrupted one.
	 */
	*#renderTranscriptRange(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions,
		runtime: TranscriptRangeRuntime,
	): Generator<void, void, void> {
		const sink = this.#transcriptSink ?? this.#defaultTranscriptSink;
		// Preserved: message_start handler owns this lifecycle (see #783)
		const pendingTools = runtime.pendingTools;
		pendingTools.clear();
		// Reseed the cache-invalidation baseline: this rebuild re-derives every
		// turn's marker from usage, and the last turn becomes the live baseline.
		this.ctx.lastAssistantUsage = runtime.seedLastAssistantUsage;

		if (options.updateFooter) {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}

		let readGroup: ReadToolGroupComponent | null = null;
		const readToolCallArgs = new Map<string, Record<string, unknown>>();
		const readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
		// Defer per-turn metrics until the turn's tool results have materialized.
		// Read-only invisible turns attach the metrics to their shared compact
		// group; every other turn keeps the standalone row below its tool blocks.
		let pendingUsage: Usage | undefined;
		let pendingUsageDuration: number | undefined;
		let pendingUsageTtft: number | undefined;
		let pendingUsageTimestamp: number | undefined;
		let pendingReadUsageCallIds: string[] | undefined;
		const flushPendingUsage = () => {
			if (!pendingUsage) return;
			const usageAttached =
				pendingReadUsageCallIds !== undefined &&
				(readGroup?.attachUsage(
					pendingReadUsageCallIds,
					pendingUsage,
					pendingUsageDuration,
					pendingUsageTtft,
					pendingUsageTimestamp,
				) ??
					false);
			if (!usageAttached) {
				readGroup?.seal();
				readGroup = null;
				sink.addChild(
					createUsageRowBlock(pendingUsage, pendingUsageDuration, pendingUsageTtft, pendingUsageTimestamp),
				);
			}
			pendingUsage = undefined;
			pendingUsageDuration = undefined;
			pendingUsageTtft = undefined;
			pendingUsageTimestamp = undefined;
			pendingReadUsageCallIds = undefined;
		};
		// Rebuild-time mirror of the event controller's displaceable-poll
		// bookkeeping: a `hub` wait that found every watched job still running is
		// superseded by the next `hub` call, so a rebuilt transcript collapses a
		// repeated-poll run to its final snapshot instead of replaying the spam.
		let waitingPoll: ToolExecutionComponent | null = null;
		const resolveWaitingPoll = (nextToolName?: string) => {
			const previous = waitingPoll;
			if (!previous) return;
			waitingPoll = null;
			if (nextToolName === "hub" && previous.isDisplaceableBlock() && sink.isBlockUncommitted(previous)) {
				sink.removeChild(previous);
			}
			// Sealing freezes the block and stops the waiting-poll spinner that
			// updateResult armed.
			previous.seal();
		};
		let todoSnapshot: ToolExecutionComponent | null = null;
		const resolveTodoSnapshot = (nextToolName?: string) => {
			const previous = todoSnapshot;
			if (!previous) return;
			if (!previous.isDisplaceableBlock()) {
				todoSnapshot = null;
				return;
			}
			if (previous.canBeDisplacedBy(nextToolName)) {
				todoSnapshot = null;
				if (sink.isBlockUncommitted(previous)) {
					sink.removeChild(previous);
				}
				previous.seal();
				return;
			}
			if (nextToolName !== undefined) return;
			todoSnapshot = null;
			previous.seal();
		};
		const messages = sessionContext.messages;
		for (let i = runtime.start; i < runtime.end; i++) {
			const message = messages[i]!;
			if (message.role !== "toolResult") flushPendingUsage();
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				const timeline = splitAssistantMessageToolTimeline(message);
				this.ctx.addMessageToChat(message, { reuseSettledComponent: options.reuseSettledComponents });
				const lastChild = sink.lastChild();
				const assistantComponent = lastChild instanceof AssistantMessageComponent ? lastChild : undefined;
				if (assistantComponent) {
					const usage = message.usage;
					const explained = sessionContext.cacheMissExplainedAt?.[i] ?? false;
					if (this.ctx.settings.get("display.cacheMissMarker") && !explained) {
						const invalidation = detectCacheInvalidation(this.ctx.lastAssistantUsage, usage);
						if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
					}
					if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
						this.ctx.lastAssistantUsage = usage;
					}
				}
				const hasVisibleAssistantContent = assistantHasVisibleContent(message);
				if (hasVisibleAssistantContent) {
					// Rebuild reconstructs immutable history; seal (not finalize) so the
					// group freezes even if a read's result was never persisted —
					// finalize alone keeps a pending entry live and would stop the whole
					// transcript below it from committing to native scrollback.
					readGroup?.seal();
					readGroup = null;
				}
				const errorPresentation = resolveAssistantErrorPresentation(message, this.ctx.viewSession.retryAttempt);
				const hasErrorStop = errorPresentation.kind === "full";
				const errorMessage = hasErrorStop ? errorPresentation.text : null;
				const appendAssistantSegment = (segment: AssistantMessage | undefined) => {
					if (!segment || !assistantHasVisibleContent(segment)) return;
					const component = createAssistantMessageComponent(this.ctx, segment);
					sink.addChild(component);
				};

				// Render tool call components
				for (const content of message.content) {
					if (content.type !== "toolCall") {
						continue;
					}
					const afterToolSegment = timeline.afterToolCalls.get(content.id);
					if (options.preservedLiveToolCallIds?.has(content.id)) {
						appendAssistantSegment(afterToolSegment);
						continue;
					}
					resolveWaitingPoll(content.name);

					if (content.name === "read" && readArgsCollapseIntoGroup(content.arguments)) {
						if (hasErrorStop && errorMessage) {
							if (!readGroup) {
								readGroup = new ReadToolGroupComponent({
									showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
								});
								readGroup.setExpanded(this.ctx.toolOutputExpanded);
								readGroup.setToolActivityVisible(!this.ctx.hideToolActivity);
								sink.addChild(readGroup);
							}
							readGroup.updateArgs(content.arguments, content.id);
							readGroup.updateResult(
								{ content: [{ type: "text", text: errorMessage }], isError: true },
								false,
								content.id,
							);
						} else if (afterToolSegment) {
							if (!readGroup) {
								readGroup = new ReadToolGroupComponent({
									showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
								});
								readGroup.setExpanded(this.ctx.toolOutputExpanded);
								readGroup.setToolActivityVisible(!this.ctx.hideToolActivity);
								sink.addChild(readGroup);
							}
							readGroup.updateArgs(content.arguments, content.id);
							pendingTools.set(content.id, readGroup);
							if (assistantComponent) {
								readToolCallAssistantComponents.set(content.id, assistantComponent);
							}
						} else {
							const normalizedArgs = normalizeToolArgs(content.arguments);
							readToolCallArgs.set(content.id, normalizedArgs);
							if (assistantComponent) {
								readToolCallAssistantComponents.set(content.id, assistantComponent);
							}
						}
						appendAssistantSegment(afterToolSegment);
						continue;
					}

					readGroup?.seal();
					readGroup = null;
					const tool = this.ctx.viewSession.getToolByName(content.name);
					const partialJson = getStreamingPartialJson(content);
					// Mid-stream rebuild (theme change, settings, focus replay): decode
					// display args from the raw stream exactly like the live reveal path.
					// The provider-parsed `arguments` lag the stream by up to a throttled
					// parse window, so spreading them alone would freeze a long write/edit
					// preview at its last full parse.
					const rawInput = content.customWireName !== undefined;
					const renderArgs = partialJson
						? decodeStreamedToolArgs(partialJson, {
								rawInput,
								fullArgs: content.arguments,
								streamingStringKeys: streamingStringKeysForTool(content.name, rawInput),
							})
						: content.arguments;
					const component = new ToolExecutionComponent(
						content.name,
						renderArgs,
						{
							snapshots: getFileSnapshotStore(this.ctx.viewSession),
							clipboard: getEditClipboard(this.ctx.viewSession),
							showImages: settings.get("terminal.showImages"),
							editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
							editAllowFuzzy: settings.get("edit.fuzzyMatch"),
							liveRegion: this.ctx.chatContainer,
						},
						tool,
						this.ctx.ui,
						this.ctx.viewSession.sessionManager.getCwd(),
						content.id,
					);
					component.setExpanded(this.ctx.toolOutputExpanded);
					component.setToolActivityVisible(!this.ctx.hideToolActivity);
					sink.addChild(component);

					if (hasErrorStop && errorMessage) {
						component.updateResult(
							{ content: [{ type: "text", text: errorMessage }], isError: true },
							false,
							content.id,
						);
					} else {
						pendingTools.set(content.id, component);
					}
					appendAssistantSegment(afterToolSegment);
				}
				// Dangling toolCalls (no result on the resolved path — failed or
				// retried turns, results on sibling branches) were stripped by the
				// context build; surface a placeholder so the turn's activity is
				// visibly elided instead of silently vanishing (the "bare thinking
				// lines" transcript trap).
				const strippedToolCalls = (message as AgentMessage & StrippedToolCallsMarker).strippedToolCalls ?? 0;
				if (strippedToolCalls > 0) {
					sink.addChild(new StrippedToolCallsPlaceholder(strippedToolCalls, !this.ctx.hideToolActivity));
				}
				pendingUsage =
					this.ctx.settings.get("display.showTokenUsage") && assistantUsageIsBilled(message.usage)
						? message.usage
						: undefined;
				pendingUsageDuration = message.duration;
				pendingUsageTtft = message.ttft;
				pendingUsageTimestamp = message.timestamp;
				pendingReadUsageCallIds = pendingUsage ? groupedReadUsageCallIds(message) : undefined;
			} else if (message.role === "toolResult") {
				if (options.preservedLiveToolCallIds?.has(message.toolCallId)) continue;
				const pendingReadComponent = pendingTools.get(message.toolCallId);
				const isReadGroupResult =
					message.toolName === "read" &&
					(!pendingReadComponent || pendingReadComponent instanceof ReadToolGroupComponent);
				if (isReadGroupResult) {
					const assistantComponent = readToolCallAssistantComponents.get(message.toolCallId);
					const images: ImageContent[] = message.content.filter(
						(content): content is ImageContent => content.type === "image",
					);
					if (images.length > 0 && assistantComponent) {
						assistantComponent.setToolResultImages(message.toolCallId, images);
						const hasText = message.content.some(c => c.type === "text");
						if (!hasText && settings.get("terminal.showImages")) {
							readToolCallArgs.delete(message.toolCallId);
							readToolCallAssistantComponents.delete(message.toolCallId);
							continue;
						}
					}
					let component = pendingTools.get(message.toolCallId);
					if (!component) {
						if (!readGroup) {
							readGroup = new ReadToolGroupComponent({
								showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
							});
							readGroup.setExpanded(this.ctx.toolOutputExpanded);
							readGroup.setToolActivityVisible(!this.ctx.hideToolActivity);
							sink.addChild(readGroup);
						}
						const args = readToolCallArgs.get(message.toolCallId);
						if (args) {
							readGroup.updateArgs(args, message.toolCallId);
						}
						component = readGroup;
						pendingTools.set(message.toolCallId, readGroup);
					}
					component.updateResult(message, false, message.toolCallId);
					pendingTools.delete(message.toolCallId);
					readToolCallArgs.delete(message.toolCallId);
					readToolCallAssistantComponents.delete(message.toolCallId);
					continue;
				}

				// Match tool results to pending tool components
				const component = pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message, false, message.toolCallId);
					pendingTools.delete(message.toolCallId);
					if (
						message.toolName === "hub" &&
						component instanceof ToolExecutionComponent &&
						component.isDisplaceableBlock()
					) {
						waitingPoll = component;
					} else if (
						message.toolName === "todo" &&
						component instanceof ToolExecutionComponent &&
						component.canBeDisplacedBy("todo")
					) {
						// A successful todo result supersedes the prior live snapshot. Failed
						// follow-ups return false from canBeDisplacedBy("todo"), so the
						// last-good panel stays on screen.
						resolveTodoSnapshot("todo");
						todoSnapshot = component;
					}
				}
			} else {
				readGroup?.seal();
				readGroup = null;
				// A user prompt closes the displacement window, same as the live path.
				if (message.role === "user") resolveWaitingPoll();
				if (message.role === "user") resolveTodoSnapshot();
				// All other messages use standard rendering
				this.ctx.addMessageToChat(message, options);
			}
			yield;
		}
		flushPendingUsage();

		// The trailing read run has no following break to close it; seal so the
		// rebuilt group freezes (even with a never-persisted result) and commits to
		// native scrollback like every other historical block.
		readGroup?.seal();
		// A trailing waiting poll is final history on rebuild; seal it so it
		// freezes (and its spinner timer stops) like every other block.
		resolveWaitingPoll();
		// A trailing todo snapshot is live state, not history: when the rebuild
		// runs mid-turn (settings overlay close, focus attach during streaming),
		// hand it back to the controller so a follow-up `todo` update keeps
		// displacing instead of stacking. Idle rebuilds (resume / compaction)
		// fall through to the seal path so the snapshot freezes as history.
		// "boundary" ranges always seal: the user prompt right after the range
		// takes this exact path in a full replay, and the streaming handoff only
		// exists at the true transcript tail.
		if (runtime.trailing === "tail" && todoSnapshot && this.ctx.viewSession.isStreaming) {
			this.ctx.eventController?.inheritDisplaceableTodo(todoSnapshot);
			todoSnapshot = null;
		} else {
			resolveTodoSnapshot();
		}

		// Entries still in `pendingTools` are toolCalls whose result never landed
		// during the replay — with `keepDanglingToolCalls` these are exactly the
		// turn's in-flight calls (assistant turn persisted at message_end, tool
		// still executing). While the viewed session streams, keep them tracked so
		// the live event stream routes `tool_execution_update`/`_end` into the
		// rebuilt components instead of dropping the result; their args are final,
		// so mark them complete. Idle rebuilds have no result coming: seal so the
		// blocks freeze as history instead of pinning the live region, then clear
		// so reconstructed historical components never leak into live tracking.
		// (`rebuildChatFromMessages` builds its context WITHOUT dangling calls and
		// restores its own preserved live components afterwards — for that caller
		// the map is empty here either way.)
		if (runtime.trailing === "tail" && this.ctx.viewSession.isStreaming) {
			for (const [toolCallId, component] of pendingTools) {
				component.setArgsComplete(toolCallId);
			}
		} else {
			for (const component of pendingTools.values()) {
				component.seal();
			}
			pendingTools.clear();
		}
	}

	renderInitialMessages(options: RenderInitialMessagesOptions = {}): void {
		// A superseded backfill must never front-insert into the fresh render.
		this.#cancelTranscriptBackfill();
		// This path is used to rebuild the visible chat transcript (e.g. after custom/debug UI).
		// Clear existing rendered chat first to avoid duplicating the full session in the container.
		// On a non-preserving rebuild the existing blocks are discarded for good, so
		// dispose them (stopping any live timers/subscriptions) before clearing. When
		// preserving, the same instances are re-added below, so detach without dispose.
		const preservedChatChildren = options.preserveExistingChat ? this.ctx.chatContainer.children : undefined;
		this.ctx.initialChatRendered = true;
		if (preservedChatChildren) {
			this.ctx.chatContainer.clear();
		} else {
			this.ctx.resetTranscript();
		}
		this.ctx.pendingMessagesContainer.disposeChildren();
		this.ctx.pendingBashComponents = [];
		this.ctx.pendingPythonComponents = [];

		// Live display collapses to the compacted transcript tail unless the
		// user opted into the full inline history; export/resume callers can
		// still request either mode. Mid-turn rebuilds
		// (focus attach/unfocus while a tool executes) keep dangling toolCalls so
		// the in-flight call re-renders as pending instead of vanishing;
		// renderSessionContext then keeps it in `pendingTools` for live routing.
		const context = this.ctx.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: settings.get("display.collapseCompacted"),
			keepDanglingToolCalls: this.ctx.viewSession.isStreaming,
		});
		const windowPlan = this.#planTranscriptWindow(context.messages);
		if (windowPlan === null) {
			this.ctx.renderSessionContext(context, {
				updateFooter: true,
				populateHistory: !this.ctx.focusedAgentId,
			});
		} else {
			this.#renderWindowedTranscript(context, windowPlan);
		}

		// Show compaction info if session was compacted
		const allEntries = this.ctx.viewSession.sessionManager.getEntries();
		let compactionCount = 0;
		for (const entry of allEntries) {
			if (entry.type === "compaction") {
				compactionCount++;
			}
		}
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.ctx.showStatus(`Session compacted ${times}`);
		}
		if (options.clearTerminalHistory) {
			this.ctx.ui.requestRender(true, { clearScrollback: true });
		}
		if (preservedChatChildren && preservedChatChildren.length > 0) {
			for (const child of preservedChatChildren) {
				this.ctx.chatContainer.addChild(child);
			}
			this.ctx.ui.requestRender();
		}
	}

	/**
	 * Resume path for large transcripts: synchronously render only the tail
	 * window [plan.cut, end) so the first paint lands fast, then backfill the
	 * older prefix [0, plan.cut) in event-loop-bounded chunks. The cut sits
	 * right before a user prompt with every tool call/result pair kept on one
	 * side (#findSafeWindowCut), so the concatenated transcript is
	 * byte-identical to a full replay once the backfill completes.
	 */
	#renderWindowedTranscript(context: SessionContext, plan: TranscriptWindowPlan): void {
		// The whole-transcript side effects of a full render stay synchronous and
		// in transcript order: thinking-content detection (a cheap early-exit
		// scan, normally done by the ctx.renderSessionContext wrapper) and editor
		// history (Up-arrow recall must end oldest→newest even though the tail
		// renders first, so per-message populateHistory stays off below).
		for (const message of context.messages) {
			this.ctx.noteDisplayableThinkingContent(message);
		}
		if (!this.ctx.focusedAgentId) {
			for (const message of context.messages) {
				if (message.role !== "user" || (message.synthetic ?? false)) continue;
				const text = this.getUserMessageText(message);
				if (text) this.ctx.editor.addToHistory(text);
			}
		}
		const range = this.#renderTranscriptRange(
			context,
			{ updateFooter: true, populateHistory: false },
			{
				start: plan.cut,
				end: context.messages.length,
				pendingTools: this.ctx.pendingTools,
				seedLastAssistantUsage: plan.carryUsage,
				trailing: "tail",
			},
		);
		while (!range.next().done) {
			// Synchronous window render; the plan sizes it to the first-paint budget.
		}
		this.ctx.ui.requestRender();
		this.#scheduleTranscriptBackfill(context, plan.cut);
	}

	/**
	 * Size the initial tail window and pick a safe cut for it. Returns null when
	 * the transcript is small enough for a full render or no safe cut exists.
	 */
	#planTranscriptWindow(messages: AgentMessage[]): TranscriptWindowPlan | null {
		const config = this.#windowConfig;
		const count = messages.length;
		if (count < config.minTotalMessages) return null;
		// Mid-turn rebuilds keep dangling tool calls wired for live routing; the
		// window boundary cannot represent that, so they replay in full.
		if (this.ctx.viewSession.isStreaming) return null;
		let cut = count;
		let bytes = 0;
		let windowMessages = 0;
		while (cut > 0 && windowMessages < config.maxWindowMessages) {
			if (windowMessages >= config.minWindowMessages && bytes >= config.windowByteBudget) break;
			cut--;
			bytes += estimateMessageRenderBytes(messages[cut]!);
			windowMessages++;
		}
		if (cut <= 0) return null; // the window would cover the whole transcript anyway
		const safeCut = this.#findSafeWindowCut(messages, cut);
		if (safeCut === null || safeCut <= 0 || safeCut >= count) return null;
		// The window's first assistant turn derives its cache-invalidation marker
		// against the prefix's last billed usage — carry it across the cut.
		let carryUsage: Usage | undefined;
		for (let i = safeCut - 1; i >= 0; i--) {
			const message = messages[i]!;
			if (message.role !== "assistant") continue;
			const usage = message.usage;
			if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
				carryUsage = usage;
				break;
			}
		}
		return { cut: safeCut, carryUsage };
	}

	/**
	 * Snap a candidate cut forward to the next boundary a split replay can
	 * reproduce exactly: right before a user prompt (which in a full replay
	 * seals any open read group and every displaceable snapshot, so neither the
	 * prefix nor the window needs carried references to each other's blocks),
	 * and with every tool call/result pair on one side of the cut (each range
	 * pairs results against its own registry; a straddling pair would orphan).
	 */
	#findSafeWindowCut(messages: AgentMessage[], candidate: number): number | null {
		const count = messages.length;
		let cut = candidate;
		for (let attempts = 0; attempts < 8; attempts++) {
			while (cut < count && messages[cut]!.role !== "user") cut++;
			if (cut >= count) break;
			if (cut <= 0) return null;
			const straddle = firstStraddlingToolResult(messages, cut);
			if (straddle === -1) return cut;
			// A window result belongs to a prefix call: grow the prefix past it.
			cut = straddle + 1;
		}
		// No user prompt at/after the candidate — the transcript ends in one
		// giant turn (the norm for heavy agentic sessions). Grow the window
		// backward to the nearest earlier prompt boundary instead; it may exceed
		// maxWindowMessages, but a slower first paint beats replaying the whole
		// transcript (the null fallback, i.e. the old behavior).
		for (let back = candidate - 1; back > 0; back--) {
			if (messages[back]!.role !== "user") continue;
			if (firstStraddlingToolResult(messages, back) === -1) return back;
		}
		return null;
	}

	#scheduleTranscriptBackfill(context: SessionContext, cut: number): void {
		const container = this.ctx.chatContainer;
		const state: TranscriptBackfillState = {
			epoch: container.getMutationEpoch(),
			sink: {
				addChild: component => {
					container.insertChildAt(state.insertIndex, component);
					state.insertIndex++;
				},
				removeChild: component => {
					const index = container.children.indexOf(component);
					container.removeChild(component);
					if (index >= 0 && index < state.insertIndex) state.insertIndex--;
				},
				isBlockUncommitted: component => container.isBlockUncommitted(component),
				lastChild: () => (state.insertIndex > 0 ? container.children[state.insertIndex - 1] : undefined),
			},
			range: this.#renderTranscriptRange(
				context,
				{ updateFooter: false, populateHistory: false },
				{
					start: 0,
					end: cut,
					pendingTools: new Map<string, ToolExecutionHandle>(),
					seedLastAssistantUsage: undefined,
					trailing: "boundary",
				},
			),
			insertIndex: 0,
			prefixUsage: undefined,
			scheduled: false,
		};
		this.#backfill = state;
		// No transcript row may commit to native scrollback while older blocks
		// are still being front-inserted above it.
		container.setBackfillPinned(true);
		this.#pumpTranscriptBackfillSoon(state);
	}

	#pumpTranscriptBackfillSoon(state: TranscriptBackfillState): void {
		if (state.scheduled) return;
		state.scheduled = true;
		setImmediate(() => {
			state.scheduled = false;
			this.#pumpTranscriptBackfill(state);
		});
	}

	#pumpTranscriptBackfill(state: TranscriptBackfillState): void {
		if (this.#backfill !== state) return; // superseded by a newer initial render
		const container = this.ctx.chatContainer;
		if (container.getMutationEpoch() !== state.epoch) {
			// The container was cleared and rebuilt (session switch, compaction,
			// theme replay); that rebuild owns the transcript now, and the clear
			// already released the backfill pin.
			this.#backfill = null;
			return;
		}
		// Park the live cache-invalidation baseline for the chunk's duration:
		// the prefix replay tracks its own, and the live value must survive
		// untouched for the next real turn.
		const liveUsage = this.ctx.lastAssistantUsage;
		this.ctx.lastAssistantUsage = state.prefixUsage;
		this.#transcriptSink = state.sink;
		const deadline = performance.now() + this.#windowConfig.chunkBudgetMs;
		let done = false;
		try {
			const width = container.getLastRenderWidth();
			do {
				const before = state.insertIndex;
				if (state.range.next().done) {
					done = true;
					break;
				}
				if (width > 0) {
					// Warm each new block's per-width render cache inside the time
					// budget so the next frame reuses rows instead of re-rendering.
					for (let i = before; i < state.insertIndex; i++) {
						container.children[i]!.render(width);
					}
				}
			} while (performance.now() < deadline);
		} finally {
			this.#transcriptSink = null;
			state.prefixUsage = this.ctx.lastAssistantUsage;
			this.ctx.lastAssistantUsage = liveUsage;
		}
		if (done) {
			this.#backfill = null;
			// History is complete; rows above the viewport may commit again.
			container.setBackfillPinned(false);
			this.ctx.ui.requestRender();
			return;
		}
		this.ctx.ui.requestRender();
		this.#pumpTranscriptBackfillSoon(state);
	}

	#cancelTranscriptBackfill(): void {
		if (this.#backfill === null) return;
		this.#backfill = null;
		this.ctx.chatContainer.setBackfillPinned(false);
	}

	/** Test hook: whether a lazy prefix backfill is still pumping. */
	hasPendingTranscriptBackfill(): boolean {
		return this.#backfill !== null;
	}

	clearEditor(): void {
		this.ctx.editor.clearDraft();
		this.ctx.ui.requestRender();
	}

	showError(errorMessage: string): void {
		const text = new Text(`Error: ${errorMessage}`, 1, 0).setStyleFn(t => theme.fg("error", t));
		this.ctx.present([new Spacer(1), text]);
	}

	/**
	 * Show a warning message in the chat.
	 *
	 * Identical warnings emitted back-to-back (without anything else being added
	 * to the chat in between) update the previous warning row with a repeat
	 * count instead of appending new ones — a stalled turn whose N unexecuted
	 * todo calls each fail would otherwise spam N identical rows. Mirrors the
	 * showStatus coalescing precedent above.
	 */
	showWarning(warningMessage: string): void {
		const children = this.ctx.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (
			last &&
			secondLast &&
			last === this.ctx.lastWarningText &&
			secondLast === this.ctx.lastWarningSpacer &&
			this.#lastWarningMessage === warningMessage
		) {
			this.#lastWarningCount += 1;
			this.ctx.lastWarningText.setText(`Warning: ${warningMessage} (×${this.#lastWarningCount})`);
			this.ctx.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(`Warning: ${warningMessage}`, 1, 0).setStyleFn(t => theme.fg("warning", t));
		this.ctx.present([spacer, text]);
		this.ctx.lastWarningSpacer = spacer;
		this.ctx.lastWarningText = text;
		this.#lastWarningMessage = warningMessage;
		this.#lastWarningCount = 1;
	}

	showNewVersionNotification(newVersion: string): void {
		const block = new TranscriptBlock();
		block.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		const title = "Update Available";
		const prefix = `New version ${newVersion} is available. Run: `;
		const command = "omp update";
		block.addChild(
			new Text(`${title}\n${prefix}${command}`, 1, 0).setStyleFn(
				() =>
					`${theme.bold(theme.fg("warning", title))}\n${theme.fg("muted", prefix)}${theme.fg("accent", command)}`,
			),
		);
		block.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		this.ctx.present(block);
	}

	updatePendingMessagesDisplay(): void {
		this.ctx.pendingMessagesContainer.disposeChildren();
		const queuedMessages = this.ctx.viewSession.getQueuedMessages() as QueuedMessages;

		const steeringMessages = [...queuedMessages.steering];
		for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
			if (entry.mode === "steer") steeringMessages.push(entry.text);
		}

		const followUpMessages = [...queuedMessages.followUp];
		for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
			if (entry.mode === "followUp") followUpMessages.push(entry.text);
		}

		const groups = [
			{ label: "Steering", messages: steeringMessages },
			{ label: "After yield", messages: followUpMessages },
		].filter(group => group.messages.length > 0);
		if (groups.length > 0) {
			this.ctx.pendingMessagesContainer.addChild(new Spacer(1));
			for (const group of groups) {
				const heading = theme.fg("muted", `${group.label}${theme.sep.dot}${group.messages.length}`);
				this.ctx.pendingMessagesContainer.addChild(new TruncatedText(heading, 1, 0));
				for (let index = 0; index < group.messages.length; index++) {
					const message = replaceTabs(group.messages[index] ?? "").replace(/\r?\n/g, " ↵ ");
					const queuedText = theme.fg("dim", `  ${index + 1}. ${message}`);
					this.ctx.pendingMessagesContainer.addChild(new TruncatedText(queuedText, 1, 0));
				}
			}
			const dequeueKey = this.ctx.keybindings.getDisplayString("app.message.dequeue") || "Alt+Up";
			const hintText = theme.fg("dim", `  ${theme.tree.hook} ${dequeueKey} to edit`);
			this.ctx.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
		this.ctx.ui.requestComponentRender(this.ctx.pendingMessagesContainer);
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		const queuedImages = images && images.length > 0 ? images : undefined;
		this.ctx.compactionQueuedMessages.push({ text, mode, images: queuedImages } as CompactionQueuedMessage);
		this.ctx.editor.clearDraft(text);
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.showStatus(
			queuedImages ? "Queued message with image for after compaction" : "Queued message for after compaction",
		);
	}

	async #deliverQueuedMessage(message: CompactionQueuedMessage): Promise<void> {
		if (
			await invokeSkillCommandFromText(this.ctx, message.text, message.mode, {
				propagateErrors: true,
				queueOnly: true,
				images: message.images,
			})
		) {
			return;
		}
		if (this.ctx.isKnownSlashCommand(message.text)) {
			await this.ctx.session.prompt(message.text);
			return;
		}
		await this.ctx.withLocalSubmission(
			message.text,
			() =>
				message.mode === "followUp"
					? this.ctx.session.followUp(message.text, message.images)
					: this.ctx.session.steer(message.text, message.images),
			{ imageCount: message.images?.length ?? 0 },
		);
	}

	isKnownSlashCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (!commandName) return false;

		if (this.ctx.session.extensionRunner?.getCommand(commandName)) {
			return true;
		}

		for (const command of this.ctx.session.customCommands) {
			if (command.command.name === commandName) {
				return true;
			}
		}

		return this.ctx.fileSlashCommands.has(commandName);
	}

	async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.ctx.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...(this.ctx.compactionQueuedMessages as CompactionQueuedMessage[])];
		this.ctx.compactionQueuedMessages = [] as CompactionQueuedMessage[];
		this.ctx.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.ctx.session.clearQueue();
			this.ctx.compactionQueuedMessages = queuedMessages;
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				for (const message of queuedMessages) {
					await this.#deliverQueuedMessage(message);
				}
				this.ctx.updatePendingMessagesDisplay();
				return;
			}

			let firstPromptIndex = -1;
			for (let i = 0; i < queuedMessages.length; i++) {
				if (!this.ctx.isKnownSlashCommand(queuedMessages[i].text)) {
					firstPromptIndex = i;
					break;
				}
			}
			if (firstPromptIndex === -1) {
				for (const message of queuedMessages) {
					await this.ctx.session.prompt(message.text);
				}
				return;
			}

			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				// preCommands are all slash commands; #deliverQueuedMessage handles
				// that branch (no local-submission marking needed since slash
				// commands don't generate a matching user message_start).
				await this.#deliverQueuedMessage(message);
			}

			// First prompt is fire-and-forget — its rejection is funneled through
			// `restoreQueue` rather than rethrown. Plain prompts use primitive
			// recordLocalSubmission and dispose manually in the catch. Skill prompts
			// are rebuilt as user-attributed custom messages so queued `/skill:` text
			// is not sent as a literal prompt after compaction.
			let promptPromise: Promise<unknown>;
			if (isKnownSkillCommand(this.ctx, firstPrompt.text)) {
				const built = await buildSkillCommandPrompt(
					this.ctx,
					firstPrompt.text,
					firstPrompt.mode,
					firstPrompt.images,
				);
				promptPromise = built
					? this.ctx.session.promptCustomMessage(built.message, built.options).catch(restoreQueue)
					: Promise.resolve();
			} else {
				const disposeFirstPrompt = this.ctx.recordLocalSubmission(
					firstPrompt.text,
					firstPrompt.images?.length ?? 0,
				);
				promptPromise = this.ctx.session
					.prompt(firstPrompt.text, {
						streamingBehavior: firstPrompt.mode === "followUp" ? "followUp" : "steer",
						images: firstPrompt.images,
					})
					.catch((error: unknown) => {
						disposeFirstPrompt();
						restoreQueue(error);
					});
			}

			for (const message of rest) {
				await this.#deliverQueuedMessage(message);
			}
			this.ctx.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	flushPendingBashComponents(): void {
		for (const component of this.ctx.pendingBashComponents) {
			this.ctx.pendingMessagesContainer.removeChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingBashComponents = [];
		for (const component of this.ctx.pendingPythonComponents) {
			this.ctx.pendingMessagesContainer.removeChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingPythonComponents = [];
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.ctx.viewSession.messages.length - 1; i >= 0; i--) {
			const message = this.ctx.viewSession.messages[i];
			if (message?.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	extractAssistantText(message: AssistantMessage): string {
		let text = "";
		for (const content of message.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}
		return text.trim();
	}
}
