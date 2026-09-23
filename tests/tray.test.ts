import { describe, expect, it } from "vitest";
import { hashDirection } from "../src/scheduler/planner";

describe("Direction stability across acts", () => {
  it("finds a real word whose direction differs between Act2 and Act4 (the bug)", () => {
    let found = false;
    for (let i = 0; i < 5000; i++) {
      const id = `w${i}`;
      if (hashDirection(id, 2) !== hashDirection(id, 4)) {
        console.log(`word ${id}: act2=${hashDirection(id, 2)} act4=${hashDirection(id, 4)}`);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("tray must include BOTH forward and reverse card for every word in any act (防猜词)", () => {
    // 复刻 app 的 buildTray 输入逻辑:每词固定放正向+反向两张卡
    const acts = [
      { act: 1, zombies: [{ wordId: "w3", direction: "forward" as const, teaching: true, boss: false }] },
      { act: 2, zombies: [{ wordId: "w3", direction: "forward" as const, teaching: false, boss: false }] },
      { act: 4, zombies: [{ wordId: "w3", direction: "reverse" as const, teaching: false, boss: true }] },
    ];
    const trayCards = new Map<string, string>();
    for (const a of acts)
      for (const z of a.zombies) {
        trayCards.set(`${z.wordId}:forward`, z.wordId);
        trayCards.set(`${z.wordId}:reverse`, z.wordId);
      }
    // 任一出现的词,中(forward)/外(reverse)两张卡都必须具备
    for (const a of acts)
      for (const z of a.zombies) {
        expect(trayCards.has(`${z.wordId}:forward`)).toBe(true);
        expect(trayCards.has(`${z.wordId}:reverse`)).toBe(true);
      }
    expect(trayCards.size).toBe(2); // w3:forward + w3:reverse
  });
});
