// lib/tts-service.ts — 语音合成服务

import type { VoiceApiConfig, ContentAppId } from "./settings-types";
import { loadVoiceConfigs, loadBindingConfig, resolveBinding, loadApiConfigs, loadPresets } from "./settings-storage";
import { loadCharacters } from "./character-storage";
import { buildProviderRequest, parseProviderResponse } from "./llm-provider-adapter";
import { fetchLlmPayload } from "./llm-http";

export type VoiceApiConfigResolved = VoiceApiConfig;

/**
 * Resolve the TTS voice config for a character via the binding cascade.
 * Returns null if no voice config is bound or found.
 */
export function resolveVoiceConfig(characterId: string, appId?: ContentAppId): VoiceApiConfig | null {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, appId ?? "chat");
    if (!slot.voiceConfigId) return null;

    const configs = loadVoiceConfigs();
    return configs.find(c => c.id === slot.voiceConfigId) || null;
}

/**
 * Synthesize speech from text using the given voice config.
 * Returns an audio Blob (mp3/wav) or null if synthesis failed.
 *
 * Supported providers:
 * - Minimax: REST API → hex-encoded mp3
 * - OpenAI: REST API → binary audio blob
 * - ElevenLabs: same-origin API route → binary audio blob (avoids browser CORS)
 */
export type VoiceContextMessage = { role: "user" | "assistant"; content: string };

// Temporary diagnostics for Voice Director. Logs metadata only; never logs
// chat text, character profile, API keys, or generated speech content.
const VOICE_DIRECTOR_DEBUG = true;
const voiceDirectorDiagnosticLines: string[] = [];
function voiceDirectorLog(event: string, details: Record<string, unknown> = {}): void {
    if (!VOICE_DIRECTOR_DEBUG) return;
    console.info("[Voice Director] " + event, details);
    const detailText = Object.entries(details)
        .filter(([key]) => key !== "error")
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", ");
    voiceDirectorDiagnosticLines.push(`${event}${detailText ? ` (${detailText})` : ""}`);
    if (voiceDirectorDiagnosticLines.length > 30) voiceDirectorDiagnosticLines.shift();
}

function showVoiceDirectorDiagnostic(): void {
    if (typeof window === "undefined" || !VOICE_DIRECTOR_DEBUG) return;
    const report = voiceDirectorDiagnosticLines.splice(0).join("\n");
    window.alert("Voice Director 诊断结果\n\n" + (report || "没有捕获到诊断记录"));
}

export async function synthesizeSpeech(
    text: string,
    voiceConfig: VoiceApiConfig,
    options?: { emotion?: string; characterId?: string; voiceContext?: VoiceContextMessage[] },
): Promise<Blob | null> {
    if (!text.trim()) return null;

    const provider = voiceConfig.provider;

    if (provider === "Minimax") {
        return synthesizeMinimax(text, voiceConfig, options?.emotion);
    }

    if (provider === "OpenAI") {
        return synthesizeOpenAI(text, voiceConfig);
    }

    if (provider === "ElevenLabs") {
        return synthesizeElevenLabs(text, voiceConfig, options);
    }

    return null;
}

/**
 * Add concise ElevenLabs v4 audio tags using the character's already-bound chat API.
 * This runs only when the user first requests audio for a message. Any failure
 * returns the original text so ordinary TTS remains available.
 */
async function directVoiceWithContext(
    originalText: string,
    characterId?: string,
    voiceContext: VoiceContextMessage[] = [],
): Promise<string> {
    voiceDirectorLog("分析函数已触发", { hasCharacterId: Boolean(characterId), contextCount: voiceContext.length });
    if (!characterId) { voiceDirectorLog("跳过分析：缺少 characterId"); return originalText; }
    if (voiceContext.length === 0) { voiceDirectorLog("跳过分析：voiceContext 为空"); return originalText; }

    try {
        const binding = resolveBinding(loadBindingConfig(), characterId, "chat");
        if (!binding.apiConfigId) { voiceDirectorLog("跳过分析：角色没有绑定聊天 API"); return originalText; }

        const apiConfig = loadApiConfigs().find(item => item.id === binding.apiConfigId);
        if (!apiConfig?.apiKey) { voiceDirectorLog("跳过分析：聊天 API 配置不存在或没有 API Key"); return originalText; }
        voiceDirectorLog("已找到角色聊天 API 配置", { provider: apiConfig.provider || "configured", presetBound: Boolean(binding.presetId) });

        const character = loadCharacters().find(item => item.id === characterId);
        const preset = loadPresets().find(item => item.id === binding.presetId) || null;
        const history = voiceContext.slice(-6).map(item => ({
            role: item.role,
            content: item.content.slice(0, 500),
        }));
        voiceDirectorLog("上下文已整理", { historyCount: history.length, characterProfileAvailable: Boolean(character?.persona || character?.personality) });

        const systemPrompt = [
            "You are a voice director for an existing fictional character's text message.",
            "Read the recent conversation, the character profile, and the exact line to be spoken.",
            "Return the exact original line with only a few concise ElevenLabs v4 audio tags inserted where genuinely useful.",
            "STRICT RULES:",
            "- Preserve every original spoken word exactly. Do not rewrite, translate, summarize, or add narration.",
            "- Audio tags must be short keywords only, preferably one word, such as [angry], [sad], [curious], [surprised], [whispers], [sighs], [laughs], [gulps], [hesitates], [sarcastic].",
            "- Never put a sentence or third-person description inside brackets.",
            "- Do not add a tag to every sentence. Neutral delivery should have no tag.",
            "- Use punctuation already present for pauses; do not add explanatory stage directions.",
            "- Output ONLY the speech-ready line. No quotes, JSON, markdown, or explanation.",
        ].join("\n");

        const userPrompt = [
            `CHARACTER NAME: ${character?.name || "Unknown"}`,
            `CHARACTER PROFILE: ${(character?.persona || character?.personality || "Not provided").slice(0, 2500)}`,
            `RECENT CONVERSATION:\n${history.map(m => `${m.role === "user" ? "User" : "Character"}: ${m.content}`).join("\n")}`,
            `EXACT LINE TO SPEAK:\n${originalText}`,
        ].join("\n\n");

        const requestPayload = buildProviderRequest(
            apiConfig,
            preset,
            [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            { maxTokens: 120 },
        );

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        let parsedContent = "";
        try {
            voiceDirectorLog("正在请求聊天模型进行语音分析");
            const response = await fetchLlmPayload(requestPayload, { signal: controller.signal });
            if (!response.ok) { voiceDirectorLog("分析失败：聊天模型 HTTP 错误", { status: response.status }); return originalText; }
            const parsed = parseProviderResponse(requestPayload.providerKind, await response.json());
            parsedContent = parsed.content;
            voiceDirectorLog("已收到分析结果", { responseLength: parsedContent.length, containsBracketTag: /\[[^\]]+\]/.test(parsedContent) });
        } finally {
            clearTimeout(timeout);
        }

        const parsed = { content: parsedContent };
        let candidate = parsed.content.trim().replace(/^["“]|["”]$/g, "").trim();
        if (!candidate || candidate.length > originalText.length + 120) { voiceDirectorLog("分析结果无效，退回原文", { candidateLength: candidate.length }); return originalText; }

        // Only accept compact, known tags. Descriptive bracketed prose is discarded.
        const allowedTags = new Set([
            "angry", "sad", "happy", "excited", "curious", "surprised", "whispers",
            "whispering", "shouts", "shouting", "sighs", "sigh", "laughs", "chuckles", "gulp",
            "gulps", "hesitates", "sarcastic", "nervous", "calm", "amused", "confused",
            "frustrated", "playful", "tired", "crying", "softly", "breathless", "mischievously", "clears throat", "pause", "long pause",
        ]);
        candidate = candidate.replace(/\[([^\]]+)\]/g, (whole, rawTag: string) => {
            const tag = rawTag.trim().toLowerCase();
            return allowedTags.has(tag) ? `[${tag}]` : "";
        });

        // Validate spoken characters while ignoring whitespace and punctuation.
        // Then insert accepted tags into the ORIGINAL text, so the model can
        // never rewrite the dialogue or alter its punctuation.
        const getSpeechCharacters = (value: string): string =>
            Array.from(value).filter(char => !/[\s\p{P}]/u.test(char)).join("");

        const candidatePlainText = candidate.replace(/\[[^\]]+\]/g, "");
        const candidateSpeech = getSpeechCharacters(candidatePlainText);
        const originalSpeech = getSpeechCharacters(originalText);

        if (candidateSpeech !== originalSpeech) {
            voiceDirectorLog("分析结果改变了台词内容，安全校验拒绝，退回原文");
            return originalText;
        }

        const tagMatches = Array.from(candidate.matchAll(/\[([^\]]+)\]/g));
        const tags = tagMatches.map(match => match[1]);
        if (tags.length === 0) {
            voiceDirectorLog("分析完成：没有需要添加的语音标签", { accepted: true, tagCount: 0 });
            return originalText;
        }

        // Map each tag's position in the model output onto the original text.
        // Keep the original wording and punctuation exactly as supplied.
        const originalChars = Array.from(originalText);
        const offsets: number[] = [];
        let utf16Offset = 0;
        for (const char of originalChars) {
            offsets.push(utf16Offset);
            utf16Offset += char.length;
        }
        const isSpeechChar = (char: string) => !/[\s\p{P}]/u.test(char);
        const insertionPoints: Array<{ offset: number; tag: string }> = [];

        for (const match of tagMatches) {
            const beforeTag = candidate.slice(0, match.index ?? 0).replace(/\[[^\]]+\]/g, "");
            const speechCount = Array.from(beforeTag).filter(isSpeechChar).length;
            let seenSpeech = 0;
            let charIndex = 0;
            while (charIndex < originalChars.length && seenSpeech < speechCount) {
                if (isSpeechChar(originalChars[charIndex])) seenSpeech++;
                charIndex++;
            }
            // Place the tag after punctuation/spacing that follows the preceding word.
            while (charIndex < originalChars.length && !isSpeechChar(originalChars[charIndex])) charIndex++;
            const offset = charIndex < originalChars.length ? offsets[charIndex] : originalText.length;
            insertionPoints.push({ offset, tag: match[1] });
        }

        let taggedOriginal = originalText;
        insertionPoints.sort((a, b) => b.offset - a.offset);
        for (const point of insertionPoints) {
            const left = taggedOriginal.slice(0, point.offset);
            const right = taggedOriginal.slice(point.offset);
            const prefix = left && !/\s$/.test(left) ? " " : "";
            const suffix = right && !/^\s/.test(right) ? " " : "";
            taggedOriginal = left + prefix + `[${point.tag}]` + suffix + right;
        }

        voiceDirectorLog("分析完成", { accepted: true, tagCount: tags.length, tags });
        return taggedOriginal;
    } catch (error) {
        voiceDirectorLog("分析异常，退回原文", { error: error instanceof Error ? error.message : String(error) });
        return originalText;
    }
}

// A stalled TTS request (TCP connected but no response — cold start, rate-limit
// hold, network blip) would otherwise hang forever, since fetch has no default
// timeout. That froze voice/video calls at "对方正在说话..." until the user
// toggled the mic. Abort after a ceiling so the caller can recover.
const TTS_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TTS_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error(`语音合成超时（超过 ${Math.round(timeoutMs / 1000)} 秒无响应）`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// ── Minimax TTS ─────────────────────────────────────

// MiniMax voice_setting.emotion 支持的取值（speech-01-turbo/hd、speech-02-turbo/hd 等）。
const MINIMAX_EMOTIONS = new Set([
    "happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "neutral", "fluent",
]);

const MINIMAX_SPEED_MIN = 0.5;
const MINIMAX_SPEED_MAX = 2.0;

function normalizeMinimaxSpeed(speed: number | undefined): number {
    if (typeof speed !== "number" || !Number.isFinite(speed)) return 1.0;
    return Math.min(MINIMAX_SPEED_MAX, Math.max(MINIMAX_SPEED_MIN, speed));
}

async function synthesizeMinimax(text: string, config: VoiceApiConfig, emotion?: string): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("Minimax API Key 未配置");

    const baseUrl = (config.baseUrl || "https://api.minimaxi.com/v1").replace(/\/$/, "");
    const voiceSetting: Record<string, unknown> = {
        voice_id: config.defaultVoice || "male-qn-qingse",
        speed: normalizeMinimaxSpeed(config.speechSpeed),
        vol: 1.0,
        pitch: 0,
    };
    const normalizedEmotion = emotion?.trim().toLowerCase();
    if (normalizedEmotion && MINIMAX_EMOTIONS.has(normalizedEmotion)) {
        voiceSetting.emotion = normalizedEmotion;
    }

    const response = await fetchWithTimeout(`${baseUrl}/t2a_v2`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: config.model || "speech-01-turbo",
            text,
            stream: false,
            ...(config.languageBoost ? { language_boost: config.languageBoost } : {}),
            voice_setting: voiceSetting,
            // 44100/256k 是 Minimax 支持的最高档;之前 32000/128k 会把 hd 模型
            // 的输出压闷(用户反馈"声音糊"),各模型均支持该档位。
            audio_setting: {
                sample_rate: 44100,
                bitrate: 256000,
                format: "mp3",
                channel: 1,
            },
        }),
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.base_resp?.status_msg || `Minimax API 请求失败 (${response.status})`);
    }

    const data = await response.json();
    if (data.data?.audio) {
        const hexString: string = data.data.audio;
        const bytes = new Uint8Array(hexString.length / 2);
        for (let i = 0; i < hexString.length; i += 2) {
            bytes[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
        }
        return new Blob([bytes], { type: "audio/mpeg" });
    }

    throw new Error(data.base_resp?.status_msg || "Minimax 未返回音频数据");
}

// ── OpenAI TTS ──────────────────────────────────────

async function synthesizeOpenAI(text: string, config: VoiceApiConfig): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("OpenAI API Key 未配置");

    const baseUrl = config.baseUrl || "https://api.openai.com/v1";
    const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: config.model || "tts-1",
            input: text,
            voice: config.defaultVoice || "alloy",
            response_format: "mp3",
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`OpenAI TTS 请求失败 (${response.status}): ${errText}`);
    }

    const blob = await response.blob();
    return new Blob([await blob.arrayBuffer()], { type: "audio/mpeg" });
}

// ── ElevenLabs TTS ───────────────────────────────────
// Call the app's own Next.js route rather than ElevenLabs directly. This avoids
// browser CORS restrictions and keeps the API key out of the upstream URL.
async function synthesizeElevenLabs( text: string, config: VoiceApiConfig, options?: { characterId?: string; voiceContext?: VoiceContextMessage[] }, ): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("ElevenLabs API Key 未配置");
    if (!config.defaultVoice?.trim()) throw new Error("ElevenLabs Voice ID 未配置");

    // Only v4 supports the concise Audio Tags flow used by this feature.
    const model = (config.model || "eleven_multilingual_v2").trim();
    const isVoiceDirectorModel = model.toLowerCase() === "eleven_v4";
    voiceDirectorLog("ElevenLabs 合成开始", { model, voiceDirectorEnabledByModel: isVoiceDirectorModel, contextCount: options?.voiceContext?.length || 0, hasCharacterId: Boolean(options?.characterId) });
    const ttsText = isVoiceDirectorModel
        ? await directVoiceWithContext(text, options?.characterId, options?.voiceContext || [])
        : text;
    voiceDirectorLog("准备发送 ElevenLabs", { model, voiceDirectorAddedTags: /\[[^\]]+\]/.test(ttsText), textLength: ttsText.length });

    const response = await fetchWithTimeout("/api/voice/elevenlabs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            apiKey: config.apiKey,
            baseUrl: config.baseUrl || "https://api.elevenlabs.io/v1",
            voiceId: config.defaultVoice.trim(),
            model,
            text: ttsText,
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        voiceDirectorLog("ElevenLabs 合成请求失败", { status: response.status });
        throw new Error(`ElevenLabs TTS 请求失败 (${response.status}): ${errText.slice(0, 500)}`);
    }

    const blob = await response.blob();
    voiceDirectorLog("ElevenLabs 合成成功", { audioBytes: blob.size, contentType: blob.type || "audio/mpeg" });
    // Phone-friendly temporary diagnostic: show the report without desktop DevTools.
    showVoiceDirectorDiagnostic();
    return new Blob([await blob.arrayBuffer()], { type: blob.type || "audio/mpeg" });
}

// ── iOS audio playback that coexists with speech recognition ──────────
// On iOS Safari, playing TTS through an <audio> element keeps the system audio
// session in "playback" mode, which steals the mic from webkitSpeechRecognition
// and stops it from restarting on the next turn (calls go silent after one
// round). To keep hands-free multi-turn working we play through a Web Audio
// AudioContext and explicitly suspend() it after each clip so iOS hands the
// audio session back to the microphone. A shared <audio> element is kept as a
// fallback for browsers without AudioContext.

let _audioCtx: AudioContext | null = null;
let _sharedAudio: HTMLAudioElement | null = null;
let _audioUnlocked = false;
let _unlockListenerInstalled = false;

// ── In-app TTS volume (0..1) ──
// iOS plays Web Audio on the ringer/voice stream, so the hardware volume keys
// don't control character speech. This in-app gain does. Synced to localStorage.
const TTS_VOLUME_KEY = "ai_phone_tts_volume_v1";
let _ttsVolume = ((): number => {
    if (typeof window === "undefined") return 1;
    try {
        const raw = window.localStorage.getItem(TTS_VOLUME_KEY);
        const v = raw == null ? 1 : Number(raw);
        return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    } catch { return 1; }
})();
// Live gain node of the currently-playing AudioContext clip, so the slider can
// adjust volume mid-sentence.
let _activeGain: GainNode | null = null;

export function getTtsVolume(): number {
    return _ttsVolume;
}

export function setTtsVolume(volume: number): void {
    _ttsVolume = Math.min(1, Math.max(0, volume));
    try { window.localStorage.setItem(TTS_VOLUME_KEY, String(_ttsVolume)); } catch { /* ignore */ }
    if (_activeGain) { try { _activeGain.gain.value = _ttsVolume; } catch { /* ignore */ } }
    if (_sharedAudio) { try { _sharedAudio.volume = _ttsVolume; } catch { /* ignore */ } }
}

function getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    if (!_audioCtx) {
        // 不要钉 sampleRate:部分 iOS 版本上非硬件采样率的 ctx 会"时钟照走、
        // 输出全静音"(比闷更糟)。防发闷靠 TTS 请求参数(44100/256k)兜底。
        try { _audioCtx = new Ctor(); } catch { return null; }
    }
    return _audioCtx;
}

function getSharedAudio(): HTMLAudioElement {
    if (!_sharedAudio) {
        _sharedAudio = new Audio();
        _sharedAudio.setAttribute("playsinline", "");
    }
    return _sharedAudio;
}

function silentWavUrl(): string {
    // A few ms of 8-bit mono PCM silence — a valid source so play() actually
    // starts (and thus unlocks the element) on iOS.
    const numSamples = 16;
    const buffer = new ArrayBuffer(44 + numSamples);
    const view = new DataView(buffer);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF"); view.setUint32(4, 36 + numSamples, true); writeStr(8, "WAVE");
    writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true);
    view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    writeStr(36, "data"); view.setUint32(40, numSamples, true);
    for (let i = 0; i < numSamples; i++) view.setUint8(44 + i, 128); // 8-bit silence = 128
    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

/**
 * Unlock audio playback. Must run inside (or synchronously from) a user gesture.
 * Resumes the AudioContext (primary path) and unlocks the <audio> fallback.
 * Safe to call repeatedly.
 */
export function unlockAudioPlayback(): void {
    if (typeof window === "undefined") return;

    // Primary path: resume the Web Audio context within the gesture. Once
    // resumed under a gesture, subsequent programmatic resume()s are allowed.
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});

    // Fallback path: unlock the shared <audio> element once.
    if (_audioUnlocked) return;
    const audio = getSharedAudio();
    const url = silentWavUrl();
    audio.muted = true;
    audio.src = url;
    const finish = () => {
        try { audio.pause(); audio.currentTime = 0; } catch {}
        audio.muted = false;
        URL.revokeObjectURL(url);
        _audioUnlocked = true;
    };
    try {
        const p = audio.play();
        if (p && typeof p.then === "function") {
            p.then(finish).catch(() => { audio.muted = false; URL.revokeObjectURL(url); });
        } else {
            finish();
        }
    } catch {
        audio.muted = false;
        URL.revokeObjectURL(url);
    }
}

function installUnlockListener(): void {
    if (_unlockListenerInstalled || typeof window === "undefined") return;
    _unlockListenerInstalled = true;
    const handler = () => { unlockAudioPlayback(); };
    window.addEventListener("touchend", handler, { passive: true });
    window.addEventListener("pointerdown", handler, { passive: true });
    window.addEventListener("mousedown", handler, { passive: true });
}

// Install the first-gesture unlock as soon as this module loads on the client.
// The call screens import this module statically (via chat-room), so the
// listener is in place well before the user taps the call button.
if (typeof window !== "undefined") installUnlockListener();

function decodeAudio(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
    // Support both the promise and legacy callback forms (older webkitAudioContext).
    return new Promise((resolve, reject) => {
        const ret = ctx.decodeAudioData(data, resolve, reject);
        if (ret && typeof (ret as Promise<AudioBuffer>).then === "function") {
            (ret as Promise<AudioBuffer>).then(resolve, reject);
        }
    });
}

/**
 * Playback via a shared <audio> element. Used as the fallback when AudioContext
 * is unavailable, and as the PRIMARY path for gesture-less auto-play scenarios
 * (e.g. VN/漫卷 auto voice): a media element that was unlocked once keeps playing
 * programmatically, whereas resuming a suspended AudioContext far from any user
 * gesture is often rejected on Android Chrome/Edge (the "only plays with WeChat
 * keep-alive on" bug — the keep-alive's looping silent <audio> was what kept the
 * context alive). Bonus: media-element playback also obeys hardware volume keys.
 */
export function playAudioBlobViaMediaElement(blob: Blob): { promise: Promise<void>; abort: () => void } {
    return playAudioBlobElement(blob);
}

function playAudioBlobElement(blob: Blob): { promise: Promise<void>; abort: () => void } {
    const url = URL.createObjectURL(blob);
    const audio = getSharedAudio();
    audio.muted = false;
    audio.volume = _ttsVolume;
    audio.src = url;

    let settled = false;
    let resolveFn: () => void = () => {};
    const finalize = () => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(url);
        try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch {}
        resolveFn();
    };
    const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
        audio.onended = finalize;
        audio.onerror = finalize;
        audio.play().catch(() => {
            finalize();
        });
    });
    return { promise, abort: finalize };
}

/**
 * Play an audio blob through the Web Audio context and resolve when playback
 * ends. After playback the context is suspended so iOS releases the audio
 * session back to the microphone (lets SpeechRecognition restart next turn).
 * Returns an abort function to stop playback early. Playback is sequential.
 */
export function playAudioBlob(blob: Blob): { promise: Promise<void>; abort: () => void } {
       return playAudioBlobElement(blob);
    const ctx = getAudioContext();
    if (!ctx) return playAudioBlobElement(blob);

    let settled = false;
    let resolveFn: () => void = () => {};
    let source: AudioBufferSourceNode | null = null;

    let gain: GainNode | null = null;
    let fallbackAbort: (() => void) | null = null;

    const cleanupWebAudio = () => {
        if (source) {
            source.onended = null;
            try { source.stop(); } catch {}
            try { source.disconnect(); } catch {}
            source = null;
        }
        if (gain) { try { gain.disconnect(); } catch {} }
        if (_activeGain === gain) _activeGain = null;
        gain = null;
        // Suspend so iOS hands the audio session back to the microphone.
        try { ctx.suspend(); } catch {}
    };

    const finalize = () => {
        if (settled) return;
        settled = true;
        cleanupWebAudio();
        if (fallbackAbort) { fallbackAbort(); fallbackAbort = null; }
        resolveFn();
    };

    const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
        (async () => {
            try {
                if (ctx.state === "suspended") {
                    // 程序化 resume 在部分安卓浏览器上会被拒绝，甚至让 promise 永远
                    // 悬着（要等下一次用户手势）。限时等待后检查状态，走不通就回落。
                    await Promise.race([
                        ctx.resume().catch(() => {}),
                        new Promise(r => setTimeout(r, 800)),
                    ]);
                }
                if (ctx.state !== "running") throw new Error("audio_context_not_running");
                const audioBuffer = await decodeAudio(ctx, await blob.arrayBuffer());
                if (settled) return;
                source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                // Route through a gain node so the in-app volume slider applies.
                gain = ctx.createGain();
                gain.gain.value = _ttsVolume;
                source.connect(gain);
                gain.connect(ctx.destination);
                _activeGain = gain;
                source.onended = finalize;
                source.start();
            } catch {
                // Web Audio 走不通（resume 被拒/解码失败等）时回落媒体元素播放：
                // 宁可这一段绕过「iOS 归还麦克风」的优化，也不要静默无声——
                // 此前这里直接 finalize，正是「语音条有声、通话没声」的来源之一。
                if (settled) return;
                cleanupWebAudio();
                const fallback = playAudioBlobElement(blob);
                fallbackAbort = fallback.abort;
                void fallback.promise.then(() => {
                    if (settled) return;
                    settled = true;
                    fallbackAbort = null;
                    resolveFn();
                });
            }
        })();
    });

    return { promise, abort: finalize };
}
