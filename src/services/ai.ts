import { GoogleGenAI } from '@google/genai';
import { config } from '../config.ts';

const SYSTEM_INSTRUCTIONS = `Anda asisten cuaca lokal Indonesia. Jawab ramah, langsung, dan ringkas dalam bahasa Indonesia.
Untuk pertanyaan cuaca, gunakan data BMKG dan lokasi yang diberikan; jangan mengarang data atau menyamakan alert dengan prakiraan.
Sebutkan kondisi serta angka/waktu yang relevan dan sumber BMKG. Bila prakiraan berupa agregasi kecamatan, cukup tampilkan sebagai ringkasan wilayah.
Jawab singkat dan langsung pada inti; tampilkan hanya informasi yang berguna. Hindari penjelasan bertele-tele, salam pembuka/penutup, pengulangan nama wilayah, dan catatan umum.
Sebutkan keterbatasan hanya jika data yang diperlukan memang tidak tersedia atau ada risiko salah paham yang penting.`;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const buildUserPrompt = (
  userQuestion: string,
  userLocation: string,
  bmkgContext: string,
): string => `Lokasi aktif pengguna: ${userLocation}

Konteks data BMKG untuk wilayah pengguna:
${bmkgContext.trim() || 'Data BMKG tidak tersedia.'}

Pertanyaan pengguna:
${userQuestion}`;

async function askGemini(prompt: string): Promise<string> {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY tidak tersedia untuk provider Gemini.');
  }

  const gemini = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const response = await gemini.models.generateContent({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: SYSTEM_INSTRUCTIONS,
    },
    contents: prompt,
  });

  if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    throw new Error('Jawaban AI terpotong karena mencapai batas token keluaran.');
  }

  const answer = response.text?.trim();
  if (!answer) {
    throw new Error('Gemini mengembalikan jawaban kosong.');
  }
  return answer;
}

async function askOpenAICompatible(prompt: string): Promise<string> {
  const { openAICompatibleBaseUrl, openAICompatibleApiKey, openAICompatibleModel } = config;
  if (!openAICompatibleBaseUrl || !openAICompatibleApiKey || !openAICompatibleModel) {
    throw new Error('Konfigurasi provider OpenAI-compatible belum lengkap.');
  }

  const response = await fetch(
    `${openAICompatibleBaseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAICompatibleApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: openAICompatibleModel,
        messages: [
          { role: 'system', content: SYSTEM_INSTRUCTIONS },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  const responseBody = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(responseBody);
  } catch {
    if (!response.ok) {
      throw new Error(
        `Provider OpenAI-compatible mengembalikan HTTP ${response.status}: ${responseBody.slice(0, 500)}`,
      );
    }
    throw new Error('Respons provider OpenAI-compatible bukan JSON yang valid.');
  }

  if (!response.ok) {
    const errorMessage =
      isRecord(payload) && isRecord(payload['error']) && typeof payload['error']['message'] === 'string'
        ? payload['error']['message']
        : responseBody.slice(0, 500);
    throw new Error(
      `Provider OpenAI-compatible mengembalikan HTTP ${response.status}: ${errorMessage}`,
    );
  }

  if (!isRecord(payload) || !Array.isArray(payload['choices'])) {
    throw new Error('Format respons provider OpenAI-compatible tidak dikenali.');
  }

  const firstChoice = payload['choices'][0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice['message'])) {
    throw new Error('Respons provider OpenAI-compatible tidak berisi pesan jawaban.');
  }
  if (firstChoice['finish_reason'] === 'length') {
    throw new Error('Jawaban AI terpotong karena mencapai batas token keluaran.');
  }

  const answer = firstChoice['message']['content'];
  if (typeof answer !== 'string' || !answer.trim()) {
    throw new Error('Provider OpenAI-compatible mengembalikan jawaban kosong atau format yang tidak didukung.');
  }
  return answer.trim();
}

export async function askGeminiDynamic(
  userQuestion: string,
  userLocation: string,
  bmkgContext: string,
): Promise<string> {
  const question = userQuestion.trim();
  const location = userLocation.trim();

  if (!question) {
    throw new RangeError('userQuestion tidak boleh kosong.');
  }
  if (!location) {
    throw new RangeError('userLocation tidak boleh kosong.');
  }

  const prompt = buildUserPrompt(question, location, bmkgContext);
  return config.aiProvider === 'gemini'
    ? askGemini(prompt)
    : askOpenAICompatible(prompt);
}
