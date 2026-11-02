import 'dotenv/config';

const failConfiguration = (message: string): never => {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
};

const requireEnvironmentValue = (value: string | undefined, name: string): string => {
  if (!value) {
    return failConfiguration(`${name} is required.`);
  }
  return value;
};

const telegramBotToken = requireEnvironmentValue(
  process.env.TELEGRAM_BOT_TOKEN?.trim(),
  'TELEGRAM_BOT_TOKEN',
);
const aiProviderValue = process.env.AI_PROVIDER?.trim().toLowerCase() || 'gemini';
const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
const openAICompatibleBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL?.trim();
const openAICompatibleApiKey = process.env.OPENAI_COMPATIBLE_API_KEY?.trim();
const openAICompatibleModel = process.env.OPENAI_COMPATIBLE_MODEL?.trim();

if (aiProviderValue !== 'gemini' && aiProviderValue !== 'openai-compatible') {
  failConfiguration('AI_PROVIDER must be either "gemini" or "openai-compatible".');
}

if (aiProviderValue === 'gemini' && !geminiApiKey) {
  failConfiguration('GEMINI_API_KEY is required when AI_PROVIDER=gemini.');
}

if (aiProviderValue === 'openai-compatible') {
  const missingOpenAIConfig = [
    !openAICompatibleBaseUrl && 'OPENAI_COMPATIBLE_BASE_URL',
    !openAICompatibleApiKey && 'OPENAI_COMPATIBLE_API_KEY',
    !openAICompatibleModel && 'OPENAI_COMPATIBLE_MODEL',
  ].filter(Boolean);

  if (missingOpenAIConfig.length > 0) {
    failConfiguration(
      `Missing OpenAI-compatible configuration: ${missingOpenAIConfig.join(', ')}`,
    );
  }

  try {
    const url = new URL(
      requireEnvironmentValue(openAICompatibleBaseUrl, 'OPENAI_COMPATIBLE_BASE_URL'),
    );
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      failConfiguration('OPENAI_COMPATIBLE_BASE_URL must use HTTP or HTTPS.');
    }
  } catch (error) {
    if (error instanceof TypeError) {
      failConfiguration('OPENAI_COMPATIBLE_BASE_URL must be a valid URL.');
    }
    throw error;
  }
}

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

export const config = {
  port,
  telegramBotToken,
  telegramNotifChatId: process.env.TELEGRAM_NOTIF_CHAT_ID?.trim() ?? '',
  aiProvider: aiProviderValue as 'gemini' | 'openai-compatible',
  geminiApiKey,
  openAICompatibleBaseUrl,
  openAICompatibleApiKey,
  openAICompatibleModel,
  cronSchedule: process.env.CRON_SCHEDULE?.trim() || '*/10 * * * *',
};
