import type {
  Word,
  DailyPlan,
  WordStats,
} from "../core/model";

/** 简单订阅式视图骨架:首版把 DOM 呈现与逻辑分离 */
export interface RecapGroup {
  title: string;
  words: string[]; // 展示用标签(如 "apple ↔ 苹果")
}

/** 升级面板中的可购升级项 */
export interface UpgradeEntry {
  key: string; // 面板回传用标识
  name: string;
  desc: string;
  cost: number | null; // null=已满级
  applied: boolean; // 该株已购(打勾展示)
}
export interface AppState {
  words: Word[];
  statsByWord: Map<string, WordStats>;
  today: number;
  plan: DailyPlan | null;
  sun: number;
  baseSiege: boolean; // 基地是否正被围攻(驱动 HUD 红闪)
  baseHp: number;
  act: number;
  combo: number;
  diamond: number; // 累计钻石(五幕全通且基地无损,每天最多 1 颗,跨天累计)
  log: string[];
}

export class UI {
  root: HTMLElement;
  state: AppState = {
    words: [],
    statsByWord: new Map(),
    today: 1,
    plan: null,
    sun: 0,
    baseSiege: false,
    baseHp: 100,
    act: 0,
    combo: 0,
    diamond: 0,
    log: [],
  };

  private handlers: {
    onImport?: (lines: string[]) => void;
    onSkipImport?: () => void;
    onStartBattle?: () => void;
    onNextDay?: () => void;
    onCreatePlan?: () => void;
    onToggleUpgradeMode?: () => void;
    onUpgradeBuy?: (key: string) => void;
    onUpgradeClose?: () => void;
  } = {};

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = this.layout();
    this.bindStartPage();
  }

  private layout(): string {
    return `
    <div class="app">
      <header class="hud">
        <div class="hud-diamond" title="累计钻石:每达成「五幕全通 + 基地无损」获得 1 颗,每天最多 1 颗">💎 <span id="diamond">0</span></div>
        <div>第 <span id="today">1</span> 天</div>
        <div>阳光 <span id="sun">0</span></div>
        <div>基地 <span id="base">100</span></div>
        <div>幕 <span id="act">-</span></div>
        <div>连击 <span id="combo">0</span></div>
        <button id="upgradeBtn">升级</button>
      </header>
      <section id="screen"></section>
    </div>`;
  }

  private bindStartPage(): void {
    this.screen(`
      <div class="panel">
        <h2>词域攻防</h2>
        <p>每行一个词条:外语,中文</p>
        <textarea id="wordInput" rows="8" placeholder="apple,苹果&#10;猫,ねこ"></textarea>
        <button id="importBtn">导入词表</button>
        <button id="skipImportBtn">跳过,先不用导入</button>
        <p id="importMsg"></p>
      </div>`);
    this.root.querySelector("#importBtn")!.addEventListener("click", () => {
      const ta = this.root.querySelector<HTMLTextAreaElement>("#wordInput")!;
      this.handlers.onImport?.(ta.value.split("\n"));
    });
    this.root.querySelector("#skipImportBtn")!.addEventListener("click", () => {
      this.handlers.onSkipImport?.();
    });
  }

  /** 重置界面内容 */
  private screen(html: string): void {
    const scr = this.root.querySelector("#screen")!;
    scr.innerHTML = html;
  }

  renderMainMenu(): void {
    const { statsByWord, words, plan } = this.state;
    const learned = words.filter((w) => statsByWord.has(w.id)).length;
    const empty = words.length === 0;
    this.screen(`
      <div class="panel">
        <h2>词域攻防</h2>
        <p>词表 ${words.length} 词 | 已学 ${learned}</p>
        ${empty ? `<p>词库为空,请先导入词表</p>` : ""}
        ${plan ? `<p>今日计划:新词 ${plan.newWords.length},共 ${plan.acts.reduce((s, a) => s + a.zombies.length, 0)} 只僵尸</p>` : ""}
        <button id="startBtn" ${empty ? "disabled" : ""}>${plan ? "开一局" : empty ? "请先导入词表" : "生成今日计划"}</button>
        <button id="nextDayBtn" ${plan ? "" : "disabled"}>次日</button>
        <button id="importMoreBtn">${empty ? "导入词库" : "导入更多词"}</button>
        <div id="stats"></div>
      </div>`);
    this.root.querySelector("#startBtn")!.addEventListener("click", () => {
      if (!empty && this.state.plan) this.handlers.onStartBattle?.();
      else if (!empty) this.handlers.onCreatePlan?.();
    });
    this.root.querySelector("#nextDayBtn")!.addEventListener("click", () => this.handlers.onNextDay?.());
    this.root.querySelector("#importMoreBtn")!.addEventListener("click", () => this.bindStartPage());
    this.setUpgradeBtn(false);
    this.closeUpgradePanel();
  }

  renderBattle(canvas: HTMLCanvasElement, tray: HTMLElement, btnPause: HTMLElement): void {
    this.screen(`
      <div class="battle">
        <canvas id="field"></canvas>
        <div id="tray"></div>
        <button id="pauseBtn">暂停</button>
        <div id="battleMsg"></div>
      </div>`);
    const holder = this.root.querySelector("#screen")!;
    holder.querySelector("#tray")!.appendChild(tray);
    holder.querySelector("#field")!.appendChild(canvas);
    holder.querySelector("#pauseBtn")!.appendChild(btnPause);
    this.setUpgradeBtn(true);
    this.updateHud();
  }

  /** 战斗中的升级按钮显隐:仅战斗时可用。 */
  setUpgradeBtn(visible: boolean): void {
    const btn = this.root.querySelector<HTMLButtonElement>("#upgradeBtn");
    if (!btn) return;
    btn.style.display = visible ? "" : "none";
    if (visible) {
      btn.onclick = () => this.handlers.onToggleUpgradeMode?.();
    }
  }

  /** 单株升级面板(角落浮层,不挡战场):以株名词条 + 升级项列表 + 购买/关闭。 */
  renderUpgradePanel(plantLabel: string, entries: UpgradeEntry[]): void {
    this.closeUpgradePanel();
    const scr = this.root.querySelector("#screen")!;
    const div = document.createElement("div");
    div.className = "upgrade-panel";
    div.id = "upgradePanel";
    div.innerHTML = `<h3>升级 · ${plantLabel}</h3>`;
    for (const e of entries) {
      const btn = document.createElement("button");
      const costText = e.cost === null ? "已满级" : `¥${e.cost}`;
      btn.disabled = e.applied || e.cost === null || e.cost > this.state.sun;
      btn.textContent = `${e.name} — ${costText}`;
      btn.title = e.desc;
      btn.dataset.key = e.key;
      // 面板打开期间阳光会增长,记录门槛以便 onFrame 轻量刷新 disabled,不必重开面板
      btn.dataset.cost = e.cost === null ? "" : String(e.cost);
      if (e.applied || e.cost === null) btn.dataset.locked = "1";
      btn.classList.add("upgrade-buy");
      const row = document.createElement("div");
      row.className = "upgrade-row";
      row.innerHTML = `<span class="upgrade-name">${e.applied ? "✅ " : ""}${e.name}</span><span class="upgrade-desc">${e.desc}</span>`;
      row.appendChild(btn);
      div.appendChild(row);
    }
    const close = document.createElement("button");
    close.id = "upgradeCloseBtn";
    close.textContent = "关闭";
    close.addEventListener("click", () => this.handlers.onUpgradeClose?.());
    div.appendChild(close);
    scr.appendChild(div);
    div.querySelectorAll<HTMLButtonElement>(".upgrade-buy").forEach((b) =>
      b.addEventListener("click", () => this.handlers.onUpgradeBuy?.(b.dataset.key ?? "")),
    );
  }

  closeUpgradePanel(): void {
    this.root.querySelector("#upgradePanel")?.remove();
  }

  /** 升级面板是否打开(供 onFrame 按当前阳光刷新购买按钮可用性)。 */
  upgradeOpen(): boolean {
    return !!this.root.querySelector("#upgradePanel");
  }

  /** 轻量刷新:仅重算各升级项按钮的 disabled(阳光增长立即可用)。 */
  refreshUpgradePanel(sun: number): void {
    const panel = this.root.querySelector<HTMLElement>("#upgradePanel");
    if (!panel) return;
    panel.querySelectorAll<HTMLButtonElement>(".upgrade-buy").forEach((b) => {
      if (b.dataset.locked) return; // 已购 / 已满级:维持禁用
      const cost = Number(b.dataset.cost || "0");
      b.disabled = cost > sun;
    });
  }

  updateHud(): void {
    this.root.querySelector("#today")!.textContent = String(this.state.today);
    if (this.state) {
      const sun = this.root.querySelector("#sun")!;
      const base = this.root.querySelector("#base")!;
      const act = this.root.querySelector("#act")!;
      const combo = this.root.querySelector("#combo")!;
      const diamond = this.root.querySelector("#diamond")!;
      sun.textContent = String(Math.round(this.state.sun));
      base.textContent = String(Math.round(this.state.baseHp));
      base.classList.toggle("siege", !!this.state.baseSiege);
      act.textContent = String(this.state.act || "-");
      combo.textContent = String(this.state.combo);
      diamond.textContent = String(this.state.diamond);
    }
  }

  /** 居中结果弹窗:状态文案 + 主按钮(确认动作由调用方指定,如重开/返回)。 */
  renderResult(msg: string, confirmLabel: string, onConfirm: () => void): void {
    const scr = this.root.querySelector("#screen")!;
    const div = document.createElement("div");
    div.className = "result";
    div.innerHTML = msg;
    const btn = document.createElement("button");
    btn.id = "resultOkBtn";
    btn.textContent = confirmLabel;
    btn.addEventListener("click", onConfirm);
    div.appendChild(btn);
    scr.appendChild(div);
    btn.focus();
  }

  /** 右侧复盘窗:固定在战场右侧,不遮挡居中的结果弹窗;纯信息展示。 */
  renderRecap(groups: RecapGroup[]): void {
    const scr = this.root.querySelector("#screen")!;
    const div = document.createElement("div");
    div.className = "recap";
    div.innerHTML = `<h3>今日复盘</h3>`;
    for (const g of groups) {
      const chips = g.words.length
        ? g.words.map((w) => `<span class="chip">${w}</span>`).join("")
        : `<span class="muted">(无)</span>`;
      div.insertAdjacentHTML("beforeend", `<h4>${g.title} · ${g.words.length}</h4><p class="chips">${chips}</p>`);
    }
    scr.appendChild(div);
  }

  /** 清掉结果/复盘浮层(重开本幕前调用),保持战场干净。 */
  clearOverlays(): void {
    this.root.querySelectorAll<HTMLElement>(".result, .recap").forEach((el) => el.remove());
  }

  log(msg: string): void {
    this.state.log.push(msg);
  }

  /** 战斗提示(顶部信息条) */
  setMsg(msg: string): void {
    const el = this.root.querySelector("#battleMsg")!;
    el.textContent = msg;
  }

  onImport(fn: (lines: string[]) => void): void { this.handlers.onImport = fn; }
  onSkipImport(fn: () => void): void { this.handlers.onSkipImport = fn; }
  onStartBattle(fn: () => void): void { this.handlers.onStartBattle = fn; }
  onCreatePlan(fn: () => void): void { this.handlers.onCreatePlan = fn; }
  onNextDay(fn: () => void): void { this.handlers.onNextDay = fn; }
  onToggleUpgradeMode(fn: () => void): void { this.handlers.onToggleUpgradeMode = fn; }
  onUpgradeBuy(fn: (key: string) => void): void { this.handlers.onUpgradeBuy = fn; }
  onUpgradeClose(fn: () => void): void { this.handlers.onUpgradeClose = fn; }
}

/** 从文本行导入(每行:外语,中文) */
export function parseWordLines(lines: string[]): { foreign: string; chinese: string }[] {
  const out: { foreign: string; chinese: string }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const [foreign, ...rest] = line.split(/[,，]/);
    if (foreign && rest.length) {
      out.push({ foreign: foreign.trim(), chinese: rest.join("").trim() });
    }
  }
  return out;
}