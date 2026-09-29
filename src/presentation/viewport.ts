import { computeCanvasLayout, type CanvasLayout, type DisplayRect } from '../core/coords';

/**
 * Keeps the 640×360 backing canvas at an integer physical-pixel scale with letterboxing.
 * The DOM UI layer is separate (native resolution) so Korean text stays crisp.
 */
export class Viewport {
  layout: CanvasLayout = computeCanvasLayout(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  private canvas: HTMLCanvasElement | null = null;
  /** TUNABLE: DPR cap for any high-resolution overlay canvases (the world backing is fixed 640×360). */
  static readonly MAX_DPR = 2;

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    canvas.style.position = 'absolute';
    canvas.style.imageRendering = 'pixelated';
    this.apply();
    window.addEventListener('resize', () => this.apply());
    document.addEventListener('fullscreenchange', () => this.apply());
    // DPR changes (moving between monitors / browser zoom).
    const watch = () => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener('change', () => {
        this.apply();
        watch();
      }, { once: true });
    };
    watch();
  }

  apply(): void {
    if (!this.canvas) return;
    this.layout = computeCanvasLayout(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    const s = this.canvas.style;
    s.width = `${this.layout.cssWidth}px`;
    s.height = `${this.layout.cssHeight}px`;
    s.left = `${this.layout.cssLeft}px`;
    s.top = `${this.layout.cssTop}px`;
    document.documentElement.style.setProperty('--world-scale', String(this.layout.cssWidth / 640));
    document.documentElement.style.setProperty('--world-left', `${this.layout.cssLeft}px`);
    document.documentElement.style.setProperty('--world-top', `${this.layout.cssTop}px`);
    document.documentElement.style.setProperty('--world-w', `${this.layout.cssWidth}px`);
    document.documentElement.style.setProperty('--world-h', `${this.layout.cssHeight}px`);
  }

  rect(): DisplayRect {
    if (!this.canvas) return { left: 0, top: 0, width: 640, height: 360 };
    const r = this.canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
}
