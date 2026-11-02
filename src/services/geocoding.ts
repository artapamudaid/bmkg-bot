import axios from 'axios';

const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_USER_AGENT = 'bmkg-kediri-bot/1.0';

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cleanAdministrativePrefix = (name: string): string =>
  name.replace(/^(?:kabupaten|kab\.?|kota)\s+/i, '').trim();

export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError('lat harus berupa koordinat antara -90 dan 90.');
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError('lon harus berupa koordinat antara -180 dan 180.');
  }

  const { data } = await axios.get<unknown>(NOMINATIM_REVERSE_URL, {
    params: {
      lat,
      lon,
      format: 'jsonv2',
      addressdetails: 1,
      zoom: 10,
    },
    headers: {
      Accept: 'application/json',
      'User-Agent': NOMINATIM_USER_AGENT,
    },
    timeout: 10_000,
  });

  if (!isRecord(data) || !isRecord(data['address'])) {
    throw new Error('Format respons geocoding Nominatim tidak dikenali.');
  }

  const address = data['address'];
  const candidateKeys = [
    'city',
    'town',
    'municipality',
    'county',
    'state_district',
    'village',
  ];
  const placeName = candidateKeys
    .map((key) => address?.[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);

  if (!placeName) {
    throw new Error('Nominatim tidak menemukan nama kota atau kabupaten untuk koordinat tersebut.');
  }

  return cleanAdministrativePrefix(placeName);
}
