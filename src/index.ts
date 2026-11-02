import Elysia from 'elysia';
import TelegramBot from 'node-telegram-bot-api';
import { config as CONFIG } from './config.ts';
import { initNotifierCron } from './cron/notifier.ts';
import { dbManager } from './db.ts';
import { askGeminiDynamic } from './services/ai.ts';
import {
  fetchGempaTerkini,
  fetchPrakiraanCuacaKecamatan,
  fetchPrakiraanCuacaHariIni,
  fetchWilayahAlerts,
} from './services/bmkg.ts';
import {
  type GeocodedDistrict,
  resolveDistrictQuery,
  resolveAdm4Code,
  reverseGeocodeDetailed,
} from './services/geocoding.ts';

const bot = new TelegramBot(CONFIG.telegramBotToken, { polling: true });

const replyKeyboard: TelegramBot.ReplyKeyboardMarkup = {
  keyboard: [
    [{ text: '📍 Bagikan Lokasi Saya', request_location: true }],
    [{ text: '🌋 Info Gempa Terkini' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const telegramCommands: TelegramBot.BotCommand[] = [
  { command: 'start', description: 'Mulai bot dan tampilkan menu' },
  { command: 'help', description: 'Lihat bantuan dan daftar perintah' },
  { command: 'cuaca', description: 'Prakiraan cuaca hari ini di lokasi aktif' },
  { command: 'gempa', description: 'Info gempa terkini yang dirasakan' },
  { command: 'alert', description: 'Cek alert BMKG di lokasi aktif' },
  { command: 'lokasi', description: 'Lihat lokasi aktif dan cara memperbaruinya' },
];

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

const getRequestErrorMessage = (error: unknown): string => {
  const details = error instanceof Error ? error.message : String(error);
  if (/terpotong karena mencapai batas token keluaran/i.test(details)) {
    return 'Jawaban cuaca belum lengkap karena batas keluaran AI tercapai. Coba tanyakan lagi dengan pertanyaan yang lebih spesifik.';
  }
  if (/429|quota|rate.?limit|resource_exhausted/i.test(details)) {
    return 'Layanan AI sedang mencapai batas penggunaan. Coba lagi nanti atau periksa kuota provider AI.';
  }
  if (/401|403|api.?key|unauthorized|permission denied/i.test(details)) {
    return 'Akses API AI bermasalah. Periksa API key dan konfigurasi provider di server.';
  }
  return 'Maaf, permintaan belum dapat diproses. Silakan coba lagi beberapa saat.';
};

const withTypingIndicator = async <T>(
  chatId: TelegramBot.ChatId,
  operation: () => Promise<T>,
): Promise<T> => {
  const sendTypingAction = (): void => {
    void bot.sendChatAction(chatId, 'typing').catch((error: unknown) => {
      console.warn('Gagal mengirim indikator sedang mengetik:', error);
    });
  };

  sendTypingAction();
  const typingInterval = setInterval(sendTypingAction, 4_000);
  typingInterval.unref?.();

  try {
    return await operation();
  } finally {
    clearInterval(typingInterval);
  }
};

const sendHelp = async (chatId: number): Promise<void> => {
  await bot.sendMessage(
    chatId,
    [
      'Perintah yang tersedia:',
      '/cuaca — prakiraan BMKG hari ini di lokasi aktif.',
      '/cuaca <kecamatan, kabupaten> — prakiraan kecamatan yang disebut.',
      '/gempa — informasi gempa terkini yang dirasakan.',
      '/alert — cek peringatan dini BMKG untuk lokasi aktif.',
      '/lokasi — lihat lokasi aktif; bagikan GPS untuk memperbaruinya.',
      '/help — tampilkan bantuan ini.',
      '',
      'Kirim pertanyaan cuaca sebagai pesan biasa untuk bertanya kepada asisten AI.',
      'Catatan: tidak adanya alert bukan berarti cuaca pasti cerah atau bebas hujan.',
    ].join('\n'),
    { reply_markup: replyKeyboard },
  );
};

const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]!;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const oldValue = previous[rightIndex]!;
      previous[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = oldValue;
    }
  }
  return previous[right.length]!;
};

const correctWeatherKeywords = (text: string): string => {
  const keywords = ['cuaca', 'prakiraan', 'daerah', 'wilayah', 'kecamatan'];
  return text.replace(/\b[\p{L}]+\b/gu, (word) => {
    const normalizedWord = word.toLocaleLowerCase('id-ID');
    const correction = keywords.find(
      (keyword) =>
        Math.abs(keyword.length - normalizedWord.length) <= 1 &&
        editDistance(normalizedWord, keyword) === 1,
    );
    return correction ?? word;
  });
};

const extractRequestedDistrict = (text: string): string | undefined => {
  const correctedText = correctWeatherKeywords(text);
  const suffix = String.raw`(?=\s+(?:hari\s+ini|sekarang|besok|nanti|bagaimana|gimana|ya|dong|sih)\b|[?!]|$)`;
  const match =
    new RegExp(
      String.raw`\b(?:daerah|wilayah|kecamatan|kec\.?)\s+(.+?)${suffix}`,
      'i',
    ).exec(correctedText) ??
    new RegExp(
      String.raw`\b(?:cuaca|prakiraan)\s+(?:di|untuk)\s+(.+?)${suffix}`,
      'i',
    ).exec(correctedText);
  const location = match?.[1]?.replace(/[.,!?]+$/g, '').trim();
  if (location && !/^(saya|aku|sini|situ|ini|itu)$/i.test(location)) {
    return location;
  }

  const shortLocation = correctedText.trim();
  const words = shortLocation.split(/\s+/);
  const commonChatWords =
    /\b(?:apa|kabar|terima|kasih|makasih|halo|hai|tolong|bantu|kamu|saya|aku|anda|yang|dan|atau|ini|itu|bagaimana|gimana|berapa|apakah)\b/i;
  if (
    words.length >= 2 &&
    words.length <= 5 &&
    !/[?!]/.test(shortLocation) &&
    !commonChatWords.test(shortLocation)
  ) {
    return shortLocation;
  }
  return undefined;
};

const getDistrictWeatherContext = async (
  district: GeocodedDistrict,
): Promise<{ location: string; context: string }> => {
  const location = `Kecamatan ${district.district}, ${district.regency}`;
  const [forecast, alerts] = await Promise.all([
    fetchPrakiraanCuacaKecamatan(
      district.district,
      district.regency,
      district.villages,
    ),
    fetchWilayahAlerts(district.district),
  ]);
  const alertContext =
    alerts.length > 0
      ? `Alert BMKG untuk ${location}:\n${JSON.stringify(alerts, null, 2)}`
      : `Tidak ditemukan alert BMKG untuk ${location}. Tidak adanya alert bukan berarti tidak ada hujan.`;

  return { location, context: `${forecast}\n\n${alertContext}` };
};

const handleCommand = async (
  chatId: number,
  command: string,
  argument = '',
): Promise<boolean> => {
  switch (command.toLowerCase()) {
    case '/start':
    case '/help':
      await sendHelp(chatId);
      return true;
    case '/cuaca': {
      if (argument) {
        const district = await resolveDistrictQuery(argument);
        const { context } = await getDistrictWeatherContext(district);
        await bot.sendMessage(chatId, `${context}`);
        return true;
      }

      const { city, adm4Code } = dbManager.getUserLocationDetails(chatId);
      if (!adm4Code) {
        await bot.sendMessage(
          chatId,
          `Lokasi aktif Anda saat ini ${city}, tetapi kode desa/kelurahan belum tersedia. Bagikan lokasi GPS melalui tombol di bawah agar prakiraan BMKG dapat ditentukan lebih tepat.`,
          { reply_markup: replyKeyboard },
        );
        return true;
      }

      const forecast = await fetchPrakiraanCuacaHariIni(adm4Code);
      await bot.sendMessage(chatId, forecast);
      return true;
    }
    case '/gempa': {
      const earthquakeInfo = await fetchGempaTerkini();
      await bot.sendMessage(chatId, earthquakeInfo, { parse_mode: 'Markdown' });
      return true;
    }
    case '/alert': {
      const { city } = dbManager.getUserLocationDetails(chatId);
      const alerts = await fetchWilayahAlerts(city);
      if (alerts.length === 0) {
        await bot.sendMessage(
          chatId,
          `Tidak ditemukan alert BMKG untuk ${city} saat ini. Tidak adanya alert bukan berarti tidak ada hujan; gunakan /cuaca untuk melihat prakiraan.`,
        );
        return true;
      }

      const alertText = JSON.stringify(alerts, null, 2);
      await bot.sendMessage(
        chatId,
        `Alert BMKG untuk ${city}:\n\n${alertText.length > 3500 ? `${alertText.slice(0, 3497)}...` : alertText}`,
      );
      return true;
    }
    case '/lokasi': {
      const { city, adm4Code } = dbManager.getUserLocationDetails(chatId);
      await bot.sendMessage(
        chatId,
        adm4Code
          ? `Lokasi aktif: ${city}.\nKode wilayah prakiraan BMKG: ${adm4Code}.\nBagikan GPS untuk memperbarui lokasi.`
          : `Lokasi default: ${city}.\nBagikan GPS agar bot dapat menentukan desa/kelurahan dan mengambil prakiraan yang lebih akurat.`,
        { reply_markup: replyKeyboard },
      );
      return true;
    }
    default:
      return false;
  }
};

const handleMessage = async (message: TelegramBot.Message): Promise<void> => {
  const chatId = message.chat.id;

  try {
    if (message.location) {
      await withTypingIndicator(chatId, async () => {
        const { latitude, longitude } = message.location!;
        const location = await reverseGeocodeDetailed(latitude, longitude);
        const adm4Code = await resolveAdm4Code(location);
        dbManager.setUserLocation(chatId, location.city, adm4Code);
        await bot.sendMessage(
          chatId,
          `Lokasi aktif berhasil diperbarui: ${location.village}, ${location.district}, ${location.city}.`,
        );
      });
      return;
    }

    const text = message.text?.trim();
    if (!text) return;

    if (text.startsWith('/')) {
      const [rawCommand, ...argumentParts] = text.split(/\s+/);
      const command = rawCommand!.split('@', 1)[0]!;
      const argument = argumentParts.join(' ').trim();
      const needsTyping = ['/cuaca', '/gempa', '/alert'].includes(command.toLowerCase());
      const handled = needsTyping
        ? await withTypingIndicator(chatId, () => handleCommand(chatId, command, argument))
        : await handleCommand(chatId, command, argument);
      if (!handled) {
        await bot.sendMessage(chatId, 'Perintah tidak dikenal. Gunakan /help untuk melihat daftar perintah.');
      }
      return;
    }

    const normalizedText = text.replace(/^🌋\s*/, '').trim().toLocaleLowerCase('id-ID');
    if (normalizedText === 'info gempa terkini') {
      await withTypingIndicator(chatId, async () => {
        const earthquakeInfo = await fetchGempaTerkini();
        await bot.sendMessage(chatId, earthquakeInfo, { parse_mode: 'Markdown' });
      });
      return;
    }

    await withTypingIndicator(chatId, async () => {
      const requestedDistrict = extractRequestedDistrict(text);
      if (requestedDistrict) {
        let district: GeocodedDistrict;
        try {
          district = await resolveDistrictQuery(requestedDistrict);
        } catch (error) {
          console.error(
            `Gagal mencari prakiraan untuk wilayah yang diminta (${requestedDistrict}):`,
            error,
          );
          await bot.sendMessage(
            chatId,
            `Maaf, saya belum dapat menemukan data BMKG untuk "${requestedDistrict}". Coba sebutkan kecamatan dan kabupaten, misalnya: "cuaca daerah Ngadiluwih kab. Kediri".`,
          );
          return;
        }

        const { location, context } = await getDistrictWeatherContext(district);
        const answer = await askGeminiDynamic(text, location, context);
        await bot.sendMessage(chatId, answer);
        return;
      }

      const { city: userLocation, adm4Code } =
        dbManager.getUserLocationDetails(chatId);
      const alerts = await fetchWilayahAlerts(userLocation);
      const forecastContext = adm4Code
        ? await fetchPrakiraanCuacaHariIni(adm4Code)
        : `Prakiraan harian belum tersedia untuk lokasi ${userLocation}; minta pengguna membagikan lokasi GPS agar wilayah dapat dipetakan dengan tepat.`;
      const alertContext =
        alerts.length > 0
          ? `Alert BMKG untuk ${userLocation}:\n${JSON.stringify(alerts, null, 2)}`
          : `Tidak ditemukan alert BMKG untuk wilayah ${userLocation}. Tidak adanya alert bukan berarti tidak ada hujan.`;
      const bmkgContext = `${forecastContext}\n\n${alertContext}`;
      const answer = await askGeminiDynamic(text, userLocation, bmkgContext);
      await bot.sendMessage(chatId, answer);
    });
  } catch (error) {
    await sendErrorReply(
      chatId,
      getRequestErrorMessage(error),
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

const registerTelegramCommands = async (): Promise<void> => {
  try {
    await bot.setMyCommands(telegramCommands);
    console.info('Menu command Telegram default berhasil diperbarui.');
  } catch (error) {
    console.error('Gagal memperbarui menu command Telegram default:', error);
  }

  try {
    await bot.setMyCommands(telegramCommands, { language_code: 'id' });
    console.info('Menu command Telegram bahasa Indonesia berhasil diperbarui.');
  } catch (error) {
    console.error('Gagal memperbarui menu command Telegram bahasa Indonesia:', error);
  }
};

void registerTelegramCommands();

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
