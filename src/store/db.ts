import { openDB } from "idb";
import type { IDBPDatabase } from "idb";
import type { DaySnapshot, ProfileId, Word, WordStats } from "../core/model";

const DB_NAME = "pvpz-vocab";
const DB_VERSION = 3;
const WORDS = "words";
const STATS = "stats";
const META = "meta";
const SNAPSHOT = "snapshot";
const APP_META = "app_meta";

let dbPromise: Promise<IDBPDatabase> | null = null;

export async function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        // 复合主键 store:以 [profile, ...] 隔离两套语言对的词表/进度/天数/钻石。
        if (oldVersion === 0) {
          createSchema(db);
          await tx.objectStore(APP_META).put("en", "activeProfile");
          return;
        }
        // 旧版单语言档(v1/v2)迁移:读出 → 重建为复合主键 → 整体归入 en,activeProfile=en
        await migrateLegacy(db, oldVersion, tx);
      },
    });
  }
  return dbPromise;
}

/** 全新库(无旧数据):按 v3 分库 schema 建 4 个复合主键 store + APP_META */
function createSchema(db: IDBPDatabase): void {
  const wStore = db.createObjectStore(WORDS, { keyPath: ["profile", "id"] });
  wStore.createIndex("by_profile", "profile");
  const sStore = db.createObjectStore(STATS, { keyPath: ["profile", "wordId"] });
  sStore.createIndex("by_profile", "profile");
  db.createObjectStore(META, { keyPath: ["profile", "key"] });
  const nStore = db.createObjectStore(SNAPSHOT, { keyPath: ["profile", "day"] });
  nStore.createIndex("by_profile", "profile");
  db.createObjectStore(APP_META);
}

/**
 * v1/v2 → v3 迁移:旧 store 为单值主键/out-of-line,无词库维度。
 * 将旧数据(词表/统计/快照/meta)整体归入 en,并置 activeProfile=en。
 * 全程在 upgrade 事务内操作(版本化事务外调用 db.put 会抛 InvalidStateError)。
 */
async function migrateLegacy(db: IDBPDatabase, oldVersion: number, tx: import("idb").IDBPTransaction<unknown, string[], "versionchange">): Promise<void> {
  const oldWords = oldVersion >= 1 && db.objectStoreNames.contains(WORDS) ? ((await tx.objectStore(WORDS).getAll()) as Word[]) : [];
  const oldStats = oldVersion >= 1 && db.objectStoreNames.contains(STATS) ? ((await tx.objectStore(STATS).getAll()) as WordStats[]) : [];
  const oldSnaps = oldVersion >= 1 && db.objectStoreNames.contains(SNAPSHOT) ? ((await tx.objectStore(SNAPSHOT).getAll()) as DaySnapshot[]) : [];
  const oldMetaKeys = oldVersion >= 1 && db.objectStoreNames.contains(META) ? ((await tx.objectStore(META).getAllKeys()) as string[]) : [];
  const oldMetaValues = oldVersion >= 1 && db.objectStoreNames.contains(META) ? ((await tx.objectStore(META).getAll()) as number[]) : [];

  for (const name of [WORDS, STATS, META, SNAPSHOT]) {
    if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
  }
  createSchema(db);

  const words = oldWords.map((w) => ({ ...w, profile: "en" as ProfileId }));
  for (const w of words) await tx.objectStore(WORDS).put(w);
  const stats = oldStats.map((s) => ({ ...s, profile: "en" as ProfileId }));
  for (const s of stats) await tx.objectStore(STATS).put(s);
  const snaps = oldSnaps.map((s) => ({ ...s, profile: "en" as ProfileId }));
  for (const s of snaps) await tx.objectStore(SNAPSHOT).put(s);
  oldMetaKeys.forEach((key, i) => {
    void tx.objectStore(META).put({ profile: "en" as ProfileId, key, value: oldMetaValues[i] });
  });
  await tx.objectStore(APP_META).put("en", "activeProfile");
}

/* ---------- 词库维度(全局) ---------- */

export async function getActiveProfile(): Promise<ProfileId> {
  const db = await getDb();
  const v = (await db.get(APP_META, "activeProfile")) as ProfileId | undefined;
  return v ?? "en";
}

export async function setActiveProfile(profile: ProfileId): Promise<void> {
  const db = await getDb();
  await db.put(APP_META, profile, "activeProfile");
}

/* ---------- 词表 ---------- */

export async function saveWords(profile: ProfileId, words: Word[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(WORDS, "readwrite");
  for (const w of words) await tx.store.put({ ...w, profile });
  await tx.done;
}

export async function getAllWords(profile: ProfileId): Promise<Word[]> {
  const db = await getDb();
  const all = (await db.getAllFromIndex(WORDS, "by_profile")) as Word[];
  return all.filter((w) => w.profile === profile);
}

/* ---------- 统计 ---------- */

export async function saveStats(profile: ProfileId, stats: WordStats[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STATS, "readwrite");
  for (const s of stats) await tx.store.put({ ...s, profile });
  await tx.done;
}

export async function getStatsByWordId(profile: ProfileId): Promise<Map<string, WordStats>> {
  const db = await getDb();
  const all = (await db.getAll(STATS)) as WordStats[];
  return new Map(all.filter((s) => s.profile === profile).map((s) => [s.wordId, s]));
}

/* ---------- 元信息(按词库) ---------- */

export async function getMeta(profile: ProfileId, key: string): Promise<number | undefined> {
  const db = await getDb();
  const rec = (await db.get(META, [profile, key])) as { value?: number } | undefined;
  return rec?.value;
}

export async function setMeta(profile: ProfileId, key: string, value: number): Promise<void> {
  const db = await getDb();
  await db.put(META, { profile, key, value });
}

/* ---------- 当日快照 ---------- */

export async function saveSnapshot(profile: ProfileId, snap: DaySnapshot): Promise<void> {
  const db = await getDb();
  await db.put(SNAPSHOT, { ...snap, profile }); // 复合主键 [profile, day]
}

export async function getSnapshot(profile: ProfileId, day: number): Promise<DaySnapshot | undefined> {
  const db = await getDb();
  return (await db.get(SNAPSHOT, [profile, day])) as DaySnapshot | undefined;
}

export async function deleteSnapshot(profile: ProfileId, day: number): Promise<void> {
  const db = await getDb();
  await db.delete(SNAPSHOT, [profile, day]);
}

/* ---------- 清理 ---------- */

export async function clearAll(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([WORDS, STATS, META, SNAPSHOT, APP_META], "readwrite");
  await tx.objectStore(WORDS).clear();
  await tx.objectStore(STATS).clear();
  await tx.objectStore(META).clear();
  await tx.objectStore(SNAPSHOT).clear();
  await tx.objectStore(APP_META).clear();
  await tx.done;
}

/**
 * 复位:只清单个词库的学习进度与成就奖励,保留该词库已导入词表。
 * - 清空该词库所有词的 stats(全部变回「新词」)
 * - 清空该词库当日快照(含历史快照)
 * - meta 重置:day→1、diamond→0,删除 diamondDay(lastAwardDay)
 */
export async function resetProfile(profile: ProfileId): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([STATS, SNAPSHOT, META], "readwrite");
  const allStats = (await tx.objectStore(STATS).getAll()) as WordStats[];
  for (const s of allStats) if (s.profile === profile) await tx.objectStore(STATS).delete([profile, s.wordId]);
  const allSnaps = (await tx.objectStore(SNAPSHOT).getAll()) as DaySnapshot[];
  for (const s of allSnaps) if (s.profile === profile) await tx.objectStore(SNAPSHOT).delete([profile, s.day]);
  await tx.objectStore(META).put({ profile, key: "day", value: 1 });
  await tx.objectStore(META).put({ profile, key: "diamond", value: 0 });
  await tx.objectStore(META).delete([profile, "diamondDay"]);
  await tx.done;
}