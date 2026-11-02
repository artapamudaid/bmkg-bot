import axios from 'axios';

const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
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

export type GeocodedDistrict = {
  district: string;
  regency: string;
  province: string;
  villages: AdministrativeArea[];
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
  const exactName = name.trim().toLocaleLowerCase('id-ID');
  const exactMatch = areas.find(
    (area) => area.name.trim().toLocaleLowerCase('id-ID') === exactName,
  );
  if (exactMatch) return exactMatch;

  const normalizedName = normalizeAdministrativeName(name);
  return areas.find(
    (area) => normalizeAdministrativeName(area.name) === normalizedName,
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

const findDistrictFromQuery = (
  districts: AdministrativeArea[],
  query: string,
  regencyName: string,
): AdministrativeArea | undefined => {
  const normalizedQuery = normalizeAdministrativeName(query);
  const regencyTokens = new Set(
    normalizeAdministrativeName(regencyName).match(/[a-z]+/g) ?? [],
  );
  const queryTokens = (query.toLocaleLowerCase('id-ID').match(/[a-z]+/g) ?? [])
    .map(normalizeAdministrativeName)
    .filter(
      (token) =>
        token.length > 2 &&
        !regencyTokens.has(token) &&
        !isGenericAdministrativeName(token),
    );

  const exactMatch = districts.find((district) => {
    if (isGenericAdministrativeName(district.name)) return false;
    const normalizedDistrict = normalizeAdministrativeName(district.name);
    return normalizedQuery.includes(normalizedDistrict) ||
      queryTokens.includes(normalizedDistrict);
  });
  if (exactMatch) return exactMatch;

  let closest: AdministrativeArea | undefined;
  let closestDistance = 2;
  for (const token of queryTokens) {
    for (const district of districts) {
      if (isGenericAdministrativeName(district.name)) continue;
      const normalizedDistrict = normalizeAdministrativeName(district.name);
      if (Math.abs(normalizedDistrict.length - token.length) > 1) continue;
      const distance = editDistance(token, normalizedDistrict);
      if (distance < closestDistance) {
        closest = district;
        closestDistance = distance;
      }
    }
  }
  return closest;
};

export async function resolveDistrictQuery(
  locationQuery: string,
): Promise<GeocodedDistrict> {
  const query = locationQuery.trim();
  if (!query) {
    throw new RangeError('Nama wilayah tidak boleh kosong.');
  }

  const searchQuery = query
    .replace(/\bkab\.?\s+/gi, 'Kabupaten ')
    .replace(/\bkec\.?\s+/gi, 'Kecamatan ');
  const provinces = await getAdministrativeAreas('provinces');
  const searchQueries = [searchQuery];
  const parentLocation = /\b(?:kota|kabupaten)\s+.+$/i.exec(searchQuery)?.[0];
  if (parentLocation && normalizeAdministrativeName(parentLocation) !== normalizeAdministrativeName(searchQuery)) {
    searchQueries.push(parentLocation);
  }

  for (const [queryIndex, candidateQuery] of searchQueries.entries()) {
    if (queryIndex > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }

    const { data } = await axios.get<unknown>(NOMINATIM_SEARCH_URL, {
      params: {
        q: `${candidateQuery}, Indonesia`,
        format: 'jsonv2',
        addressdetails: 1,
        countrycodes: 'id',
        limit: 5,
      },
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'id',
        'User-Agent': NOMINATIM_USER_AGENT,
      },
      timeout: 10_000,
    });

    if (!Array.isArray(data)) {
      throw new Error('Format respons pencarian lokasi Nominatim tidak dikenali.');
    }

    for (const result of data) {
      if (!isRecord(result) || !isRecord(result['address'])) continue;
      const address = result['address'];
      const provinceName = getAddressValue(address, 'state', 'province');
      const regencyName = getAddressValue(
        address,
        'county',
        'city',
        'municipality',
      );
      if (!provinceName || !regencyName) continue;

      const province = findArea(provinces, provinceName);
      if (!province) continue;

      const regencies = await getAdministrativeAreas(`regencies/${province.code}`);
      const regency = findArea(regencies, regencyName);
      if (!regency) continue;

      const districts = await getAdministrativeAreas(`districts/${regency.code}`);
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
      const district = districtCandidates
        .map((candidate) => findArea(districts, candidate))
        .find((area): area is AdministrativeArea => Boolean(area));
      const districtFromQuery =
        district ?? findDistrictFromQuery(districts, query, regency.name);
      if (districtFromQuery) {
        const villages = await getAdministrativeAreas(
          `villages/${districtFromQuery.code}`,
        );
        return {
          district: districtFromQuery.name,
          regency: regency.name,
          province: province.name,
          villages,
        };
      }

      const osmVillageNames = [
        'village',
        'suburb',
        'neighbourhood',
        'hamlet',
      ]
        .map((key) => getAddressValue(address, key))
        .filter((name): name is string => Boolean(name));
      if (osmVillageNames.length === 0) continue;

      for (let offset = 0; offset < districts.length; offset += 5) {
        const districtBatch = districts.slice(offset, offset + 5);
        const villagesByDistrict = await Promise.all(
          districtBatch.map(async (candidate) => ({
            district: candidate,
            villages: await getAdministrativeAreas(
              `villages/${candidate.code}`,
            ),
          })),
        );
        const villageMatch = villagesByDistrict.find(({ villages }) =>
          villages.some((village) =>
            osmVillageNames.some(
              (name) =>
                normalizeAdministrativeName(name) ===
                normalizeAdministrativeName(village.name),
            ),
          ),
        );
        if (villageMatch) {
          return {
            district: villageMatch.district.name,
            regency: regency.name,
            province: province.name,
            villages: villageMatch.villages,
          };
        }
      }
    }
  }

  throw new Error(
    `Wilayah "${query}" tidak ditemukan atau tidak dapat dipetakan ke kecamatan/desa di Indonesia.`,
  );
}

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
