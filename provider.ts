// Where the assistant's model comes from.
//
// durable never calls a provider itself; it calls through pi-ai's `Models`
// collection, which the application builds. So this file's whole job is to put
// a provider into that collection.
//
// The provider is declared here rather than taken from pi-ai's generated
// catalog, because a source checkout of pi-ai may not have hydrated its model
// data (packages/ai/src/providers/data is gitignored). The two model records
// below are the demo's own; the prices only feed the usage readout.
//
// The key is read from pi's auth.json and handed to pi-ai. It is never printed.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

type DeepSeekModel = Model<"openai-completions">;

const BASE_URL = "https://api.deepseek.com";

/** Approximate rates in dollars per million tokens; the usage readout estimates with them. */
const RATES = { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 } as const;

const DEEPSEEK_MODELS: readonly DeepSeekModel[] = [
	{
		id: "deepseek-chat",
		name: "DeepSeek Chat",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: BASE_URL,
		input: ["text"],
		cost: RATES,
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
	{
		id: "deepseek-reasoner",
		name: "DeepSeek Reasoner",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: BASE_URL,
		input: ["text"],
		cost: RATES,
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
];

export interface AssistantModels {
	readonly models: MutableModels;
	readonly provider: string;
	readonly modelId: string;
	/** Where the credential came from, for the banner. Never the key itself. */
	readonly source: string;
	/** The faux handle when the demo fell back to it, so the caller can keep it fed. */
	readonly faux: ReturnType<typeof fauxProvider> | undefined;
}

/** pi's own credential file. This demo reads it and never writes it. */
function authFilePath(): string {
	if (process.env.PI_AUTH_FILE !== undefined) return process.env.PI_AUTH_FILE;
	return join(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
}

function storedDeepSeekKey(): string | undefined {
	const path = authFilePath();
	if (!existsSync(path)) return undefined;
	try {
		const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, { key?: unknown } | undefined>;
		const key = file.deepseek?.key;
		return typeof key === "string" && key.length > 0 ? key : undefined;
	} catch {
		return undefined;
	}
}

/** DeepSeek over the OpenAI-completions API, with a key from the environment. */
function deepseekProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: BASE_URL,
		auth: {
			// Resolution runs per request. Reading the env var here is what keeps the
			// key out of the code and out of the transcript.
			apiKey: {
				name: "DeepSeek API key",
				async resolve({ ctx }) {
					const key = await ctx.env("DEEPSEEK_API_KEY");
					return key === undefined ? undefined : { auth: { apiKey: key } };
				},
			},
		},
		models: DEEPSEEK_MODELS,
		api: openAICompletionsApi(),
	});
}

export function createAssistantModels(options: { readonly modelId?: string } = {}): AssistantModels {
	// Take the stored key down the same path an environment variable would.
	if (process.env.DEEPSEEK_API_KEY === undefined) {
		const stored = storedDeepSeekKey();
		if (stored !== undefined) process.env.DEEPSEEK_API_KEY = stored;
	}

	const models = createModels();
	if (process.env.DEEPSEEK_API_KEY !== undefined) {
		models.setProvider(deepseekProvider());
		const modelId = options.modelId ?? DEEPSEEK_MODELS[0]!.id;
		if (!DEEPSEEK_MODELS.some((model) => model.id === modelId)) {
			throw new Error(`unknown model ${modelId}; available: ${DEEPSEEK_MODELS.map((m) => m.id).join(", ")}`);
		}
		return { models, provider: "deepseek", modelId, source: "auth.json / DEEPSEEK_API_KEY", faux: undefined };
	}

	// No key: a scripted model, so the CLI, the tools, and the recovery path all
	// still run end to end, just without a real answer.
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("(没有找到 DeepSeek 密钥,这是 faux 提供方的固定回答。)")]);
	return { models, provider: "faux", modelId: "faux-1", source: "faux:没有找到 DeepSeek 密钥", faux };
}
