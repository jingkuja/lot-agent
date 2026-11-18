import type { Pool } from "pg";
import {
  comicSystemDictionary, type ComicDictionaryDomain, type ComicDictionaryEntry, type ComicDictionaryRepository,
  type ComicDictionaryUpdate, type ComicLabels,
} from "@lot-agent/core/comic-drama";
import { ComicLibraryError, libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";

type ChoiceRow = { key: string; labels: ComicLabels | null; inactive: boolean; sort: number | null };
export async function readComicDictionary(db: ComicQuery, owner: string, domain: ComicDictionaryDomain): Promise<ComicDictionaryEntry[]> {
  const { rows } = await db.query<ChoiceRow>(`SELECT key,labels,inactive,sort FROM lot_comic_drama.cd_dictionary
    WHERE owner_id=$1 AND domain=$2 ORDER BY key`, [owner, domain]);
  const byKey = new Map(rows.map(row => [row.key, row]));
  const system = comicSystemDictionary[domain];
  const keys = new Set(system.map(row => row.key));
  const merged = [
    ...system.map(entry => ({ ...entry, inactive: byKey.get(entry.key)?.inactive ?? false })),
    ...rows.flatMap(row => row.labels && !keys.has(row.key) ? [{ key: row.key, labels: row.labels, inactive: row.inactive, system: false }] : []),
  ];
  return merged.sort((a, b) => (byKey.get(a.key)?.sort ?? Infinity) - (byKey.get(b.key)?.sort ?? Infinity));
}

export async function requireComicChoice(db: ComicQuery, owner: string, domain: ComicDictionaryDomain, key: string | null) {
  if (key && !(await readComicDictionary(db, owner, domain)).some(row => row.key === key && !row.inactive)) {
    throw new ComicLibraryError("INVALID_CATEGORY", 400);
  }
}

export class PgComicDictionary implements ComicDictionaryRepository {
  constructor(private readonly pool: Pool) {}
  dictionary(owner: string, domain: ComicDictionaryDomain) { return readComicDictionary(this.pool, owner, domain); }

  private edit(owner: string, domain: ComicDictionaryDomain, operation: (db: ComicQuery, entries: ComicDictionaryEntry[]) => Promise<void>) {
    return libraryTransaction(this.pool, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`comic-dictionary:${owner}:${domain}`]);
      await operation(db, await readComicDictionary(db, owner, domain));
      return readComicDictionary(db, owner, domain);
    });
  }

  addDictionary(owner: string, domain: ComicDictionaryDomain, key: string, labels: ComicLabels) {
    return this.edit(owner, domain, async (db, entries) => {
      if (entries.length >= 512) throw new ComicLibraryError("DICTIONARY_FULL", 400);
      if (entries.some(row => row.key === key)) throw new ComicLibraryError("DICTIONARY_KEY_EXISTS", 409);
      await db.query("INSERT INTO lot_comic_drama.cd_dictionary(owner_id,domain,key,labels) VALUES($1,$2,$3,$4)", [owner, domain, key, labels]);
    });
  }

  editDictionary(owner: string, domain: ComicDictionaryDomain, key: string, input: ComicDictionaryUpdate) {
    return this.edit(owner, domain, async (db, entries) => {
      const entry = entries.find(row => row.key === key);
      if (!entry) libraryMissing();
      if (entry.system && input.labels) throw new ComicLibraryError("SYSTEM_LABELS_READ_ONLY", 400);
      await db.query(`INSERT INTO lot_comic_drama.cd_dictionary(owner_id,domain,key,labels,inactive) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(owner_id,domain,key) DO UPDATE SET labels=excluded.labels,inactive=excluded.inactive`,
        [owner, domain, key, entry.system ? null : input.labels ?? entry.labels, input.inactive ?? entry.inactive]);
    });
  }

  sortDictionary(owner: string, domain: ComicDictionaryDomain, keys: string[]) {
    return this.edit(owner, domain, async (db, entries) => {
      const supplied = new Set(keys);
      if (keys.length !== entries.length || entries.some(row => !supplied.has(row.key))) throw new ComicLibraryError("INVALID_ORDER", 409);
      await db.query(`INSERT INTO lot_comic_drama.cd_dictionary(owner_id,domain,key,sort)
        SELECT $1,$2,key,ordinality FROM unnest($3::text[]) WITH ORDINALITY AS ordered(key,ordinality)
        ON CONFLICT(owner_id,domain,key) DO UPDATE SET sort=excluded.sort`, [owner, domain, keys]);
    });
  }
}
