import { scheduler } from "node:timers/promises";
import { $env, logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	Context,
	Model,
	RawSseEvent,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	ToolChoice,
} from "../types";
import { resolveCacheRetention } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { OpenAIHttpError, postOpenAIStream } from "../utils/openai-http";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "../utils/retry-after";
import { sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { mapToOpenAIResponsesToolChoice } from "../utils/tool-choice";
import {
	applyOpenAIReasoningEffortFallback,
	createOpenAIReasoningEffortFallbackKey,
	type OpenAIReasoningEffortFallback,
	resolveOpenAIReasoningEffortFallback,
} from "./openai-reasoning-fallback";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "./openai-responses-wire";
import {
	applyCommonResponsesSamplingParams,
	applyResponsesReasoningParams,
	buildResponsesInput,
	calculateOpenAIResponsesTransientStreamRetryDelayMs,
	createInitialResponsesAssistantMessage,
	getOpenAIPromptCacheKey,
	isOpenAIResponsesProgressEvent,
	isOpenAIResponsesReplayUnsafeEvent,
	isRetryableOpenAIResponsesStreamFailure,
	parseAzureDeploymentNameMap,
	processResponsesStream,
} from "./openai-shared";

export { parseAzureDeploymentNameMap } from "./openai-shared";

const DEFAULT_AZURE_API_VERSION = "v1";
const AZURE_OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE =
	"Azure OpenAI responses stream timed out while waiting for the first event";
const AZURE_OPENAI_RESPONSES_MAX_TRANSIENT_STREAM_RETRIES = 2;

function resolveDeploymentName(model: Model<"azure-openai-responses">, options?: AzureOpenAIResponsesOptions): string {
	if (options?.azureDeploymentName) {
		return options.azureDeploymentName;
	}
	const mappedDeployment = parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id);
	return mappedDeployment ?? model.id;
}

// Azure OpenAI Responses-specific options
export interface AzureOpenAIResponsesOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
	toolChoice?: ToolChoice;
	serviceTier?: ServiceTier;
}

type AzureOpenAIResponsesSamplingParams = ResponseCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

/**
 * Generate function for Azure OpenAI Responses API
 */
export const streamAzureOpenAIResponses: StreamFunction<"azure-openai-responses"> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	if (options?.promptCache?.mode === "explicit" && resolveCacheRetention(options.cacheRetention) !== "none") {
		throw new AIError.ConfigurationError(
			`OpenAI explicit prompt caching is unsupported for ${model.provider}/${model.id}; Azure Responses does not emit explicit cache controls.`,
		);
	}
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const deploymentName = resolveDeploymentName(model, options);

		const output: AssistantMessage = createInitialResponsesAssistantMessage(
			"azure-openai-responses",
			model.provider,
			model.id,
		);
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(
			AZURE_OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE,
		);
		const { requestAbortController, requestSignal } = abortTracker;
		const onSseEvent = options?.onSseEvent;
		const rawSseObserver = onSseEvent
			? (event: RawSseEvent) => {
					if (!event.event && event.data && event.data !== "[DONE]") {
						try {
							const parsed = JSON.parse(event.data);
							const resolvedEvent =
								typeof parsed.type === "string"
									? parsed.type
									: typeof parsed.object === "string"
										? parsed.object
										: null;
							if (resolvedEvent) {
								event.event = resolvedEvent;
								event.raw = [`event: ${resolvedEvent}`, ...event.raw];
							}
						} catch {}
					}
					onSseEvent(event, model);
				}
			: undefined;

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const { url, headers, baseUrl } = buildAzureResponsesRequest(model, apiKey, options);
			const requestModel = modelForAzureEndpoint(model, baseUrl);
			let params = buildParams(requestModel, context, options, deploymentName);
			const replacementPayload = await options?.onPayload?.(params, requestModel);
			if (replacementPayload !== undefined) {
				params = replacementPayload as typeof params;
			}
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			const activeRawRequestDump: RawHttpRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url,
				body: params,
			};
			rawRequestDump = activeRawRequestDump;
			const reasoningEffortFallbackKey = createOpenAIReasoningEffortFallbackKey(
				"azure-responses",
				url,
				typeof params.model === "string" ? params.model : model.id,
			);
			const attemptedReasoningEffortFallbacks = new Set<string>();
			const openAzureResponsesStreamWithFallbacks = async (): Promise<AsyncIterable<ResponseStreamEvent>> => {
				while (true) {
					let requestTimeout: NodeJS.Timeout | undefined;
					if (requestTimeoutMs !== undefined) {
						requestTimeout = setTimeout(
							() => abortTracker.abortLocally(firstEventTimeoutAbortError),
							requestTimeoutMs,
						);
					}
					try {
						const headersWithTimeout = { ...headers };
						if (requestTimeoutMs !== undefined) {
							headersWithTimeout["X-Stainless-Timeout"] = Math.floor(requestTimeoutMs / 1000).toString();
						}
						const handle = await postOpenAIStream<ResponseStreamEvent>({
							url,
							headers: headersWithTimeout,
							body: params,
							signal: requestSignal,
							fetch: options?.fetch,
							// Transient 408/429/5xx get Retry-After-aware transport retries;
							// the first-event watchdog aborts `requestSignal`, so retries
							// cannot extend the caller's deadline.
							onSseEvent: rawSseObserver,
						});
						return handle.events;
					} catch (error) {
						const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
						const reasoningEffortFallback: OpenAIReasoningEffortFallback | undefined = !requestSignal.aborted
							? resolveOpenAIReasoningEffortFallback(error, capturedErrorResponse, params)
							: undefined;
						if (reasoningEffortFallback === undefined) throw error;
						const retryMarker = `${reasoningEffortFallbackKey}:${String(reasoningEffortFallback)}`;
						if (attemptedReasoningEffortFallbacks.has(retryMarker)) throw error;
						attemptedReasoningEffortFallbacks.add(retryMarker);
						applyOpenAIReasoningEffortFallback(params, reasoningEffortFallback);
						activeRawRequestDump.body = params;
					} finally {
						if (requestTimeout !== undefined) clearTimeout(requestTimeout);
					}
				}
			};
			let openaiStream = await openAzureResponsesStreamWithFallbacks();
			stream.push({ type: "start", partial: output });

			let transientStreamRetryAttempt = 0;
			while (true) {
				let sawReplayUnsafeOutput = false;
				let sawTerminalResponseEvent = false;
				const attemptStream = new AssistantMessageEventStream();
				let forwardAttemptLive = false;
				const forwardAttemptEvents = () => {
					for (const event of attemptStream.queue) stream.push(event);
					attemptStream.queue.length = 0;
				};
				const timedOpenaiStream = iterateWithIdleTimeout(openaiStream, {
					idleTimeoutMs,
					firstItemTimeoutMs: firstEventTimeoutMs,
					firstItemErrorMessage: AZURE_OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE,
					errorMessage: "Azure OpenAI responses stream stalled while waiting for the next event",
					onIdle: () => requestAbortController.abort(),
					onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
					abortSignal: options?.signal,
					isProgressItem: isOpenAIResponsesProgressEvent,
				});
				const observedOpenaiStream = (async function* (): AsyncGenerator<ResponseStreamEvent> {
					for await (const event of timedOpenaiStream) {
						if (isOpenAIResponsesReplayUnsafeEvent(event)) {
							sawReplayUnsafeOutput = true;
							if (!forwardAttemptLive) {
								forwardAttemptEvents();
								forwardAttemptLive = true;
							}
						}
						yield event;
						if (forwardAttemptLive) forwardAttemptEvents();
					}
				})();

				try {
					await processResponsesStream(observedOpenaiStream, output, attemptStream, model, {
						onFirstToken: () => {
							if (!firstTokenTime) firstTokenTime = performance.now();
						},
						onCompleted: () => {
							sawTerminalResponseEvent = true;
						},
					});

					const localAbortReason = abortTracker.getLocalAbortReason();
					if (localAbortReason) {
						throw localAbortReason;
					}

					if (abortTracker.wasCallerAbort()) {
						throw new AIError.AbortError();
					}

					if (!sawTerminalResponseEvent) {
						throw new AIError.ProviderResponseError(
							"Azure OpenAI responses stream closed before a terminal response event was received",
							{ provider: model.provider, kind: "incomplete-stream" },
						);
					}

					if (output.stopReason === "aborted" || output.stopReason === "error") {
						throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
							provider: model.provider,
							kind: "output",
						});
					}
					forwardAttemptEvents();
					break;
				} catch (error) {
					const streamFailure = abortTracker.getLocalAbortReason() ?? error;
					const canRetry =
						!sawReplayUnsafeOutput &&
						!requestSignal.aborted &&
						!abortTracker.wasCallerAbort() &&
						transientStreamRetryAttempt < AZURE_OPENAI_RESPONSES_MAX_TRANSIENT_STREAM_RETRIES &&
						isRetryableOpenAIResponsesStreamFailure(streamFailure);
					if (!canRetry) {
						forwardAttemptEvents();
						throw streamFailure;
					}

					transientStreamRetryAttempt++;
					logger.debug("Azure OpenAI responses stream ended before replay-unsafe output; retrying", {
						provider: model.provider,
						model: model.id,
						attempt: transientStreamRetryAttempt,
						error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
					});
					const backoffDelayMs = calculateOpenAIResponsesTransientStreamRetryDelayMs(
						transientStreamRetryAttempt - 1,
					);
					// Honor the server's retry hint (`retry-after-ms`/`retry-after`):
					// retrying sooner than the server asked is a guaranteed failure
					// that just burns the retry budget.
					const headerDelayMs = getRetryAfterMsFromHeaders(getHeadersFromError(streamFailure));
					// Bound the server-directed wait so a multi-hour `retry-after` cannot
					// park the provider stream before higher-level recovery runs. A non-positive cap
					// disables the bound; an over-cap hint surfaces the original error immediately.
					const maxRetryDelayMs = options?.maxRetryDelayMs ?? 60_000;
					if (headerDelayMs !== undefined && maxRetryDelayMs > 0 && headerDelayMs > maxRetryDelayMs) {
						forwardAttemptEvents();
						throw streamFailure;
					}
					const delayMs = headerDelayMs !== undefined ? Math.max(headerDelayMs, backoffDelayMs) : backoffDelayMs;
					const retryOutput = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
					output.content.length = 0;
					output.responseId = undefined;
					output.errorMessage = undefined;
					output.errorStatus = undefined;
					output.errorId = undefined;
					output.stopDetails = undefined;
					output.usage = retryOutput.usage;
					output.stopReason = "stop";
					output.duration = undefined;
					output.ttft = undefined;
					firstTokenTime = undefined;

					if (options?.providerRetryWait) {
						await options.providerRetryWait(delayMs, options.signal);
					} else {
						await scheduler.wait(delayMs, { signal: options?.signal });
					}
					if (abortTracker.wasCallerAbort()) throw new AIError.AbortError();
					openaiStream = await openAzureResponsesStreamWithFallbacks();
				}
			}

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			const result = await AIError.finalize(error, { api: model.api, abortTracker, rawRequestDump });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function resolveAzureConfig(
	model: Model<"azure-openai-responses">,
	options?: AzureOpenAIResponsesOptions,
): { baseUrl: string; apiVersion: string } {
	const apiVersion = options?.azureApiVersion || $env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

	const baseUrl = options?.azureBaseUrl?.trim() || $env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = options?.azureResourceName || $env.AZURE_OPENAI_RESOURCE_NAME;

	let resolvedBaseUrl = baseUrl;

	if (!resolvedBaseUrl && resourceName) {
		resolvedBaseUrl = `https://${resourceName}.openai.azure.com/openai/v1`;
	}

	if (!resolvedBaseUrl && model.baseUrl) {
		resolvedBaseUrl = model.baseUrl;
	}

	if (!resolvedBaseUrl) {
		throw new AIError.ConfigurationError(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	return {
		baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
		apiVersion,
	};
}

function modelForAzureEndpoint(
	model: Model<"azure-openai-responses">,
	baseUrl: string,
): Model<"azure-openai-responses"> {
	if (model.supportsComputerUseConfig !== undefined || model.supportsComputerUse !== true) return model;
	try {
		const url = new URL(baseUrl);
		if (
			url.protocol === "https:" &&
			(url.hostname.endsWith(".openai.azure.com") || url.hostname === "models.inference.ai.azure.com")
		) {
			return model;
		}
	} catch {}
	return { ...model, supportsComputerUse: false };
}

/**
 * Replicates the `AzureOpenAI` SDK client's request shape for `/responses`:
 * a string api key becomes a single `api-key` header (azure.mjs `authHeaders`;
 * never `Authorization: Bearer`), `api-version` rides as a query parameter
 * (azure.mjs constructor `defaultQuery`), and `/responses` is not a
 * deployment-scoped path, so no `/deployments/{model}` URL rewriting applies.
 * Custom model/options headers may override the auth header, matching the SDK's
 * `buildHeaders` precedence.
 */
function buildAzureResponsesRequest(
	model: Model<"azure-openai-responses">,
	apiKey: string,
	options?: AzureOpenAIResponsesOptions,
): { url: string; headers: Record<string, string>; baseUrl: string } {
	if (!apiKey) {
		const envKey = $env.AZURE_OPENAI_API_KEY;
		if (!envKey) {
			throw new AIError.MissingApiKeyError(
				undefined,
				"Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = envKey;
	}

	const headers: Record<string, string> = { "api-key": apiKey, ...(model.headers ?? {}) };
	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	return {
		url: `${baseUrl}/responses?api-version=${encodeURIComponent(apiVersion)}`,
		headers,
		baseUrl,
	};
}

function buildParams(
	model: Model<"azure-openai-responses">,
	context: Context,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
) {
	const systemRole = model.reasoning && model.compat.supportsDeveloperRole ? "developer" : "system";
	const messages = buildResponsesInput({
		model,
		context,
		strictResponsesPairing: true,
		supportsImageDetailOriginal: model.compat.supportsImageDetailOriginal,
		systemRole,
		nativeHistory: { replay: true, filterReasoning: false },
		includeThinkingSignatures: true,
		developerStringContent: true,
		preserveAssistantMessageIds: true,
	});

	const params: AzureOpenAIResponsesSamplingParams = {
		model: deploymentName,
		input: messages,
		stream: true,
		prompt_cache_key: getOpenAIPromptCacheKey(options),
		// Encrypted reasoning replay (applyResponsesReasoningParams) requires
		// stateless responses, matching the openai provider.
		store: false,
	};

	applyCommonResponsesSamplingParams(params, options, model);
	if (options?.include?.length) params.include = Array.from(new Set(options.include));

	if (context.tools) {
		const serializedTools: NonNullable<AzureOpenAIResponsesSamplingParams["tools"]> = [];
		for (const tool of context.tools) {
			if (tool.native?.type === "computer") {
				if (model.supportsComputerUse === true) {
					serializedTools.push({ type: "computer" });
					continue;
				}
				// Fall through: unsupported models get the computer tool as a
				// plain function tool so function-calling models can drive it.
			} else if (tool.native !== undefined) continue;
			serializedTools.push({
				type: "function",
				name: tool.name,
				description: tool.description || "",
				parameters: sanitizeSchemaForOpenAIResponses(toolWireSchema(tool)),
				strict: false,
			});
		}
		if (serializedTools.length > 0) {
			params.tools = serializedTools;
			if (options?.toolChoice) {
				let toolChoice = mapToOpenAIResponsesToolChoice(options.toolChoice);
				const hasComputerTool = serializedTools.some(tool => tool.type === "computer");
				if (toolChoice && typeof toolChoice !== "string" && toolChoice.type === "computer" && !hasComputerTool) {
					const computer = context.tools.find(tool => tool.native?.type === "computer");
					if (computer && serializedTools.some(tool => tool.type === "function" && tool.name === computer.name)) {
						toolChoice = { type: "function", name: computer.name };
					}
				}
				if (toolChoice && typeof toolChoice !== "string" && toolChoice.type === "function" && hasComputerTool) {
					const computer = context.tools.find(tool => tool.native?.type === "computer");
					if (computer?.name === toolChoice.name) {
						toolChoice = { type: "computer" };
					}
				}
				if (
					toolChoice &&
					(typeof toolChoice === "string" ||
						(toolChoice.type === "computer" && hasComputerTool) ||
						(toolChoice.type === "function" &&
							serializedTools.some(tool => tool.type === "function" && tool.name === toolChoice.name)))
				) {
					params.tool_choice = toolChoice;
				}
			}
		}
	}

	applyResponsesReasoningParams(params, model, options);

	return params;
}
