import Elysia from 'elysia';
import TelegramBot from 'node-telegram-bot-api';
import { config as CONFIG } from './config.ts';
import { initNotifierCron } from './cron/notifier.ts';
import { dbManager } from './db.ts';
import { askGeminiDynamic } from './services/ai.ts';
import { fetchGempaTerkini, fetchWilayahAlerts } from './services/bmkg.ts';
import { reverseGeocode } from './services/geocoding.ts';

const bot = new TelegramBot(CONFIG.telegramBotToken, { polling: true });

const replyKeyboard: TelegramBot.ReplyKeyboardMarkup = {
  keyboard: [
    [{ text: '📍 Bagikan Lokasi Saya', request_location: true }],
    [{ text: '🌋 Info Gempa Terkini' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const sendErrorReply = async (
  chatId: TelegramBot.ChatId,
  message: string,
  context: string,
): Promise<void> => {
  console.error(`${context}:`, message);
  try {
    await bot.sendMessage(chatId, message);
  } catch (error) {
    console.error(`Gagal mengirim pesan error (${context}):`, error);
  }
};

const handleMessage = async (message: TelegramBot.Message): Promise<void> => {
  const chatId = message.chat.id;

  try {
    if (message.location) {
      const { latitude, longitude } = message.location;
      const city = await reverseGeocode(latitude, longitude);
      dbManager.setUserLocation(chatId, city);
      await bot.sendMessage(chatId, `Lokasi aktif berhasil diperbarui: ${city}.`);
      return;
    }

    const text = message.text?.trim();
    if (!text) return;

    if (/^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(text)) {
      await bot.sendMessage(
        chatId,
        'Halo! Saya asisten cuaca lokal BMKG. Bagikan lokasi untuk mendapatkan informasi yang lebih relevan, atau pilih layanan di bawah.',
        { reply_markup: replyKeyboard },
      );
      return;
    }

    if (text.startsWith('/')) return;

    const normalizedText = text.replace(/^🌋\s*/, '').trim().toLocaleLowerCase('id-ID');
    if (normalizedText === 'info gempa terkini') {
      const earthquakeInfo = await fetchGempaTerkini();
      await bot.sendMessage(chatId, earthquakeInfo, { parse_mode: 'Markdown' });
      return;
    }

    const userLocation = dbManager.getUserLocation(chatId);
    const alerts = await fetchWilayahAlerts(userLocation);
    const bmkgContext =
      alerts.length > 0
        ? JSON.stringify(alerts, null, 2)
        : `Tidak ditemukan alert BMKG untuk wilayah ${userLocation}.`;
    const answer = await askGeminiDynamic(text, userLocation, bmkgContext);
    await bot.sendMessage(chatId, answer);
  } catch (error) {
    await sendErrorReply(
      chatId,
      'Maaf, permintaan belum dapat diproses. Silakan coba lagi beberapa saat.',
      `Telegram message handler: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

bot.on('message', (message) => {
  void handleMessage(message);
});

bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error);
});

initNotifierCron(bot);

const app = new Elysia()
  .get('/', () => ({
    name: 'bmkg-kediri-bot',
    status: 'running',
  }))
  .get('/health', () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))
  .listen(CONFIG.port);

console.info(`BMKG Kediri bot server is running on port ${app.server?.port}.`);
