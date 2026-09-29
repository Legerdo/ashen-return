import Phaser from 'phaser';
import './ui/styles.css';
import { createContent } from './content/core';
import { GameApp } from './game/app';
import { AudioEngine } from './presentation/audio';
import { InputManager } from './presentation/input';
import { SoundDirector } from './presentation/soundDirector';
import { Viewport } from './presentation/viewport';
import { WorldScene } from './presentation/worldScene';
import { defaultSettings, type Settings } from './progression/profile';
import { SaveStore } from './save/saveStore';
import { UIRoot } from './ui/ui';

type BootWindow = Window & { __BOOTED__?: boolean; __BOOT_ERROR__?: string };

function fatal(msg: string): void {
  const layer = document.getElementById('ui-layer');
  if (!layer) return;
  const box = document.createElement('div');
  box.className = 'overlay';
  box.setAttribute('role', 'alert');
  box.innerHTML = '<div class="panel narrow"><div class="panel-head"><h2>시작할 수 없습니다</h2></div><div class="panel-body"></div></div>';
  box.querySelector('.panel-body')!.textContent = msg;
  layer.replaceChildren(box);
}

async function boot(): Promise<void> {
  const w = window as BootWindow;
  const content = createContent();
  const store = new SaveStore();
  try {
    await store.open();
  } catch (e) {
    w.__BOOT_ERROR__ = String(e);
    fatal(`이 브라우저에서 IndexedDB 저장소를 열 수 없습니다. 사생활 보호(시크릿) 모드이거나 저장소가 차단되어 있을 수 있습니다.\n(${String(e)})`);
    return;
  }
  const saved = await store.getMeta<Partial<Settings>>('settings').catch(() => null);
  const d = defaultSettings();
  const settings: Settings = { ...d, ...(saved ?? {}), volumes: { ...d.volumes, ...(saved?.volumes ?? {}) }, bindings: { ...(saved?.bindings ?? {}) } };

  const frameEl = document.getElementById('game-frame')!;
  const input = new InputManager(frameEl);
  input.attach();
  const audio = new AudioEngine(content, settings.volumes);
  const viewport = new Viewport();
  const app = new GameApp(content, store, input, audio, () => viewport.rect(), settings);
  app.applySettings();
  const sound = new SoundDirector(audio);
  app.onSound = (ctx, e) => sound.handle(ctx, e);
  const ui = new UIRoot(app, store);

  // Autoplay policy: the AudioContext is created/resumed on the first user gesture only.
  const unlock = () => {
    const was = audio.unlocked;
    audio.unlock();
    if (!was && audio.unlocked) app.resyncAudio();
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });

  // Browser lifecycle: auxiliary checkpoint signals only (every profile change is already committed transactionally).
  document.addEventListener('visibilitychange', () => {
    audio.setHidden(document.hidden);
    if (document.hidden) {
      input.releaseAll();
      if (app.mode === 'raid') void app.checkpointRaid();
    }
  });
  window.addEventListener('pagehide', () => {
    if (app.mode === 'raid') void app.checkpointRaid();
  });

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    width: 640,
    height: 360,
    parent: 'game-canvas-host',
    pixelArt: true,
    roundPixels: true,
    antialias: false,
    backgroundColor: '#0d0e11',
    banner: false,
    // DOM layers own input and WebAudio owns sound (rebinding, focus rules and 8-bus routing).
    input: { keyboard: false, mouse: false, touch: false, gamepad: false },
    audio: { noAudio: true },
    scale: { mode: Phaser.Scale.NONE },
  });
  game.scene.add('world', WorldScene, true, { host: app });
  const attach = () => {
    viewport.attach(game.canvas);
    game.canvas.setAttribute('aria-hidden', 'true');
  };
  if (game.canvas) attach();
  else game.events.once('ready', attach);

  app.mode = 'title';
  await ui.refreshSlots();

  if (import.meta.env.DEV || __E2E__) {
    const hooks = await import('./game/testHooks');
    hooks.installTestHooks(app, store);
  }
  w.__BOOTED__ = true;
}

void boot().catch((e) => {
  (window as BootWindow).__BOOT_ERROR__ = String(e);
  console.error(e);
  fatal(`초기화 중 오류가 발생했습니다: ${String(e)}`);
});
