// ─────────────────────────────────────────────────────────────────────────────
// ElevenLabs Speech-to-Text + Audio Distress Classifier
// Uses ElevenLabs scribe_v2 model for transcription and audio event detection.
// Falls back gracefully when ELEVENLABS_API_KEY is not set.
// ─────────────────────────────────────────────────────────────────────────────

export function isElevenLabsConfigured(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}

export interface TranscribeResult {
  transcript: string;
  audioTags: string[]; // non-speech audio event labels returned by ElevenLabs
}

export interface AudioClassification {
  eventType: "audio_distress" | "possible_distress_sound" | "possible_fall_sound" | "normal";
  severity: "urgent" | "assist" | "watch" | "stable";
  confidence: number;
  reason: string;
  matchedKeywords: string[];
  matchedAudioTags: string[];
}

// Keywords that suggest a person is calling for help or in pain
const DISTRESS_KEYWORDS = [
  "help", "help me", "i'm falling", "i fell", "fallen", "ouch",
  "please help", "someone help", "pain", "hurts", "hurt", "call",
  "emergency", "can't get up", "fallen down", "i need help",
];

// Keywords specifically suggesting choking or breathing difficulty
const CHOKING_KEYWORDS = [
  "choking", "can't breathe", "cannot breathe", "cant breathe",
  "help me breathe", "gasping", "no air", "struggling to breathe",
  "airway", "throat", "swallowed",
];

// Audio event tags from ElevenLabs that suggest a fall sound
const FALL_SOUND_TAGS = ["thud", "bang", "crash", "impact", "fall"];

// Audio event tags from ElevenLabs that suggest vocal distress
const DISTRESS_SOUND_TAGS = ["crying", "screaming", "shouting", "yelling", "calling out", "wailing"];

// Audio event tags suggesting choking or respiratory distress
const CHOKING_SOUND_TAGS = ["coughing", "gasping", "choking", "wheezing", "heavy breathing", "cough"];

export async function transcribeAudioWithElevenLabs(
  audioBuffer: Buffer,
  contentType: string
): Promise<TranscribeResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const form = new FormData();
  // Copy Buffer bytes into a plain ArrayBuffer to satisfy TypeScript's Blob constructor types
  const plainArrayBuffer = new Uint8Array(audioBuffer).buffer;
  const blob = new Blob([plainArrayBuffer], { type: contentType });
  const extension = contentType.includes("wav") ? "wav"
    : contentType.includes("mp4") ? "mp4"
    : contentType.includes("mpeg") ? "mp3"
    : contentType.includes("ogg") ? "ogg" : "webm";
  form.append("file", blob, `audio.${extension}`);
  form.append("model_id", "scribe_v2");
  form.append("tag_audio_events", "true");
  form.append("timestamps_granularity", "word");

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`ElevenLabs STT request failed (HTTP ${res.status})`);
  }

  const data = await res.json();

  const transcript: string = data.text ?? "";
  // Scribe returns non-speech sounds alongside words, with type audio_event.
  const audioTags: string[] = [...new Set<string>(
    (data.words ?? [])
      .filter((word: { type: string; text?: string }) =>
        word.type === "audio_event" && typeof word.text === "string")
      .map((word: { text: string }) => word.text.toLowerCase().trim())
  )];

  return { transcript, audioTags };
}

export function classifyAudioTranscript(
  transcript: string,
  audioTags: string[]
): AudioClassification {
  const lower = transcript.toLowerCase();

  const matchedKeywords = DISTRESS_KEYWORDS.filter((kw) => lower.includes(kw));
  const matchedChokingKeywords = CHOKING_KEYWORDS.filter((kw) => lower.includes(kw));
  const matchedFallTags = audioTags.filter((t) => FALL_SOUND_TAGS.some((ft) => t.includes(ft)));
  const matchedDistressTags = audioTags.filter((t) =>
    DISTRESS_SOUND_TAGS.some((dt) => t.includes(dt))
  );
  const matchedChokingTags = audioTags.filter((t) =>
    CHOKING_SOUND_TAGS.some((ct) => t.includes(ct))
  );
  const matchedAudioTags = [...matchedFallTags, ...matchedDistressTags, ...matchedChokingTags];

  // Urgent: choking/breathing-difficulty keyword or choking sound + any distress indicator.
  // Choking as an eventType is VISUAL-ONLY; audio routes to audio_distress instead.
  if (
    matchedChokingKeywords.length >= 1 ||
    (matchedChokingTags.length >= 1 && (matchedKeywords.length >= 1 || matchedDistressTags.length >= 1))
  ) {
    return {
      eventType: "audio_distress",
      severity: "urgent",
      confidence: Math.min(0.65 + matchedChokingKeywords.length * 0.1, 0.92),
      reason: `Verbal or audio distress detected — possible breathing difficulty. Caregiver should check immediately.`,
      matchedKeywords: [...matchedChokingKeywords, ...matchedKeywords],
      matchedAudioTags,
    };
  }

  // Urgent: explicit verbal distress with strong keywords
  if (matchedKeywords.length >= 2 || (matchedKeywords.length >= 1 && matchedDistressTags.length >= 1)) {
    return {
      eventType: "audio_distress",
      severity: "urgent",
      confidence: Math.min(0.6 + matchedKeywords.length * 0.1, 0.95),
      reason: `Verbal distress detected — matched: "${matchedKeywords.join('", "')}"`,
      matchedKeywords,
      matchedAudioTags,
    };
  }

  // Assist: single distress keyword, choking sound tags, or distress sound tags.
  // Choking eventType is visual-only; respiratory audio events map to possible_distress_sound.
  if (matchedKeywords.length >= 1 || matchedDistressTags.length >= 1 || matchedChokingTags.length >= 1) {
    const isRespiratoryAudio = matchedChokingTags.length >= 1;
    return {
      eventType: "possible_distress_sound",
      severity: "assist",
      confidence: 0.65,
      reason: isRespiratoryAudio
        ? `Possible respiratory distress sound detected — audio event: "${matchedChokingTags.join('", "')}"`
        : `Possible distress — keyword or vocal audio event detected`,
      matchedKeywords,
      matchedAudioTags,
    };
  }

  // Watch: fall-like impact sounds only
  if (matchedFallTags.length >= 1) {
    return {
      eventType: "possible_fall_sound",
      severity: "watch",
      confidence: 0.55,
      reason: `Possible fall sound detected — audio event: "${matchedFallTags.join('", "')}"`,
      matchedKeywords,
      matchedAudioTags,
    };
  }

  return {
    eventType: "normal",
    severity: "stable",
    confidence: 0.9,
    reason: "No distress indicators detected in audio",
    matchedKeywords: [],
    matchedAudioTags: [],
  };
}
