import cron, { type ScheduledTask } from 'node-cron';
import type TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.ts';
import { fetchWilayahAlerts } from '../services/bmkg.ts';

type AlertRecord = Record<string, unknown>;

const isAlertRecord = (value: unknown): value is AlertRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getAlertId = (alert: AlertRecord): string => {
  const idEntry = Object.entries(alert).find(([key, value]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
    return (
      ['id', 'alertid', 'eventid', 'kode'].includes(normalizedKey) &&
      (typeof value === 'string' || typeof value === 'number')
    );
  });

  return idEntry ? String(idEntry[1]) : JSON.stringify(alert);
};

const getAlertText = (alert: AlertRecord): string => {
  const preferredKeys = [
    'title',
    'judul',
    'description',
    'deskripsi',
    'message',
    'pesan',
    'severity',
    'level',
    'start',
    'end',
    'valid_from',
    'valid_to',
  ];
  const fields = preferredKeys.flatMap((key) => {
    const match = Object.entries(alert).find(
      ([field]) => field.toLowerCase() === key,
    );
    if (!match || typeof match[1] !== 'string' || !match[1].trim()) return [];
    return [`${key.replaceAll('_', ' ')}: ${match[1].trim()}`];
  });

  if (fields.length > 0) return fields.join('\n');

  const serializedAlert = JSON.stringify(alert, null, 2);
  return serializedAlert.length > 3500
    ? `${serializedAlert.slice(0, 3497)}...`
    : serializedAlert;
};

export function initNotifierCron(bot: TelegramBot): ScheduledTask {
  if (!config.telegramNotifChatId) {
    throw new Error('TELEGRAM_NOTIF_CHAT_ID harus diisi untuk mengaktifkan notifier.');
  }
  if (!cron.validate(config.cronSchedule)) {
    throw new Error(`CRON_SCHEDULE tidak valid: ${config.cronSchedule}`);
  }

  let lastAlertId: string | null = null;

  return cron.schedule(
    config.cronSchedule,
    async () => {
      try {
        const alerts = await fetchWilayahAlerts('Kediri');
        const latestAlert = alerts.find(isAlertRecord);
        if (!latestAlert) return;

        const alertId = getAlertId(latestAlert);
        if (alertId === lastAlertId) return;

        const message = `⚠️ Alert BMKG untuk Kediri\n\n${getAlertText(latestAlert)}`;
        await bot.sendMessage(config.telegramNotifChatId, message);
        lastAlertId = alertId;
        console.info(`BMKG alert baru untuk Kediri dikirim (ID: ${alertId}).`);
      } catch (error) {
        console.error('Gagal memeriksa atau mengirim alert BMKG:', error);
      }
    },
    {
      timezone: 'Asia/Jakarta',
      noOverlap: true,
    },
  );
}
