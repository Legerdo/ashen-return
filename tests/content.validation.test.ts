import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audioStrings } from '../src/content/audioContent';
import { containerStrings } from '../src/content/containerTypes';
import { buildCorePack, createContent } from '../src/content/core';
import { extraCorePack } from '../src/content/corePack2';
import { itemStrings } from '../src/content/items';
import type { MapDef } from '../src/content/mapTypes';
import { mapStrings } from '../src/content/maps/mapStrings';
import { progressionStrings } from '../src/content/progressionContent';
import { AUDIO_BUSES, type ItemDef } from '../src/content/types';
import { TIME_PHASES, WEATHERS } from '../src/content/world';
import { Rng } from '../src/core/rng';
import { ACTIONS } from '../src/presentation/input';
import { KO_UI } from '../src/ui/i18n/ko';
import { hitboxOf } from '../src/world/context';
import { WorldGeometry, type DynamicState } from '../src/world/geometry';
import { RANGE_PRESETS } from '../src/world/range';
import { emptySim, newActor, spawnEnemy, standardMagazineFor } from '../src/world/spawn';

/**
 * Content validation for Chapter 1: uniqueness (a), referential integrity (b), spec counts (c), localization (d)
 * and map sanity (e). Everything is derived from the live registry built by createContent() (core pack +
 * Chapter 1 pack) and, where the game builds keys/ids in code, from the TypeScript sources under src/.
 * Every check collects all problems first and asserts an empty list, so a failure names every offender.
 */

const content = createContent();
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

// --- generic helpers ---------------------------------------------------------------------------------------------

const items = (): ItemDef[] => [...content.items.values()];
const maps = (): MapDef[] => [...content.maps.values()];
const raidMaps = (): MapDef[] => maps().filter((m) => m.kind === 'raid');

/** Every definition table of the registry (discovered from the instance, so new tables are covered automatically). */
function registryTables(): [string, Map<string, unknown>][] {
  return Object.entries(content).filter((e): e is [string, Map<string, unknown>] => e[1] instanceof Map && e[0] !== 'strings');
}

type Visit = (prop: string, value: unknown, path: string) => void;

/** Depth-first walk over plain objects/arrays, reporting every property (name, value, path). */
function walk(node: unknown, visit: Visit, path: string, seen: Set<object> = new Set()): void {
  if (node === null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  const isArr = Array.isArray(node);
  const entries: [string, unknown][] = isArr ? (node as unknown[]).map((v, i) => [String(i), v]) : Object.entries(node);
  for (const [k, v] of entries) {
    const p = isArr ? `${path}[${k}]` : `${path}.${k}`;
    visit(k, v, p);
    walk(v, visit, p, seen);
  }
}

/** Known ids: every `id` / `…Id` / `…Ids` value in any definition (content ids, door/interactable/poi/exit ids,
 * audio event ids, station ids …), every table key and every registered pack id. Built from the registry. */
function knownIds(): Set<string> {
  const ids = new Set<string>();
  for (const [table, map] of registryTables()) {
    for (const [id, def] of map) {
      ids.add(id);
      walk(
        def,
        (prop, v) => {
          if (typeof v === 'string' && (prop === 'id' || /Id$/.test(prop))) ids.add(v);
          if (Array.isArray(v) && /Ids$/.test(prop)) for (const x of v) if (typeof x === 'string') ids.add(x);
        },
        `${table}[${id}]`,
      );
    }
  }
  for (const p of content.packs) ids.add(p.split('@')[0]!);
  return ids;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

const srcText = (rel: string): string => readFileSync(join(SRC_DIR, rel), 'utf8');
const relSrc = (abs: string): string => `src/${relative(SRC_DIR, abs).split('\\').join('/')}`;

/** String members of an exported union type, e.g. `export type UseResult = 'started' | 'invalid';`. */
function unionMembers(rel: string, typeName: string): string[] {
  const m = new RegExp(`export type ${typeName} =([^;]+);`).exec(srcText(rel));
  if (!m) throw new Error(`type ${typeName} not found in ${rel}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** String elements of a (possibly non-exported) `const NAME = [...]` array literal. */
function constStringArray(rel: string, name: string): string[] {
  const m = new RegExp(`const ${name}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`).exec(srcText(rel));
  if (!m) throw new Error(`const ${name} not found in ${rel}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

// --- TypeScript string-literal scanner ----------------------------------------------------------------------------

interface SrcLiteral {
  file: string;
  line: number;
  value: string;
  /** Template literal with ${…} (a dynamic key; checked separately through the template-key assertions). */
  interpolated: boolean;
  /** Code preceding the literal (comments stripped, earlier literals replaced by ''), for call-site context. */
  before: string;
}

type Prev = { kind: 'ident'; text: string } | { kind: 'punct'; text: string } | { kind: 'literal' } | { kind: 'start' };
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'of', 'in', 'do', 'else', 'void', 'yield', 'await', 'delete', 'throw', 'new', 'instanceof']);

/** Minimal TS lexer: extracts '…', "…" and `…` literals (incl. literals nested in ${…}); skips comments and regexes. */
class LiteralScanner {
  private i = 0;
  private line = 1;
  private tail = '';
  private ident = '';
  private prev: Prev = { kind: 'start' };
  readonly literals: SrcLiteral[] = [];

  constructor(
    private readonly file: string,
    private readonly s: string,
  ) {
    this.code(false);
  }

  private emit(text: string): void {
    this.tail += text;
    if (this.tail.length > 400) this.tail = this.tail.slice(-200);
  }

  private flushIdent(): void {
    if (this.ident) this.prev = { kind: 'ident', text: this.ident };
    this.ident = '';
  }

  private regexAllowed(): boolean {
    this.flushIdent();
    const p = this.prev;
    if (p.kind === 'start') return true;
    if (p.kind === 'literal') return false;
    if (p.kind === 'ident') return REGEX_AFTER_WORD.has(p.text);
    return p.text !== ')' && p.text !== ']';
  }

  private code(untilBrace: boolean): void {
    const s = this.s;
    let depth = 0;
    while (this.i < s.length) {
      const c = s[this.i]!;
      const d = s[this.i + 1];
      if (c === '/' && d === '/') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === '/' && d === '*') {
        const end = s.indexOf('*/', this.i + 2);
        const stop = end < 0 ? s.length : end + 2;
        for (let k = this.i; k < stop; k++) if (s[k] === '\n') this.line++;
        this.i = stop;
        this.emit(' ');
        continue;
      }
      if (c === "'" || c === '"') {
        this.quoted(c);
        continue;
      }
      if (c === '`') {
        this.template();
        continue;
      }
      if (c === '/' && this.regexAllowed() && this.regex()) continue;
      if (/[A-Za-z0-9_$]/.test(c)) {
        this.ident += c;
        this.emit(c);
        this.i++;
        continue;
      }
      this.flushIdent();
      if (c === '\n') this.line++;
      if (!/\s/.test(c)) this.prev = { kind: 'punct', text: c };
      this.emit(c);
      this.i++;
      if (untilBrace) {
        if (c === '{') depth++;
        else if (c === '}') {
          if (depth === 0) return;
          depth--;
        }
      }
    }
  }

  private quoted(q: string): void {
    this.flushIdent();
    const s = this.s;
    const line = this.line;
    const before = this.tail;
    let j = this.i + 1;
    let v = '';
    while (j < s.length && s[j] !== q && s[j] !== '\n') {
      if (s[j] === '\\') {
        if (s[j + 1] === '\n') this.line++;
        v += s[j + 1] ?? '';
        j += 2;
        continue;
      }
      v += s[j];
      j++;
    }
    this.i = j + 1;
    this.literals.push({ file: this.file, line, value: v, interpolated: false, before });
    this.emit(`${q}${q}`);
    this.prev = { kind: 'literal' };
  }

  private template(): void {
    this.flushIdent();
    const s = this.s;
    const line = this.line;
    const before = this.tail;
    let v = '';
    let interpolated = false;
    this.i++;
    while (this.i < s.length) {
      const ch = s[this.i]!;
      if (ch === '\\') {
        v += s[this.i + 1] ?? '';
        this.i += 2;
        continue;
      }
      if (ch === '`') {
        this.i++;
        break;
      }
      if (ch === '$' && s[this.i + 1] === '{') {
        interpolated = true;
        v += '${…}';
        this.i += 2;
        this.emit('`${');
        this.prev = { kind: 'punct', text: '{' };
        this.code(true);
        continue;
      }
      if (ch === '\n') this.line++;
      v += ch;
      this.i++;
    }
    this.literals.push({ file: this.file, line, value: v, interpolated, before });
    this.emit('``');
    this.prev = { kind: 'literal' };
  }

  private regex(): boolean {
    const s = this.s;
    let j = this.i + 1;
    let inClass = false;
    for (; j < s.length; j++) {
      const ch = s[j]!;
      if (ch === '\n') return false;
      if (ch === '\\') {
        j++;
        continue;
      }
      if (inClass) {
        if (ch === ']') inClass = false;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === '/') break;
    }
    if (j >= s.length) return false;
    j++;
    while (j < s.length && /[a-z]/i.test(s[j]!)) j++;
    this.i = j;
    this.emit(' /re/ ');
    this.prev = { kind: 'literal' };
    return true;
  }
}

// --- (a) uniqueness -----------------------------------------------------------------------------------------------

describe('(a) uniqueness', () => {
  it('registry.duplicates is empty (no duplicate ids per table, no conflicting strings, no dangling map patches)', () => {
    expect(content.duplicates).toEqual([]);
  });

  it('weather / time phase ids are unique (those tables are registered without the duplicate check)', () => {
    expect(new Set(WEATHERS.map((w) => w.id)).size).toBe(WEATHERS.length);
    expect(new Set(TIME_PHASES.map((t) => t.id)).size).toBe(TIME_PHASES.length);
    expect(content.weathers.size).toBe(WEATHERS.length);
    expect(content.timePhases.size).toBe(TIME_PHASES.length);
  });

  it('every table key equals its definition id', () => {
    const problems: string[] = [];
    for (const [table, map] of registryTables()) for (const [k, d] of map) if ((d as { id?: unknown }).id !== k) problems.push(`${table}: key ${k} ≠ id ${String((d as { id?: unknown }).id)}`);
    expect(problems).toEqual([]);
  });

  it('ids inside every map, quest and chapter are unique (obstacles/doors/containers/interactables/pois/exits/…)', () => {
    const problems: string[] = [];
    const dupes = (where: string, ids: string[]) => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) problems.push(`${where}: duplicate id ${id}`);
        seen.add(id);
      }
    };
    for (const m of maps()) {
      // Doors become obstacles `door:<id>` in WorldGeometry, so they share the obstacle id space.
      dupes(`${m.id} obstacles+doors`, [...m.obstacles.map((o) => o.id), ...m.doors.map((d) => `door:${d.id}`)]);
      dupes(`${m.id} doors`, m.doors.map((d) => d.id));
      dupes(`${m.id} containers`, m.containers.map((c) => c.id));
      dupes(`${m.id} interactables`, m.interactables.map((i) => i.id));
      dupes(`${m.id} pois`, m.pois.map((p) => p.id));
      dupes(`${m.id} exits`, m.exits.map((e) => e.id));
      dupes(`${m.id} regions`, m.regions.map((r) => r.id));
      dupes(`${m.id} interiors`, m.interiors.map((i) => i.id));
      dupes(`${m.id} enemyGroups`, m.enemyGroups.map((g) => g.id));
      dupes(`${m.id} rangeTargets`, (m.rangeTargets ?? []).map((t) => t.id));
      dupes(`${m.id} turrets`, (m.turrets ?? []).map((t) => t.id));
    }
    for (const q of content.quests.values()) dupes(`${q.id} objectives`, q.objectives.map((o) => o.id));
    for (const c of content.chapters.values()) dupes(`${c.id} acts`, c.acts.map((a) => String(a.id)));
    expect(problems).toEqual([]);
  });

  it('every localization key is defined by exactly one string module and never silently overwritten', () => {
    const modules: Record<string, Record<string, string>> = {
      'src/ui/i18n/ko.ts': KO_UI,
      'src/content/items.ts': itemStrings,
      'src/content/containerTypes.ts': containerStrings,
      'src/content/progressionContent.ts': progressionStrings,
      'src/content/audioContent.ts': audioStrings,
      'src/content/maps/mapStrings.ts': mapStrings,
    };
    const owners = new Map<string, string[]>();
    for (const [mod, table] of Object.entries(modules)) for (const k of Object.keys(table)) owners.set(k, [...(owners.get(k) ?? []), mod]);
    const shared = [...owners].filter(([, o]) => o.length > 1).map(([k, o]) => `${k}: ${o.join(' + ')}`);
    expect(shared).toEqual([]);
    // Pack-level spreads ({ ...KO_UI, ...itemStrings, … } and the inline event strings) must not overwrite a module value.
    const core = buildCorePack().strings ?? {};
    const ch1 = extraCorePack().strings ?? {};
    const overwritten: string[] = [];
    for (const [mod, table] of Object.entries(modules)) {
      const pack = mod.includes('progression') || mod.includes('audio') || mod.includes('mapStrings') ? ch1 : core;
      for (const [k, v] of Object.entries(table)) if (pack[k] !== v) overwritten.push(`${k} (${mod})`);
    }
    expect(overwritten).toEqual([]);
    // progressionContent.ts registers through S(key, text): the same key must not be S()-registered twice.
    const sKeys = [...srcText('content/progressionContent.ts').matchAll(/\bS\(\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(sKeys.length).toBeGreaterThan(100);
    expect(sKeys.filter((k, i) => sKeys.indexOf(k) !== i)).toEqual([]);
    // Every registered string comes from one of these modules or the Chapter 1 pack's inline strings.
    const known = new Set([...owners.keys(), ...Object.keys(ch1)]);
    expect([...content.strings.keys()].filter((k) => !known.has(k))).toEqual([]);
  });
});

// --- (b) referential integrity -------------------------------------------------------------------------------------

describe('(b) referential integrity', () => {
  const has = {
    item: (id: string) => content.items.has(id),
    loot: (id: string) => content.lootTables.has(id),
    quest: (id: string) => content.quests.has(id),
    npc: (id: string) => content.npcs.has(id),
    key: (id: string) => content.keys.has(id),
  };

  it('loot tables: entries and guaranteed items exist; weights, rolls and quantities are sane', () => {
    const problems: string[] = [];
    for (const t of content.lootTables.values()) {
      if (!(t.rolls[0] >= 0 && t.rolls[0] <= t.rolls[1])) problems.push(`${t.id}: rolls ${t.rolls.join('..')}`);
      if (t.entries.length === 0) problems.push(`${t.id}: no entries`);
      for (const e of t.entries) {
        if (!has.item(e.itemId)) problems.push(`${t.id}: entry → unknown item ${e.itemId}`);
        if (!(e.weight > 0)) problems.push(`${t.id}: ${e.itemId} weight ${e.weight}`);
        if (!(e.qty[0] >= 1 && e.qty[0] <= e.qty[1])) problems.push(`${t.id}: ${e.itemId} qty ${e.qty.join('..')}`);
      }
      for (const g of t.guaranteed ?? []) if (!has.item(g.itemId)) problems.push(`${t.id}: guaranteed → unknown item ${g.itemId}`);
    }
    expect(problems).toEqual([]);
  });

  it('map containers → container types, loot tables, keys, quest items (+ quest ids), key items, guaranteed items, events', () => {
    const problems: string[] = [];
    for (const m of maps())
      for (const c of m.containers) {
        const at = `${m.id}/${c.id}`;
        if (!content.containerTypes.has(c.type)) problems.push(`${at}: unknown container type ${c.type}`);
        if (!has.loot(c.lootTable)) problems.push(`${at}: unknown loot table ${c.lootTable}`);
        if (c.keyId !== null && !(has.key(c.keyId) && content.key(c.keyId).containerIds.includes(c.id))) problems.push(`${at}: keyId ${c.keyId} missing or not listed in the key's containerIds`);
        for (const q of c.questItems ?? []) {
          if (!has.quest(q.questId)) problems.push(`${at}: quest item for unknown quest ${q.questId}`);
          if (!has.item(q.itemId)) problems.push(`${at}: unknown quest item ${q.itemId}`);
          else if (has.quest(q.questId) && !content.quest(q.questId).objectives.some((o) => o.target === q.itemId)) problems.push(`${at}: ${q.questId} has no objective targeting ${q.itemId}`);
          if (!(q.qty >= 1)) problems.push(`${at}: quest item qty ${q.qty}`);
        }
        if (c.keyItem !== undefined) {
          const ki = content.items.get(c.keyItem);
          if (!ki || ki.kind !== 'key' || !ki.keyId || !has.key(ki.keyId)) problems.push(`${at}: keyItem ${c.keyItem} is not a registered key item`);
        }
        for (const g of c.guaranteed ?? []) if (!has.item(g.itemId)) problems.push(`${at}: guaranteed → unknown item ${g.itemId}`);
        if (c.eventId !== undefined && !(content.raidEvents.has(c.eventId) && content.raidEvent(c.eventId).mapIds.includes(m.id))) problems.push(`${at}: event ${c.eventId} unknown or not active on ${m.id}`);
      }
    expect(problems).toEqual([]);
  });

  it('enemy archetypes → weapons (+ caliber-matched ammo, magazines), armor tiers, loot tables and hitbox profiles', () => {
    const problems: string[] = [];
    const sim = emptySim('raid', 'content-validation', 'core.map.quarantine_main', 'content-validation', 'Day', 'Clear');
    for (const arch of content.enemies.values()) {
      if (!has.loot(arch.lootTable)) problems.push(`${arch.id}: unknown loot table ${arch.lootTable}`);
      if (arch.weapons.length === 0) problems.push(`${arch.id}: no weapons`);
      for (const w of arch.weapons) {
        const wd = content.items.get(w.itemId);
        const ad = content.items.get(w.ammoId);
        if (!wd?.weapon) problems.push(`${arch.id}: ${w.itemId} is not a weapon`);
        if (!ad?.ammo) problems.push(`${arch.id}: ${w.ammoId} is not ammo`);
        if (wd?.weapon && ad?.ammo && wd.weapon.caliber !== ad.ammo.caliber) problems.push(`${arch.id}: ${w.itemId} (${wd.weapon.caliber}) loaded with ${w.ammoId} (${ad.ammo.caliber})`);
        if (wd?.weapon?.magazineFamily) {
          try {
            standardMagazineFor(content, wd.weapon.magazineFamily, wd.weapon.caliber);
          } catch (e) {
            problems.push(`${arch.id}: ${String(e)}`);
          }
        }
        if (!(w.spareMags[0] <= w.spareMags[1] && w.looseRounds[0] <= w.looseRounds[1])) problems.push(`${arch.id}: bad spare ranges for ${w.itemId}`);
      }
      for (const [slot, list] of [['vest', arch.vest], ['helmet', arch.helmet]] as const)
        for (const t of list) {
          if (t.tier === 0) continue;
          const armor = content.items.get(`core.armor.${slot}${t.tier}`);
          if (!armor?.armor || armor.armor.slot !== slot || armor.armor.tier !== t.tier) problems.push(`${arch.id}: no ${slot} armor item for tier ${t.tier}`);
        }
      // Hitboxes are chosen by the spawn code: spawn each archetype for real and resolve its standing + crouched profile.
      for (let s = 0; s < 8; s++) {
        try {
          const a = spawnEnemy(content, sim, arch.id, 10 + s, 10, Rng.fromSeed(`validation|${arch.id}|${s}`));
          if (!content.hitboxes.has(a.hitbox)) problems.push(`${arch.id}: spawned with unknown hitbox ${a.hitbox}`);
          hitboxOf(content, { ...a, stance: 'crouch' });
        } catch (e) {
          problems.push(`${arch.id}: spawn failed: ${String(e)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('map enemy groups → archetypes and regions; obstacles/doors → obstacle profiles and keys; grounds → ground defs', () => {
    const problems: string[] = [];
    for (const m of maps()) {
      const regions = new Set(m.regions.map((r) => r.id));
      for (const g of m.enemyGroups) {
        const at = `${m.id}/group ${g.id}`;
        if (!regions.has(g.regionId)) problems.push(`${at}: unknown region ${g.regionId}`);
        if (g.archetypes.length === 0) problems.push(`${at}: no archetypes`);
        for (const a of g.archetypes) {
          if (!content.enemies.has(a.id)) problems.push(`${at}: unknown archetype ${a.id}`);
          else if (g.boss && content.enemy(a.id).role !== 'boss') problems.push(`${at}: boss group spawns non-boss ${a.id}`);
        }
        if (g.requiresQuest && !has.quest(g.requiresQuest)) problems.push(`${at}: unknown quest ${g.requiresQuest}`);
        if (!(g.count[0] >= 0 && g.count[0] <= g.count[1] && g.chance > 0 && g.chance <= 1 && g.points.length > 0)) problems.push(`${at}: bad count/chance/points`);
      }
      for (const o of m.obstacles) if (!content.obstacleProfiles.has(o.profile)) problems.push(`${m.id}/${o.id}: unknown obstacle profile ${o.profile}`);
      for (const d of m.doors) {
        if (!content.obstacleProfiles.has(d.profile)) problems.push(`${m.id}/${d.id}: unknown door profile ${d.profile}`);
        if (d.keyId !== null && !(has.key(d.keyId) && content.key(d.keyId).doorIds.includes(d.id))) problems.push(`${m.id}/${d.id}: keyId ${d.keyId} missing or door not listed in the key's doorIds`);
      }
      for (const g of m.groundPalette) if (!content.grounds.has(g)) problems.push(`${m.id}: unknown ground ${g}`);
      const bad = m.ground.filter((v) => !Number.isInteger(v) || v < 0 || v >= m.groundPalette.length).length;
      if (bad) problems.push(`${m.id}: ${bad} ground cells outside the palette`);
      for (const i of m.interiors) if (!regions.has(i.regionId)) problems.push(`${m.id}/${i.id}: unknown region ${i.regionId}`);
      for (const n of m.npcSpots ?? []) if (!has.npc(n.npcId)) problems.push(`${m.id}: npc spot for unknown npc ${n.npcId}`);
      for (const e of m.exits) if (e.condition.type === 'item' && !has.item(e.condition.itemId)) problems.push(`${m.id}/${e.id}: exit needs unknown item ${e.condition.itemId}`);
    }
    expect(problems).toEqual([]);
  });

  it('destinations → raid maps (every raid map is deployable); raid events → maps; weights cover every phase/weather', () => {
    const problems: string[] = [];
    for (const d of content.destinations.values()) {
      const m = content.maps.get(d.mapId);
      if (!m) problems.push(`${d.id}: unknown map ${d.mapId}`);
      else if (m.kind !== 'raid') problems.push(`${d.id}: ${d.mapId} is not a raid map`);
      if (Object.keys(d.timeWeights).sort().join() !== [...content.timePhases.keys()].sort().join()) problems.push(`${d.id}: timeWeights keys`);
      if (Object.keys(d.weatherWeights).sort().join() !== [...content.weathers.keys()].sort().join()) problems.push(`${d.id}: weatherWeights keys`);
    }
    for (const m of raidMaps()) if (![...content.destinations.values()].some((d) => d.mapId === m.id)) problems.push(`${m.id}: no destination deploys to it`);
    for (const e of content.raidEvents.values()) {
      for (const mid of e.mapIds) if (content.maps.get(mid)?.kind !== 'raid') problems.push(`${e.id}: unknown raid map ${mid}`);
      for (const w of Object.keys(e.weatherMult)) if (!content.weathers.has(w as never)) problems.push(`${e.id}: unknown weather ${w}`);
      if (!(e.chance > 0 && e.chance <= 1)) problems.push(`${e.id}: chance ${e.chance}`);
    }
    expect(problems).toEqual([]);
  });

  it('quests → npcs, items, recipes, pois, interactables, quests (acyclic requires) and the chapter main line', () => {
    const problems: string[] = [];
    const chapter = [...content.chapters.values()];
    expect(chapter).toHaveLength(1);
    const ch = chapter[0]!;
    const acts = new Set(ch.acts.map((a) => a.id));
    const roles = new Set([...content.enemies.values()].map((e) => e.role));
    const hitParts = unionMembers('content/types.ts', 'HitPart');
    const objectiveTypes = unionMembers('content/types.ts', 'ObjectiveType');
    const poiIds = new Set(maps().flatMap((m) => m.pois.map((p) => p.id)));
    const interactIds = new Set(maps().flatMap((m) => m.interactables.map((i) => i.id)));
    const nonContentSrc = tsFiles(SRC_DIR).filter((f) => !relSrc(f).startsWith('src/content/')).map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const q of content.quests.values()) {
      if (!has.npc(q.giver)) problems.push(`${q.id}: unknown giver ${q.giver}`);
      for (const r of q.requires) if (!has.quest(r)) problems.push(`${q.id}: requires unknown ${r}`);
      if (!content.questLines.has(q.lineId) || !content.questLines.get(q.lineId)!.quests.includes(q.id)) problems.push(`${q.id}: not listed in its line ${q.lineId}`);
      if (!acts.has(q.act)) problems.push(`${q.id}: act ${q.act} not in ${ch.id}`);
      for (const o of q.objectives) {
        const at = `${q.id}/${o.id} (${o.type})`;
        if (!objectiveTypes.includes(o.type)) problems.push(`${at}: unknown objective type`);
        if (!(o.count >= 1)) problems.push(`${at}: count ${o.count}`);
        if (o.npcId !== undefined && !has.npc(o.npcId)) problems.push(`${at}: unknown npc ${o.npcId}`);
        if (o.mapId !== undefined && !content.maps.has(o.mapId)) problems.push(`${at}: unknown map ${o.mapId}`);
        const t = o.target ?? '';
        if (['Retrieve', 'ExtractWith', 'Deliver'].includes(o.type) && !has.item(t)) problems.push(`${at}: unknown item ${t}`);
        if (o.type === 'Deliver' && o.npcId === undefined) problems.push(`${at}: Deliver without npcId`);
        if (o.type === 'Craft' && !content.recipes.has(t)) problems.push(`${at}: unknown recipe ${t}`);
        if (o.type === 'Visit' && !poiIds.has(t)) problems.push(`${at}: unknown poi ${t}`);
        if (o.type === 'Interact' && !interactIds.has(t)) problems.push(`${at}: unknown interactable ${t}`);
        if (o.type === 'Kill' && !roles.has(t as never)) problems.push(`${at}: unknown enemy role ${t}`);
        if (o.type === 'HitPart' && !hitParts.includes(o.part ?? '')) problems.push(`${at}: unknown hit part ${o.part}`);
        if (o.type === 'WorldFlag' && t.startsWith('building:') && !content.buildings.has(t.slice(9))) problems.push(`${at}: unknown building ${t}`);
        if (o.type === 'CustomValidated' && !nonContentSrc.includes(`'${t}'`)) problems.push(`${at}: custom target '${t}' is never emitted by game code`);
      }
      for (const it of q.rewards.items ?? []) if (!has.item(it.itemId)) problems.push(`${q.id}: reward → unknown item ${it.itemId}`);
      for (const tr of q.rewards.trust ?? []) if (!content.traders.has(tr.traderId)) problems.push(`${q.id}: trust → unknown trader ${tr.traderId}`);
    }
    // requires must be acyclic (every quest is eventually reachable).
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string, trail: string[]): void => {
      if (state.get(id) === 'done' || !has.quest(id)) return;
      if (state.get(id) === 'visiting') {
        problems.push(`requires cycle: ${[...trail, id].join(' → ')}`);
        return;
      }
      state.set(id, 'visiting');
      for (const r of content.quest(id).requires) visit(r, [...trail, id]);
      state.set(id, 'done');
    };
    for (const id of content.quests.keys()) visit(id, []);
    // Chapter main line.
    for (const id of ch.mainLine) if (!has.quest(id)) problems.push(`${ch.id}: main line → unknown quest ${id}`);
    if (ch.mainLine[ch.mainLine.length - 1] !== ch.finalQuest) problems.push(`${ch.id}: finalQuest ${ch.finalQuest} is not the last main-line quest`);
    const mainLines = [...content.questLines.values()].filter((l) => l.quests.join() === ch.mainLine.join());
    if (mainLines.length !== 1) problems.push(`${ch.id}: expected exactly one quest line equal to the main line`);
    for (const q of content.quests.values()) if (mainLines[0] && q.lineId === mainLines[0].id && !ch.mainLine.includes(q.id)) problems.push(`${q.id}: in the main quest line but not in ${ch.id}.mainLine`);
    for (const id of ch.mainLine.slice(1)) {
      const prevIdx = ch.mainLine.indexOf(id) - 1;
      const reqClosure = new Set<string>();
      const stack = [...(content.quests.get(id)?.requires ?? [])];
      while (stack.length) {
        const r = stack.pop()!;
        if (reqClosure.has(r)) continue;
        reqClosure.add(r);
        stack.push(...(content.quests.get(r)?.requires ?? []));
      }
      if (!reqClosure.has(ch.mainLine[prevIdx]!)) problems.push(`${id}: does not (transitively) require the previous main-line quest ${ch.mainLine[prevIdx]}`);
    }
    for (const l of content.questLines.values()) for (const id of l.quests) if (!has.quest(id) || content.quest(id).lineId !== l.id) problems.push(`${l.id}: lists ${id} whose lineId differs or which is unknown`);
    expect(problems).toEqual([]);
  });

  it('traders/NPCs → items (stock) and each other; markets → items; contracts → npcs', () => {
    const problems: string[] = [];
    const kinds = new Set(items().map((d) => d.kind));
    for (const t of content.traders.values()) {
      for (const s of t.stock) {
        if (!has.item(s.itemId)) problems.push(`${t.id}: stock → unknown item ${s.itemId}`);
        if (!(s.qty >= 1 && s.minTrust >= 0)) problems.push(`${t.id}: ${s.itemId} qty/minTrust`);
      }
      for (const k of t.buysKinds) if (!kinds.has(k)) problems.push(`${t.id}: buys unknown kind ${k}`);
      const npcs = [...content.npcs.values()].filter((n) => n.traderId === t.id);
      if (npcs.length !== 1) problems.push(`${t.id}: ${npcs.length} NPCs point at this trader`);
    }
    for (const n of content.npcs.values()) {
      if (!content.traders.has(n.traderId)) problems.push(`${n.id}: unknown trader ${n.traderId}`);
      if (n.greetingKeys.length === 0) problems.push(`${n.id}: no greetings`);
    }
    for (const m of content.markets.values()) {
      for (const p of m.pool) {
        if (!has.item(p.itemId)) problems.push(`${m.id}: pool → unknown item ${p.itemId}`);
        if (!(p.weight > 0 && p.qty[0] >= 1 && p.qty[0] <= p.qty[1] && p.priceMult > 0)) problems.push(`${m.id}: ${p.itemId} weight/qty/price`);
      }
      if (!(m.slots > 0)) problems.push(`${m.id}: slots ${m.slots}`);
    }
    for (const c of content.contracts.values()) {
      if (!has.npc(c.giver)) problems.push(`${c.id}: unknown giver ${c.giver}`);
      if (!(c.rewardCredits[0] <= c.rewardCredits[1] && c.rewardExp[0] <= c.rewardExp[1] && c.minLevel >= 1)) problems.push(`${c.id}: reward ranges / minLevel`);
    }
    expect(problems).toEqual([]);
  });

  it('recipes → items and buildings; buildings/facilities → items and buildings; perks → perks', () => {
    const problems: string[] = [];
    for (const r of content.recipes.values()) {
      if (!['workbench', 'medical'].includes(r.station)) problems.push(`${r.id}: unknown station ${r.station}`);
      if (r.inputs.length === 0) problems.push(`${r.id}: no inputs`);
      for (const i of r.inputs) if (!has.item(i.itemId) || !(i.qty >= 1)) problems.push(`${r.id}: input ${i.itemId} x${i.qty}`);
      if (!has.item(r.output.itemId) || !(r.output.qty >= 1)) problems.push(`${r.id}: output ${r.output.itemId} x${r.output.qty}`);
      if (r.requiresBuilding !== null && !content.buildings.has(r.requiresBuilding)) problems.push(`${r.id}: unknown building ${r.requiresBuilding}`);
    }
    for (const b of content.buildings.values()) {
      for (const c of b.cost.items) if (!has.item(c.itemId) || !(c.qty >= 1)) problems.push(`${b.id}: cost ${c.itemId} x${c.qty}`);
      if (!(b.footprint.w >= 1 && b.footprint.h >= 1)) problems.push(`${b.id}: footprint`);
    }
    for (const f of content.facilities.values()) if (f.requiresBuilding !== null && !content.buildings.has(f.requiresBuilding)) problems.push(`${f.id}: unknown building ${f.requiresBuilding}`);
    for (const p of content.perks.values())
      for (const r of p.requires) {
        const req = content.perks.get(r);
        if (!req) problems.push(`${p.id}: requires unknown perk ${r}`);
        else if (req.line !== p.line || req.level > p.level) problems.push(`${p.id}: requires ${r} from another line or a higher level`);
      }
    expect(problems).toEqual([]);
  });

  it('keys ↔ key items (item.keyId), key doors exist, every key item is placed in a raid container', () => {
    const problems: string[] = [];
    const doorKeys = new Map(maps().flatMap((m) => m.doors.map((d) => [d.id, d.keyId] as const)));
    const containerKeys = new Map(maps().flatMap((m) => m.containers.map((c) => [c.id, c.keyId] as const)));
    const placedKeyItems = new Set(maps().flatMap((m) => m.containers.flatMap((c) => (c.keyItem ? [c.keyItem] : []))));
    for (const k of content.keys.values()) {
      const it = content.items.get(k.itemId);
      if (!it || it.kind !== 'key' || it.keyId !== k.id) problems.push(`${k.id}: item ${k.itemId} is not a key item pointing back (keyId=${it?.keyId})`);
      if (k.doorIds.length + k.containerIds.length === 0) problems.push(`${k.id}: opens nothing`);
      for (const d of k.doorIds) if (doorKeys.get(d) !== k.id) problems.push(`${k.id}: door ${d} missing or locked by ${doorKeys.get(d)}`);
      for (const c of k.containerIds) if (containerKeys.get(c) !== k.id) problems.push(`${k.id}: container ${c} missing or locked by ${containerKeys.get(c)}`);
      if (!placedKeyItems.has(k.itemId)) problems.push(`${k.id}: key item ${k.itemId} is never placed (keyItem) in any container`);
    }
    for (const it of items()) {
      if (it.keyId !== undefined && content.keys.get(it.keyId)?.itemId !== it.id) problems.push(`${it.id}: keyId ${it.keyId} unknown or the key names another item`);
      if (it.kind === 'key' && it.keyId === undefined) problems.push(`${it.id}: key item without keyId`);
    }
    expect(problems).toEqual([]);
  });

  it('notes → maps (each note is placed by a note interactable on its map); interactables → notes/events/npcs', () => {
    const problems: string[] = [];
    const kinds = unionMembers('content/mapTypes.ts', 'InteractableKind');
    for (const n of content.notes.values()) {
      const m = content.maps.get(n.mapId);
      if (!m) problems.push(`${n.id}: unknown map ${n.mapId}`);
      else if (!m.interactables.some((i) => i.kind === 'note' && i.noteId === n.id)) problems.push(`${n.id}: no note interactable on ${n.mapId}`);
    }
    for (const m of maps())
      for (const i of m.interactables) {
        const at = `${m.id}/${i.id}`;
        if (!kinds.includes(i.kind)) problems.push(`${at}: unknown kind ${i.kind}`);
        if (i.kind === 'note' && !(i.noteId && content.notes.get(i.noteId)?.mapId === m.id)) problems.push(`${at}: note ${i.noteId} unknown or on another map`);
        if (i.kind === 'event' && !(i.eventId && content.raidEvents.get(i.eventId)?.mapIds.includes(m.id))) problems.push(`${at}: event ${i.eventId} unknown or inactive on this map`);
        if (i.kind === 'npc' && !(i.npcId && has.npc(i.npcId))) problems.push(`${at}: npc ${i.npcId} unknown`);
        if ((i.kind === 'station' || i.kind === 'range') && !i.stationId) problems.push(`${at}: ${i.kind} without stationId`);
        if (i.noteId !== undefined && !content.notes.has(i.noteId)) problems.push(`${at}: unknown note ${i.noteId}`);
        if (i.eventId !== undefined && !content.raidEvents.has(i.eventId)) problems.push(`${at}: unknown event ${i.eventId}`);
        if (i.npcId !== undefined && !has.npc(i.npcId)) problems.push(`${at}: unknown npc ${i.npcId}`);
      }
    for (const n of content.npcs.values()) if (!maps().some((m) => m.interactables.some((i) => i.kind === 'npc' && i.npcId === n.id))) problems.push(`${n.id}: nobody can talk to this NPC (no npc interactable)`);
    expect(problems).toEqual([]);
  });

  it('weapons → a magazine of the family and caliber (or a tube), ammo of the caliber; attachment slots are valid', () => {
    const problems: string[] = [];
    const slots = unionMembers('content/types.ts', 'AttachmentSlot');
    const calibers = unionMembers('content/types.ts', 'Caliber');
    const attachments = items().filter((d) => d.attachment);
    for (const d of items()) {
      if (d.attachment && !slots.includes(d.attachment.slot)) problems.push(`${d.id}: unknown attachment slot ${d.attachment.slot}`);
      if (d.ammo && !calibers.includes(d.ammo.caliber)) problems.push(`${d.id}: unknown caliber ${d.ammo.caliber}`);
      if (d.magazine && !calibers.includes(d.magazine.caliber)) problems.push(`${d.id}: unknown caliber ${d.magazine.caliber}`);
      const w = d.weapon;
      if (!w) continue;
      if (!calibers.includes(w.caliber)) problems.push(`${d.id}: unknown caliber ${w.caliber}`);
      if (w.magazineFamily !== null) {
        const mags = items().filter((m) => m.magazine?.family === w.magazineFamily && m.magazine.caliber === w.caliber);
        if (mags.length === 0) problems.push(`${d.id}: no magazine of family ${w.magazineFamily} / caliber ${w.caliber}`);
        if (!mags.some((m) => m.magazine!.capacity === w.capacity)) problems.push(`${d.id}: no standard ${w.capacity}-round magazine in family ${w.magazineFamily}`);
      } else if (!(w.tube && w.capacity > 0)) problems.push(`${d.id}: tube-fed weapon without tube timings / capacity`);
      if (!items().some((a) => a.ammo?.caliber === w.caliber)) problems.push(`${d.id}: no ammo of caliber ${w.caliber}`);
      for (const s of w.attachmentSlots) {
        if (!slots.includes(s)) problems.push(`${d.id}: unknown attachment slot ${s}`);
        if (!attachments.some((a) => a.attachment!.slot === s)) problems.push(`${d.id}: no attachment item fits slot ${s}`);
      }
      if (new Set(w.attachmentSlots).size !== w.attachmentSlots.length) problems.push(`${d.id}: duplicate attachment slots`);
      if (w.modes.length === 0) problems.push(`${d.id}: no fire modes`);
    }
    expect(problems).toEqual([]);
  });

  it('every unlock/requirement flag referenced by content is granted by a quest reward or set by game code', () => {
    const granted = new Set<string>();
    for (const q of content.quests.values()) for (const f of q.rewards.flags ?? []) granted.add(f);
    for (const f of tsFiles(SRC_DIR)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bsetFlag\(\s*\w+\s*,\s*'([^']+)'/g)) granted.add(m[1]!);
      for (const m of src.matchAll(/\bflags\[\s*'([^']+)'\s*\]\s*=\s*true/g)) granted.add(m[1]!);
    }
    const required: [string, string][] = [];
    const need = (flag: string | null | undefined, where: string) => {
      if (flag) required.push([flag, where]);
    };
    for (const d of content.destinations.values()) need(d.unlockFlag, d.id);
    for (const t of content.traders.values()) for (const s of t.stock) need(s.requiresFlag, `${t.id}/${s.itemId}`);
    for (const m of content.markets.values()) need(m.unlockFlag, m.id);
    for (const b of content.buildings.values()) need(b.unlockFlag, b.id);
    for (const f of content.facilities.values()) need(f.requiresFlag, f.id);
    for (const r of content.recipes.values()) need(r.requiresFlag, r.id);
    for (const q of content.quests.values()) {
      for (const f of q.requiresFlags ?? []) need(f, q.id);
      for (const o of q.objectives) if (o.type === 'WorldFlag' && !o.target?.startsWith('building:')) need(o.target, `${q.id}/${o.id}`);
    }
    for (const m of maps()) {
      for (const d of m.doors) need(d.powerFlag, `${m.id}/${d.id}`);
      for (const e of m.exits) if (e.condition.type === 'flag') need(e.condition.flag, `${m.id}/${e.id}`);
      for (const g of m.enemyGroups) {
        need(g.requiresFlag, `${m.id}/${g.id}`);
        need(g.unlessFlag, `${m.id}/${g.id}`);
      }
      for (const c of m.containers) for (const q of c.questItems ?? []) need(q.unlessFlag, `${m.id}/${c.id}`);
    }
    expect(required.length).toBeGreaterThan(10);
    expect(required.filter(([f]) => !granted.has(f)).map(([f, w]) => `${f} (needed by ${w})`)).toEqual([]);
  });
});

// --- (c) spec counts -----------------------------------------------------------------------------------------------

describe('(c) Chapter 1 spec counts', () => {
  it('exactly 12 weapons with the spec ids', () => {
    const weapons = items().filter((d) => d.kind === 'weapon').map((d) => d.id).sort();
    const expected = ['p9', 'h45', 'sm9', 'sm45', 'c556', 'ar556', 'ar762', 'sgp', 'sga', 'dmr', 'bolt', 'lmg'].map((k) => `core.weapon.${k}`).sort();
    expect(weapons).toEqual(expected);
  });

  it('2 raid maps with ≥4/≥3 and ≥2/≥1 regions/interiors (totals ≥6 regions, ≥4 interiors)', () => {
    expect(raidMaps().map((m) => m.id).sort()).toEqual(['core.map.outer_supply_route', 'core.map.quarantine_main']);
    const main = content.map('core.map.quarantine_main');
    const outer = content.map('core.map.outer_supply_route');
    expect(main.regions.length).toBeGreaterThanOrEqual(4);
    expect(main.interiors.length).toBeGreaterThanOrEqual(3);
    expect(outer.regions.length).toBeGreaterThanOrEqual(2);
    expect(outer.interiors.length).toBeGreaterThanOrEqual(1);
    expect(main.regions.length + outer.regions.length).toBeGreaterThanOrEqual(6);
    expect(main.interiors.length + outer.interiors.length).toBeGreaterThanOrEqual(4);
  });

  it('each raid map has ≥1 free exit and ≥1 conditional exit', () => {
    for (const m of raidMaps()) {
      expect(m.exits.filter((e) => e.condition.type === 'free').length, `${m.id} free exits`).toBeGreaterThanOrEqual(1);
      expect(m.exits.filter((e) => e.condition.type !== 'free').length, `${m.id} conditional exits`).toBeGreaterThanOrEqual(1);
    }
  });

  it('enemy roles: sentry, flanker, rusher, marksman + boss (support allowed), and the boss is placed in a raid map', () => {
    const roles = new Set<string>([...content.enemies.values()].map((e) => e.role));
    for (const r of ['sentry', 'flanker', 'rusher', 'marksman', 'boss']) expect(roles.has(r), r).toBe(true);
    expect([...roles].filter((r) => !['sentry', 'flanker', 'rusher', 'marksman', 'boss', 'support'].includes(r))).toEqual([]);
    expect(raidMaps().some((m) => m.enemyGroups.some((g) => g.boss && g.archetypes.some((a) => content.enemy(a.id).role === 'boss')))).toBe(true);
  });

  it('8 quests Q01–Q08', () => {
    const qs = [...content.quests.values()];
    expect(qs).toHaveLength(8);
    const nums = qs.map((q) => /^core\.quest\.q0([1-8])_/.exec(q.id)?.[1]).sort();
    expect(nums).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    for (const q of qs) expect(content.t(q.nameKey).startsWith(`Q0${/q0(\d)_/.exec(q.id)![1]}`), q.id).toBe(true);
  });

  it('3 NPCs / 3 traders, 6 contract templates (6 types), 3 raid events', () => {
    expect(content.npcs.size).toBe(3);
    expect(content.traders.size).toBe(3);
    expect(content.contracts.size).toBe(6);
    expect(new Set([...content.contracts.values()].map((c) => c.type)).size).toBe(6);
    expect(content.raidEvents.size).toBe(3);
  });

  it('12 perks = 3 lines × 4', () => {
    expect(content.perks.size).toBe(12);
    const byLine = new Map<string, number>();
    for (const p of content.perks.values()) byLine.set(p.line, (byLine.get(p.line) ?? 0) + 1);
    expect(Object.fromEntries(byLine)).toEqual({ survival: 4, carry: 4, combat: 4 });
  });

  it('4 buildings + 3 facilities, ≥6 recipes, ≥8 notes, ≥3 keys', () => {
    expect(content.buildings.size).toBe(4);
    expect(content.facilities.size).toBe(3);
    expect(content.recipes.size).toBeGreaterThanOrEqual(6);
    expect(content.notes.size).toBeGreaterThanOrEqual(8);
    expect(content.keys.size).toBeGreaterThanOrEqual(3);
  });

  it('weather Clear/Cloudy/Rain/Storm and time phases Day/Dusk/Night', () => {
    expect([...content.weathers.keys()].sort()).toEqual(['Clear', 'Cloudy', 'Rain', 'Storm']);
    expect([...content.timePhases.keys()].sort()).toEqual(['Day', 'Dusk', 'Night']);
  });
});

// --- (d) localization ----------------------------------------------------------------------------------------------

const HANGUL = /[\uAC00-\uD7A3]/;

/**
 * Registered strings that intentionally contain no Hangul. Anything else without Hangul fails.
 *   - game.subtitle: the English brand line printed under the Korean title (design choice).
 *   - prompt.key: the key-cap glyph "E" of the interaction prompt.
 *   - cal.9 / cal.45 / cal.556: caliber designations are proper codes (9mm, .45 ACP, 5.56mm); the other
 *     calibers carry a Korean gloss and are therefore not exempt. Item names such as "P9 경량 권총" contain Hangul.
 */
const NON_HANGUL_ALLOWLIST = ['game.subtitle', 'prompt.key', 'cal.9', 'cal.45', 'cal.556'];

describe('(d) localization', () => {
  it('every *Key / *Keys field of every definition resolves with registry.has()', () => {
    const refs: { key: string; path: string; prop: string }[] = [];
    for (const [table, map] of registryTables())
      for (const [id, def] of map)
        walk(
          def,
          (prop, v, path) => {
            if (/Key$/.test(prop) && typeof v === 'string') refs.push({ key: v, path, prop });
            if (/Keys$/.test(prop) && Array.isArray(v)) v.forEach((k, i) => typeof k === 'string' && refs.push({ key: k, path: `${path}[${i}]`, prop }));
          },
          `${table}[${id}]`,
        );
    // The walker must really reach every kind of key field named by the spec.
    const props = new Set(refs.map((r) => r.prop));
    for (const p of ['nameKey', 'descKey', 'titleKey', 'bodyKey', 'roleKey', 'greetingKeys', 'completeDialogKey', 'labelKey', 'hintKey', 'captionKey', 'durationHintKey']) expect(props.has(p), p).toBe(true);
    expect(refs.length).toBeGreaterThan(400);
    expect(refs.filter((r) => !content.has(r.key)).map((r) => `${r.path} = ${r.key}`)).toEqual([]);
    console.info(`[l10n] definition key fields checked: ${refs.length} (${[...props].sort().join(', ')})`);
  });

  it('every registered string is non-empty, uncorrupted and contains Hangul (documented exemptions only)', () => {
    const empty: string[] = [];
    const corrupt: string[] = [];
    const nonHangul: string[] = [];
    for (const [k, v] of content.strings) {
      if (v.trim().length === 0) empty.push(k);
      // U+FFFD / control characters indicate an encoding accident (e.g. a non-UTF-8 rewrite of a source file).
      if (/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(v) || v.includes('⟦')) corrupt.push(k);
      if (!HANGUL.test(v)) nonHangul.push(k);
    }
    expect(empty).toEqual([]);
    expect(corrupt).toEqual([]);
    expect(nonHangul.filter((k) => !NON_HANGUL_ALLOWLIST.includes(k))).toEqual([]);
    for (const k of NON_HANGUL_ALLOWLIST) {
      expect(content.has(k), k).toBe(true);
      expect(content.t(k), k).toMatch(/^[\x20-\x7E—]+$/);
    }
    console.info(`[l10n] strings checked: ${content.strings.size}, without Hangul: ${nonHangul.length} (${nonHangul.join(', ')})`);
  });

  it('template keys built in code are registered (cal/bus/action/tag/range.preset/act + firemode/med/enemy)', () => {
    const missing: string[] = [];
    const need = (key: string, why: string) => {
      if (!content.has(key)) missing.push(`${key} (${why})`);
    };
    const calibers = new Set<string>();
    for (const d of items()) {
      if (d.weapon) calibers.add(d.weapon.caliber);
      if (d.ammo) calibers.add(d.ammo.caliber);
    }
    for (const c of calibers) need(`cal.${c}`, 'ui/adapters.ts caliber row');
    for (const b of AUDIO_BUSES) need(`bus.${b}`, 'settings volume slider');
    for (const a of ACTIONS) need(`action.${a}`, 'key rebinding list');
    const precisionTags = constStringArray('progression/contracts.ts', 'PRECISION_TAGS');
    expect(precisionTags.length).toBeGreaterThan(0);
    for (const t of precisionTags) {
      need(`tag.${t}`, 'precision contract {tag}');
      if (!items().some((d) => d.weapon && d.tags.includes(t))) missing.push(`precision tag ${t} is carried by no weapon`);
    }
    for (const p of RANGE_PRESETS) need(`range.preset.${p}`, 'range terminal');
    const ch = content.chapters.get('core.chapter.1')!;
    for (const a of ch.acts) {
      need(`act.${a.id}.name`, 'save-slot act label');
      need(`act.${a.id}.desc`, 'chapter panel');
      if (a.nameKey !== `act.${a.id}.name`) missing.push(`act ${a.id} nameKey ${a.nameKey} ≠ act.${a.id}.name (ui.ts builds the key from the act number)`);
    }
    for (const q of content.quests.values()) need(`act.${Math.min(5, q.act)}.name`, `${q.id} act`);
    for (const m of new Set(items().flatMap((d) => d.weapon?.modes ?? []))) need(`firemode.${m}`, 'fire-mode toggle message');
    for (const r of unionMembers('world/medical.ts', 'UseResult').filter((r) => r !== 'started')) need(`med.${r}`, 'startMedical failure message');
    for (const role of new Set([...content.enemies.values()].map((e) => e.role))) need(`enemy.${role}`, 'hunt contract {role}');
    expect(missing).toEqual([]);
  });

  it('literal scanner self-test: nested templates, comments, regex literals and escapes', () => {
    const src = [
      "// fail('comment.line') is ignored",
      "/* t('comment.block') */ const re = /['\"`]/g; const half = a / 2;",
      "fail('a.real'); x = `tpl ${this.content.t('in.nested')} ${`${T(u, 'deep.er')}`}`;",
      "const q = 'it\\'s'; const r = y / z; toast(\"dq.key\");",
    ].join('\n');
    const lits = new LiteralScanner('synthetic.ts', src).literals;
    const values = lits.map((l) => l.value);
    expect(values).toContain('a.real');
    expect(values).toContain('in.nested');
    expect(values).toContain('deep.er');
    expect(values).toContain("it's");
    expect(values).toContain('dq.key');
    expect(values.some((v) => v.startsWith('comment.'))).toBe(false);
    // Lines 1–2 hold only comments, a regex literal containing quotes and a division: no string literal at all.
    expect(lits.filter((l) => l.line <= 2)).toEqual([]);
    expect(lits.find((l) => l.value === 'a.real')!.before).toMatch(/\bfail\(\s*$/);
    expect(lits.find((l) => l.value === 'in.nested')!.before).toMatch(/\bt\(\s*$/);
    expect(lits.find((l) => l.value === 'deep.er')!.before).toMatch(/\bT\(\s*u\s*,\s*$/);
    expect(lits.find((l) => l.value === 'dq.key')!.line).toBe(4);
    expect(lits.filter((l) => l.interpolated)).toHaveLength(2);
  });

  it('every literal localization key used in src/**/*.ts is registered (known ids excluded via the registry)', () => {
    const ids = knownIds();
    const namespaces = new Set([...content.strings.keys()].map((k) => k.split('.')[0]!));
    const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
    /** Call sites whose string argument is always a localization key. `key:` and `reason:` are overloaded
     * (weapon-row keys like 'p9', ballistic candidate key 'g', item-ledger reasons like 'grant', the TxOutcome
     * sentinels 'duplicate'/'no-profile' that are never passed to t()), so only dotted literals count there. */
    const CONTEXTS: { name: string; re: RegExp; dottedOnly: boolean }[] = [
      { name: "t('…')", re: /\bt\(\s*$/, dottedOnly: false },
      { name: "T(u, '…')", re: /\bT\(\s*[\w$.]+\s*,\s*$/, dottedOnly: false },
      { name: "fail('…')", re: /\bfail\(\s*$/, dottedOnly: false },
      { name: "…Key: '…'", re: /\b\w*Key\s*(?:===?|!==?|:|=)\s*$/, dottedOnly: false },
      { name: "error: '…'", re: /\berror\s*:\s*$/, dottedOnly: false },
      { name: "key: '…'", re: /\bkey\s*:\s*$/, dottedOnly: true },
      { name: "reason: '…'", re: /\breason\s*:\s*$/, dottedOnly: true },
    ];
    const files = tsFiles(SRC_DIR);
    const perContext = new Map<string, number>();
    const unresolved: string[] = [];
    let literals = 0;
    let candidates = 0;
    let asIds = 0;
    const contextsByValue = new Map<string, Set<string>>();
    for (const f of files) {
      for (const lit of new LiteralScanner(relSrc(f), readFileSync(f, 'utf8')).literals) {
        literals++;
        if (lit.interpolated || !KEY_SHAPE.test(lit.value)) continue;
        const dotted = lit.value.includes('.');
        const why: string[] = [];
        for (const c of CONTEXTS) if (c.re.test(lit.before) && (dotted || !c.dottedOnly)) why.push(c.name);
        if (dotted && namespaces.has(lit.value.split('.')[0]!)) why.push('namespace');
        if (why.length === 0) continue;
        candidates++;
        for (const w of why) perContext.set(w, (perContext.get(w) ?? 0) + 1);
        const seen = contextsByValue.get(lit.value) ?? new Set<string>();
        for (const w of why) seen.add(w);
        contextsByValue.set(lit.value, seen);
        if (content.has(lit.value)) continue;
        if (ids.has(lit.value)) {
          asIds++;
          continue;
        }
        unresolved.push(`${lit.file}:${lit.line} '${lit.value}' [${why.join(', ')}]`);
      }
    }
    // Scanner self-check: known call sites of every context kind must be found.
    const hit = (ctx: string, key: string) => contextsByValue.get(key)?.has(ctx) ?? false;
    expect(hit("fail('…')", 'trade.err.money')).toBe(true);
    expect(hit("t('…')", 'save.recovered')).toBe(true);
    expect(hit("t('…')", 'toast.discovered')).toBe(true); // nested inside a template literal's ${…}
    expect(hit("T(u, '…')", 'range.rack.title')).toBe(true);
    expect(hit("…Key: '…'", 'prompt.door.no_power')).toBe(true);
    expect(hit("error: '…'", 'inv.err.overweight')).toBe(true);
    expect(hit("key: '…'", 'boss.support')).toBe(true);
    expect(hit('namespace', 'save.err.quota')).toBe(true);
    expect(hit("t('…')", 'core.loot.farm_food')).toBe(true); // loot.ts's local t() builder: excluded as a known id
    expect(files.length).toBeGreaterThan(80);
    expect(unresolved).toEqual([]);
    console.info(`[l10n] source scan: ${files.length} files, ${literals} literals, ${candidates} key candidates (${[...perContext].map(([k, v]) => `${k}=${v}`).join(', ')}), ${asIds} excluded as known ids, ${ids.size} ids in the id set`);
  });
});

// --- (e) maps ------------------------------------------------------------------------------------------------------

describe('(e) map sanity', () => {
  /** Doors in their authored start state (the state createRaidSim/createBaseSim start from). */
  const startState = (m: MapDef): DynamicState => ({ doors: Object.fromEntries(m.doors.map((d) => [d.id, { open: d.startOpen, locked: false }])), obstacleHp: {}, smokes: [], time: 0 });
  const circleOverlapsBox = (x: number, y: number, r: number, b: { x0: number; y0: number; x1: number; y1: number }) => {
    const cx = Math.max(b.x0, Math.min(x, b.x1));
    const cy = Math.max(b.y0, Math.min(y, b.y1));
    return (x - cx) ** 2 + (y - cy) ** 2 < r * r - 1e-9;
  };
  const inside = (m: MapDef, x: number, y: number) => x >= 0 && y >= 0 && x <= m.width && y <= m.height;

  it('ground array length = width × height for every map', () => {
    for (const m of maps()) expect(m.ground.length, m.id).toBe(m.width * m.height);
  });

  it('player spawns are inside the bounds and the player body overlaps no movement blocker', () => {
    const radius = newActor('probe', 'player', 0, 0, 100, 'player').radius;
    const problems: string[] = [];
    let n = 0;
    for (const m of maps()) {
      expect(m.playerSpawns.length, m.id).toBeGreaterThan(0);
      const geo = new WorldGeometry(m, content);
      const dyn = startState(m);
      for (const sp of m.playerSpawns) {
        n++;
        if (!(sp.x - radius >= 0 && sp.y - radius >= 0 && sp.x + radius <= m.width && sp.y + radius <= m.height)) problems.push(`${m.id}: spawn (${sp.x}, ${sp.y}) outside the bounds`);
        const hits = geo.movementBlockers(sp.x, sp.y, radius, 0, dyn).filter((o) => circleOverlapsBox(sp.x, sp.y, radius, o.box));
        if (hits.length) problems.push(`${m.id}: spawn (${sp.x}, ${sp.y}) overlaps ${hits.map((o) => `${o.id} [${o.profile.id}]`).join(', ')}`);
      }
    }
    expect(problems).toEqual([]);
    console.info(`[maps] player spawns checked: ${n} (body radius ${radius}u)`);
  });

  it('exits are non-empty rectangles inside the bounds', () => {
    const problems: string[] = [];
    for (const m of maps())
      for (const e of m.exits) if (!(e.w > 0 && e.h > 0 && e.x >= 0 && e.y >= 0 && e.x + e.w <= m.width && e.y + e.h <= m.height)) problems.push(`${m.id}/${e.id}: (${e.x}, ${e.y}, ${e.w}×${e.h}) outside ${m.width}×${m.height}`);
    expect(problems).toEqual([]);
  });

  it('containers, interactables, POIs, enemy spawn/patrol points and notes lie inside their map', () => {
    const problems: string[] = [];
    for (const m of maps()) {
      const pts: [string, number, number][] = [
        ...m.containers.map((c) => [`container ${c.id}`, c.x, c.y] as [string, number, number]),
        ...m.interactables.map((i) => [`interactable ${i.id}`, i.x, i.y] as [string, number, number]),
        ...m.pois.map((p) => [`poi ${p.id}`, p.x, p.y] as [string, number, number]),
        ...m.enemyGroups.flatMap((g) => [...g.points, ...g.patrol].map((p) => [`group ${g.id}`, p.x, p.y] as [string, number, number])),
      ];
      for (const [what, x, y] of pts) if (!inside(m, x, y)) problems.push(`${m.id}: ${what} at (${x}, ${y})`);
    }
    for (const n of content.notes.values()) {
      const m = content.maps.get(n.mapId);
      if (m && !inside(m, n.x, n.y)) problems.push(`${n.id} at (${n.x}, ${n.y}) outside ${n.mapId}`);
    }
    expect(problems).toEqual([]);
  });
});
