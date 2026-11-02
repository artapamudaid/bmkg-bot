import axios from 'axios';

const NOWCAST_ALERTS_URL = 'https://www.bmkg.go.id/alerts/nowcast/id';
const LATEST_FELT_EARTHQUAKE_URL =
  'https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json';

type JsonRecord = Record<string, unknown>;

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
