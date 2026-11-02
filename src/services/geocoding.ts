import axios from 'axios';

const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_USER_AGENT = 'bmkg-kediri-bot/1.0';
const WILAYAH_API_URL = 'https://wilayah.id/api';

type JsonRecord = Record<string, unknown>;

type AdministrativeArea = {
  code: string;
  name: string;
};

export type GeocodedLocation = {
  city: string;
  province: string;
  regency: string;
  district: string;
  districtCandidates: string[];
  village: string;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getAddressValue = (
  address: JsonRecord,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = address[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

const cleanAdministrativePrefix = (name: string): string =>
  name
    .replace(
      /^(?:(?:kabupaten|kab\.?|kecamatan|desa|kelurahan)\s+|kota(?:\s+(?:adm(?:inistrasi)?\.?|administrasi))?\s*)/i,
      '',
    )
    .trim();

const isGenericAdministrativeName = (name: string): boolean =>
  /^(?:kota|kabupaten|kab|administrasi|adm|city|regency|district)$/i.test(name.trim());

export async function reverseGeocodeDetailed(
  lat: number,
  lon: number,
): Promise<GeocodedLocation> {
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
      zoom: 18,
    },
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'id',
      'User-Agent': NOMINATIM_USER_AGENT,
    },
    timeout: 10_000,
  });

  if (!isRecord(data) || !isRecord(data['address'])) {
    throw new Error('Format respons geocoding Nominatim tidak dikenali.');
  }

  const address = data['address'];
  const rawRegency = getAddressValue(address, 'county', 'city', 'municipality');
  const districtCandidates = [
    'district',
    'city_district',
    'municipality',
    'town',
    'village',
  ]
    .map((key) => getAddressValue(address, key))
    .filter(
      (name): name is string =>
        typeof name === 'string' && !isGenericAdministrativeName(name),
    );
  const rawDistrict = districtCandidates[0];
  const rawVillage = getAddressValue(
    address,
    'village',
    'suburb',
    'neighbourhood',
    'hamlet',
  );
  const province = getAddressValue(address, 'state', 'province');

  if (!rawRegency || !rawDistrict || !rawVillage || !province) {
    throw new Error(
      'Lokasi GPS belum dapat dipetakan sampai desa/kelurahan. Coba bagikan titik lokasi yang lebih akurat.',
    );
  }

  return {
    city: cleanAdministrativePrefix(rawRegency),
    province,
    regency: rawRegency,
    district: rawDistrict,
    districtCandidates,
    village: rawVillage,
  };
}

export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  const location = await reverseGeocodeDetailed(lat, lon);
  return location.city;
}

const administrativeAreasCache = new Map<
  string,
  Promise<AdministrativeArea[]>
>();

const getAdministrativeAreas = (
  endpoint: string,
): Promise<AdministrativeArea[]> => {
  const cached = administrativeAreasCache.get(endpoint);
  if (cached) return cached;

  const request = axios
    .get<unknown>(`${WILAYAH_API_URL}/${endpoint}.json`, {
      headers: { Accept: 'application/json' },
      timeout: 10_000,
    })
    .then(({ data }) => {
      if (!isRecord(data) || !Array.isArray(data['data'])) {
        throw new Error(`Format data administrasi wilayah tidak dikenali (${endpoint}).`);
      }

      return data['data'].filter(
        (area): area is AdministrativeArea =>
          isRecord(area) &&
          typeof area['code'] === 'string' &&
          typeof area['name'] === 'string',
      );
    });

  administrativeAreasCache.set(endpoint, request);
  void request.catch(() => administrativeAreasCache.delete(endpoint));
  return request;
};

const normalizeAdministrativeName = (name: string): string =>
  name
    .normalize('NFKD')
    .toLocaleLowerCase('id-ID')
    .replace(
      /^(?:(?:kabupaten|kab|kecamatan|desa|kelurahan|regency|city|district)\s+|kota(?:\s+(?:adm(?:inistrasi)?|administrasi))?\s*)/i,
      '',
    )
    .replace(/[^a-z0-9]/g, '');

const findArea = (
  areas: AdministrativeArea[],
  name: string,
): AdministrativeArea | undefined => {
  const normalizedName = normalizeAdministrativeName(name);
  return areas.find(
    (area) => normalizeAdministrativeName(area.name) === normalizedName,
  );
};

export async function resolveAdm4Code(
  location: GeocodedLocation,
): Promise<string> {
  const provinces = await getAdministrativeAreas('provinces');
  const province = findArea(provinces, location.province);
  if (!province) {
    throw new Error(`Provinsi "${location.province}" tidak ditemukan dalam data kode wilayah.`);
  }

  const regencies = await getAdministrativeAreas(
    `regencies/${province.code}`,
  );
  const regency = findArea(regencies, location.regency);
  if (!regency) {
    throw new Error(`Kabupaten/kota "${location.regency}" tidak ditemukan dalam data kode wilayah.`);
  }

  const districts = await getAdministrativeAreas(
    `districts/${regency.code}`,
  );
  const district = location.districtCandidates
    .map((candidate) => findArea(districts, candidate))
    .find((area): area is AdministrativeArea => Boolean(area));
  if (!district) {
    throw new Error(
      `Nama kecamatan wilayah ini tidak ditemukan; nilai reverse geocoding: ${location.districtCandidates.join(', ') || 'tidak tersedia'}.`,
    );
  }

  const villages = await getAdministrativeAreas(`villages/${district.code}`);
  const village = findArea(villages, location.village);
  if (!village) {
    throw new Error(
      `Desa/kelurahan "${location.village}" tidak ditemukan di Kecamatan ${location.district}.`,
    );
  }

  return village.code;
}
