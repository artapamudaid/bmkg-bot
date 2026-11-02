import axios from 'axios';

const NOWCAST_ALERTS_URL = 'https://www.bmkg.go.id/alerts/nowcast/id';
const FORECAST_URL = 'https://api.bmkg.go.id/publik/prakiraan-cuaca';
const LATEST_FELT_EARTHQUAKE_URL =
  'https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json';

type JsonRecord = Record<string, unknown>;

type ForecastCacheEntry = {
  expiresAt: number;
  value: string;
};

const forecastCache = new Map<string, ForecastCacheEntry>();
const districtForecastCache = new Map<string, ForecastCacheEntry>();

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const locationFieldNames = new Set([
  'area',
  'areaname',
  'city',
  'county',
  'district',
  'kabupaten',
  'kota',
  'location',
  'lokasi',
  'namawilayah',
  'namadaerah',
  'namaarea',
  'region',
  'wilayah',
]);

const normalize = (value: string): string => value.trim().toLocaleLowerCase('id-ID');

const matchesWilayah = (record: JsonRecord, normalizedWilayah: string): boolean =>
  Object.entries(record).some(([key, value]) => {
    const normalizedKey = key.toLocaleLowerCase('id-ID').replace(/[^a-z]/g, '');
    if (!locationFieldNames.has(normalizedKey) || typeof value !== 'string') {
      return false;
    }

    const normalizedValue = normalize(value);
    return (
      normalizedValue === normalizedWilayah ||
      normalizedValue.includes(normalizedWilayah) ||
      normalizedWilayah.includes(normalizedValue)
    );
  });

export async function fetchWilayahAlerts(
  wilayahName: string,
): Promise<JsonRecord[]> {
  const normalizedWilayah = normalize(wilayahName);
  if (!normalizedWilayah) {
    throw new RangeError('wilayahName tidak boleh kosong.');
  }

  const { data } = await axios.get<unknown>(NOWCAST_ALERTS_URL, {
    headers: { Accept: 'application/json' },
    timeout: 10_000,
  });

  const matches: JsonRecord[] = [];
  const visited = new Set<object>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value) || visited.has(value)) return;

    visited.add(value);
    if (matchesWilayah(value, normalizedWilayah)) {
      matches.push(value);
      return;
    }

    for (const child of Object.values(value)) visit(child);
  };

  visit(data);
  return matches;
}

const getText = (record: JsonRecord, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
};

const getTodayInTimezone = (timezone: string): string => {
  const fixedOffset = /^([+-])(\d{2}):?(\d{2})$/.exec(timezone);
  if (fixedOffset) {
    const sign = fixedOffset[1] === '+' ? 1 : -1;
    const offsetMinutes =
      sign * (Number(fixedOffset[2]) * 60 + Number(fixedOffset[3]));
    const localDate = new Date(Date.now() + offsetMinutes * 60_000);
    return [
      localDate.getUTCFullYear(),
      String(localDate.getUTCMonth() + 1).padStart(2, '0'),
      String(localDate.getUTCDate()).padStart(2, '0'),
    ].join('-');
  }

  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const parts = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
  return `${parts['year']}-${parts['month']}-${parts['day']}`;
};

const formatForecastEntry = (forecast: JsonRecord): string => {
  const dateTime = getText(forecast, 'local_datetime', 'utc_datetime');
  const time = dateTime?.match(/\s(\d{2}:\d{2}):\d{2}$/)?.[1] ?? 'waktu tidak diketahui';
  const details = [
    getText(forecast, 'weather_desc'),
    getText(forecast, 't') && `suhu ${getText(forecast, 't')}°C`,
    getText(forecast, 'tp') && `curah hujan ${getText(forecast, 'tp')} mm`,
    getText(forecast, 'hu') && `kelembapan ${getText(forecast, 'hu')}%`,
    getText(forecast, 'ws') && `angin ${getText(forecast, 'ws')} km/jam`,
    getText(forecast, 'wd') && `arah angin ${getText(forecast, 'wd')}`,
  ].filter((detail): detail is string => Boolean(detail));

  return `- ${time}: ${details.join('; ')}`;
};

const getNumericValue = (record: JsonRecord, key: string): number | undefined => {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
};

const formatRange = (values: number[], suffix: string): string | undefined => {
  if (values.length === 0) return undefined;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? `${min}${suffix}` : `${min}–${max}${suffix}`;
};

async function loadDistrictForecast(
  districtName: string,
  regencyName: string,
  villages: Array<{ code: string; name: string }>,
): Promise<string> {
  if (villages.length === 0) {
    throw new Error(`Data desa/kelurahan untuk Kecamatan ${districtName} tidak tersedia.`);
  }

  const villageForecasts: Array<{
    village: string;
    entries: JsonRecord[];
    timezone: string;
  }> = [];
  const batchSize = 5;

  for (let offset = 0; offset < villages.length; offset += batchSize) {
    const batch = villages.slice(offset, offset + batchSize);
    const responses = await Promise.all(
      batch.map(async (village) => {
        const { data } = await axios.get<unknown>(FORECAST_URL, {
          params: { adm4: village.code },
          headers: { Accept: 'application/json' },
          timeout: 10_000,
        });

        if (
          !isRecord(data) ||
          !isRecord(data['lokasi']) ||
          !Array.isArray(data['data'])
        ) {
          throw new Error(
            `Format prakiraan BMKG untuk desa ${village.name} tidak dikenali.`,
          );
        }

        const forecastRecords: JsonRecord[] = [];
        for (const dayData of data['data']) {
          if (!isRecord(dayData) || !Array.isArray(dayData['cuaca'])) continue;
          for (const forecastGroup of dayData['cuaca']) {
            if (!Array.isArray(forecastGroup)) continue;
            for (const forecast of forecastGroup) {
              if (isRecord(forecast)) forecastRecords.push(forecast);
            }
          }
        }
        return {
          village: village.name,
          entries: forecastRecords,
          timezone: getText(data['lokasi'], 'timezone') ?? 'Asia/Jakarta',
        };
      }),
    );
    villageForecasts.push(...responses);
  }

  const timezone = villageForecasts[0]?.timezone ?? 'Asia/Jakarta';
  const today = getTodayInTimezone(timezone);
  const entriesByTime = new Map<
    string,
    Array<{ village: string; forecast: JsonRecord }>
  >();

  for (const { village, entries } of villageForecasts) {
    for (const forecast of entries) {
      const localDateTime = getText(forecast, 'local_datetime');
      if (!localDateTime?.startsWith(today)) continue;
      const time = localDateTime.match(/\s(\d{2}:\d{2}):\d{2}$/)?.[1];
      if (!time) continue;
      const timeEntries = entriesByTime.get(time) ?? [];
      timeEntries.push({ village, forecast });
      entriesByTime.set(time, timeEntries);
    }
  }

  if (entriesByTime.size === 0) {
    throw new Error(
      `Data prakiraan BMKG untuk Kecamatan ${districtName} hari ini (${today}) belum tersedia.`,
    );
  }

  const lines = [...entriesByTime.entries()]
    .sort(([timeA], [timeB]) => timeA.localeCompare(timeB))
    .map(([time, entries]) => {
      const weatherCounts = new Map<string, number>();
      for (const { forecast } of entries) {
        const weather = getText(forecast, 'weather_desc');
        if (weather) weatherCounts.set(weather, (weatherCounts.get(weather) ?? 0) + 1);
      }
      const dominantWeather = [...weatherCounts.entries()].sort(
        ([, countA], [, countB]) => countB - countA,
      )[0];
      const temperatures = entries.flatMap(({ forecast }) => {
        const value = getNumericValue(forecast, 't');
        return value === undefined ? [] : [value];
      });
      const rain = entries.flatMap(({ forecast }) => {
        const value = getNumericValue(forecast, 'tp');
        return value === undefined ? [] : [value];
      });
      const humidity = entries.flatMap(({ forecast }) => {
        const value = getNumericValue(forecast, 'hu');
        return value === undefined ? [] : [value];
      });

      return [
        `- ${time}: ${dominantWeather?.[0] ?? 'kondisi tidak tersedia'}`,
        formatRange(temperatures, '°C') && `suhu ${formatRange(temperatures, '°C')}`,
        formatRange(rain, ' mm') && `curah hujan ${formatRange(rain, ' mm')}`,
        formatRange(humidity, '%') && `kelembapan ${formatRange(humidity, '%')}`,
      ]
        .filter((line): line is string => Boolean(line))
        .join('; ');
    });

  return [
    'Sumber: BMKG — agregasi prakiraan per 3 jam untuk desa/kelurahan di kecamatan ini.',
    `Wilayah: Kecamatan ${districtName}, ${regencyName}.`,
    `Tanggal prakiraan lokal: ${today} (${timezone}).`,
    `Cakupan: ${villageForecasts.length} desa/kelurahan.`,
    'Suhu, curah hujan, dan kelembapan ditampilkan sebagai rentang untuk wilayah kecamatan.',
    ...lines,
  ].join('\n');
}

export async function fetchPrakiraanCuacaKecamatan(
  districtName: string,
  regencyName: string,
  villages: Array<{ code: string; name: string }>,
): Promise<string> {
  const cacheKey = villages
    .map(({ code }) => code)
    .sort()
    .join(',');
  if (!cacheKey) {
    throw new RangeError('Daftar desa ADM4 untuk kecamatan tidak boleh kosong.');
  }

  const cached = districtForecastCache.get(cacheKey);
  const cachedDate = cached?.value.match(
    /Tanggal prakiraan lokal: (\d{4}-\d{2}-\d{2}) \(([^)]+)\)\./,
  );
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cachedDate &&
    getTodayInTimezone(cachedDate[2]!) === cachedDate[1]
  ) {
    return cached.value;
  }

  const value = await loadDistrictForecast(districtName, regencyName, villages);
  districtForecastCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + 10 * 60_000,
  });
  return value;
}

async function loadTodayForecast(adm4Code: string): Promise<string> {
  const { data } = await axios.get<unknown>(FORECAST_URL, {
    params: { adm4: adm4Code },
    headers: { Accept: 'application/json' },
    timeout: 10_000,
  });

  if (!isRecord(data) || !isRecord(data['lokasi']) || !Array.isArray(data['data'])) {
    throw new Error('Format respons prakiraan cuaca BMKG tidak dikenali.');
  }

  const location = data['lokasi'];
  const timezone = getText(location, 'timezone') ?? 'Asia/Jakarta';
  const today = getTodayInTimezone(timezone);
  const forecasts: JsonRecord[] = [];

  for (const dayData of data['data']) {
    if (!isRecord(dayData) || !Array.isArray(dayData['cuaca'])) continue;
    for (const forecastGroup of dayData['cuaca']) {
      if (!Array.isArray(forecastGroup)) continue;
      for (const forecast of forecastGroup) {
        if (
          isRecord(forecast) &&
          getText(forecast, 'local_datetime')?.startsWith(today)
        ) {
          forecasts.push(forecast);
        }
      }
    }
  }

  if (forecasts.length === 0) {
    throw new Error(`Data prakiraan BMKG untuk hari ini (${today}) belum tersedia.`);
  }

  const analysisDate = getText(forecasts[0]!, 'analysis_date');
  const locationName = [
    getText(location, 'desa'),
    getText(location, 'kecamatan'),
    getText(location, 'kotkab'),
  ]
    .filter((name): name is string => Boolean(name))
    .join(', ');

  return [
    'Sumber: BMKG — prakiraan cuaca tingkat desa/kelurahan.',
    `Wilayah: ${locationName || adm4Code}.`,
    `Tanggal prakiraan lokal: ${today} (${timezone}).`,
    analysisDate ? `Waktu produksi data: ${analysisDate} UTC.` : undefined,
    'Prakiraan per 3 jam:',
    ...forecasts.map(formatForecastEntry),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export async function fetchPrakiraanCuacaHariIni(
  adm4Code: string,
): Promise<string> {
  if (!/^\d{2}\.\d{2}\.\d{2}\.\d{4}$/.test(adm4Code)) {
    throw new RangeError('Kode wilayah BMKG harus berupa kode ADM4 yang valid.');
  }

  const cached = forecastCache.get(adm4Code);
  const cachedDate = cached?.value.match(
    /Tanggal prakiraan lokal: (\d{4}-\d{2}-\d{2}) \(([^)]+)\)\./,
  );
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cachedDate &&
    getTodayInTimezone(cachedDate[2]!) === cachedDate[1]
  ) {
    return cached.value;
  }

  const value = await loadTodayForecast(adm4Code);
  forecastCache.set(adm4Code, {
    value,
    expiresAt: Date.now() + 10 * 60_000,
  });
  return value;
}

const escapeMarkdown = (value: string): string =>
  value.replace(/([_*`\[\]])/g, '\\$1');

export async function fetchGempaTerkini(): Promise<string> {
  const { data } = await axios.get<unknown>(LATEST_FELT_EARTHQUAKE_URL, {
    headers: { Accept: 'application/json' },
    timeout: 10_000,
  });

  if (!isRecord(data) || !isRecord(data['Infogempa'])) {
    throw new Error('Format respons gempa BMKG tidak dikenali.');
  }

  const earthquakeData = data['Infogempa']['gempa'];
  const earthquake = Array.isArray(earthquakeData) ? earthquakeData[0] : earthquakeData;

  if (!isRecord(earthquake)) {
    throw new Error('Data gempa terkini tidak tersedia dalam respons BMKG.');
  }

  const coordinates =
    getText(earthquake, 'Coordinates') ??
    [getText(earthquake, 'Lintang'), getText(earthquake, 'Bujur')]
      .filter((value): value is string => Boolean(value))
      .join(', ');

  const fields: Array<[string, string | undefined]> = [
    ['Waktu', [getText(earthquake, 'Tanggal'), getText(earthquake, 'Jam')]
      .filter((value): value is string => Boolean(value))
      .join(' ') || undefined],
    ['Magnitudo', getText(earthquake, 'Magnitude')],
    ['Kedalaman', getText(earthquake, 'Kedalaman')],
    ['Wilayah', getText(earthquake, 'Wilayah')],
    ['Potensi', getText(earthquake, 'Potensi')],
    ['Koordinat', coordinates || undefined],
    ['Dirasakan', getText(earthquake, 'Dirasakan')],
  ];

  const lines = fields
    .filter((field): field is [string, string] => Boolean(field[1]))
    .map(([label, value]) => `*${label}:* ${escapeMarkdown(value)}`);

  if (lines.length === 0) {
    throw new Error('Data gempa terkini tidak memiliki informasi untuk ditampilkan.');
  }

  return ['*Info Gempa Dirasakan Terkini*', ...lines].join('\n');
}
