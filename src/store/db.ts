import { openDB } from "idb";
import type { IDBPDatabase } from "idb";
import type { Word, WordStats } from "../core/model";

const DB_NAME = "pvpz-vocab";
const DB_VERSION = 2;
const WORDS = "words";
const STATS = "stats";
const META = "meta";
const SNAPSHOT = "snapshot";

let dbPromise: Promise<IDBPDatabase> | null = null;

export async function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(WORDS)) db.createObjectStore(WORDS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STATS)) db.createObjectStore(STATS, { keyPath: "wordId" });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        if (!db.objectStoreNames.contains(SNAPSHOT)) db.createObjectStore(SNAPSHOT, { keyPath: "day" });
      },
    });
  }
  return dbPromise;
}

export async function saveWords(words: Word[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(WORDS, "readwrite");
  for (const w of words) await tx.store.put(w);
  await tx.done;
}

export async function saveStats(stats: WordStats[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STATS, "readwrite");
  for (const s of stats) await tx.store.put(s);
  await tx.done;
}

export async function getStatsByWordId(): Promise<Map<string, WordStats>> {
  const db = await getDb();
  const all = (await db.getAll(STATS)) as WordStats[];
  return new Map(all.map((s) => [s.wordId, s]));
}

export async function getAllWords(): Promise<Word[]> {
  const db = await getDb();
  return (await db.getAll(WORDS)) as Word[];
}

export async function getMeta(key: string): Promise<number | undefined> {
  const db = await getDb();
  return (await db.get(META, key)) as number | undefined;
}

export async function setMeta(key: string, value: number): Promise<void> {
  const db = await getDb();
  await db.put(META, value, key);
}

export async function saveSnapshot(snap: import("../core/model").DaySnapshot): Promise<void> {
  const db = await getDb();
  await db.put(SNAPSHOT, snap); // SNAPSHOT 用 in-line key(keyPath=day)
}

export async function getSnapshot(day: number): Promise<import("../core/model").DaySnapshot | undefined> {
  const db = await getDb();
  return (await db.get(SNAPSHOT, day)) as import("../core/model").DaySnapshot | undefined;
}

export async function deleteSnapshot(day: number): Promise<void> {
  const db = await getDb();
  await db.delete(SNAPSHOT, day);
}

export async function clearAll(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([WORDS, STATS, META, SNAPSHOT], "readwrite");
  await tx.objectStore(WORDS).clear();
  await tx.objectStore(STATS).clear();
  await tx.objectStore(META).clear();
  await tx.objectStore(SNAPSHOT).clear();
  await tx.done;
}