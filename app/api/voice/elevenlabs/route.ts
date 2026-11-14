import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_BASE_URL = "https://api.elevenlabs.io/v1";
const MAX_TEXT_LENGTH = 5_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function getRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function normalizeBaseUrl(value: unknown): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_BASE_URL;
    const parsed = new URL(raw);
    const allowedHosts = new Set([
        "api.elevenlabs.io",
        "api.eu.elevenlabs.io",
        "api.us.elevenlabs.io",
    ]);
    if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
        throw new Error("Base URL 必须是 ElevenLabs 官方 HTTPS API 地址");
    }
    return raw.replace(/\/+$/, "");
}

async function readUpstreamError(response: Response): Promise<string> {
    const raw = await response.text().catch(() => "");
    try {
        const payload = getRecord(JSON.parse(raw));
        const detail = getRecord(payload.detail);
        return String(detail.message || payload.message || payload.error || raw || `HTTP ${response.status}`).slice(0, 800);
    } catch {
        return (raw || `HTTP ${response.status}`).slice(0, 800);
    }
}

export async function POST(request: Request) {
    try {
        const body = getRecord(await request.json().catch(() => ({})));
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const baseUrl = normalizeBaseUrl(body.baseUrl);
        if (!apiKey) return NextResponse.json({ error: "missing_api_key", message: "请填写 ElevenLabs API Key" }, { status: 400 });

        if (body.action === "voices") {
            const response = await proxyFetch(`${baseUrl}/voices`, {
                method: "GET",
                headers: { "xi-api-key": apiKey, Accept: "application/json" },
                cache: "no-store",
            });
            if (!response.ok) {
                return NextResponse.json({ error: "get_voices_failed", message: await readUpstreamError(response) }, { status: 502 });
            }
            const payload = getRecord(await response.json());
            const voices = Array.isArray(payload.voices) ? payload.voices.flatMap((item) => {
                const voice = getRecord(item);
                const id = typeof voice.voice_id === "string" ? voice.voice_id.trim() : "";
                if (!id) return [];
                return [{ id, name: typeof voice.name === "string" && voice.name.trim() ? voice.name.trim() : id }];
            }) : [];
            return NextResponse.json({ ok: true, voices }, { headers: { "Cache-Control": "no-store" } });
        }

        const text = typeof body.text === "string" ? body.text.trim() : "";
        const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim() : "";
        const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "eleven_multilingual_v2";
        if (!text) return NextResponse.json({ error: "missing_text", message: "朗读文本不能为空" }, { status: 400 });
        if (text.length > MAX_TEXT_LENGTH) return NextResponse.json({ error: "text_too_long", message: `单次朗读最多 ${MAX_TEXT_LENGTH} 个字符` }, { status: 400 });
        if (!/^[A-Za-z0-9_-]{4,128}$/.test(voiceId)) return NextResponse.json({ error: "invalid_voice_id", message: "Voice ID 格式不正确" }, { status: 400 });

        const response = await proxyFetch(`${baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_192`, {
            method: "POST",
            headers: {
                "xi-api-key": apiKey,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
            },
            body: JSON.stringify({
    text,
    model_id: model,
    voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
    },
}),
            cache: "no-store",
        });
        if (!response.ok) {
            return NextResponse.json({ error: "tts_failed", message: await readUpstreamError(response) }, { status: 502 });
        }
        const audio = await response.arrayBuffer();
        if (audio.byteLength > MAX_AUDIO_BYTES) {
            return NextResponse.json({ error: "audio_too_large", message: "返回的音频文件过大" }, { status: 502 });
        }
        return new Response(audio, {
            status: 200,
            headers: {
                "Content-Type": response.headers.get("content-type") || "audio/mpeg",
                "Content-Length": String(audio.byteLength),
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return NextResponse.json({ error: "elevenlabs_request_failed", message: message.slice(0, 800) }, { status: 502 });
    }
}
