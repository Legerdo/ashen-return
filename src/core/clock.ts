/**
 * 60 Hz fixed-step simulation clock. Rendering calls advance() with real elapsed time; the
 * simulation only ever sees SIM_DT steps. Paused/hidden clocks do not accumulate time.
 */
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

export interface ClockAdvanceResult {
  steps: number;
  /** Interpolation factor between the previous and current simulation state, for rendering only. */
  alpha: number;
  droppedSeconds: number;
}

export class FixedStepClock {
  accumulator = 0;
  tick = 0;
  paused = false;
  hidden = false;
  /** Guards against the spiral of death after long stalls; excess time is dropped, not simulated. */
  maxStepsPerAdvance = 10;
  maxFrameSeconds = 0.25;
  timeScale = 1;

  get simTime(): number {
    return this.tick * SIM_DT;
  }

  get running(): boolean {
    return !this.paused && !this.hidden;
  }

  advance(realDtSeconds: number, step: (dt: number, tick: number) => void): ClockAdvanceResult {
    if (!this.running || !Number.isFinite(realDtSeconds) || realDtSeconds <= 0) {
      return { steps: 0, alpha: this.accumulator / SIM_DT, droppedSeconds: 0 };
    }
    let dropped = 0;
    let dt = realDtSeconds * this.timeScale;
    if (dt > this.maxFrameSeconds) {
      dropped += dt - this.maxFrameSeconds;
      dt = this.maxFrameSeconds;
    }
    this.accumulator += dt;
    let steps = 0;
    // Small epsilon avoids losing a step to floating point error at exact multiples.
    while (this.accumulator + 1e-9 >= SIM_DT && steps < this.maxStepsPerAdvance) {
      this.accumulator -= SIM_DT;
      if (this.accumulator < 0) this.accumulator = 0;
      this.tick++;
      step(SIM_DT, this.tick);
      steps++;
    }
    if (steps >= this.maxStepsPerAdvance && this.accumulator >= SIM_DT) {
      dropped += this.accumulator;
      this.accumulator = 0;
    }
    return { steps, alpha: Math.min(1, this.accumulator / SIM_DT), droppedSeconds: dropped };
  }

  /** Run exactly one step (debug single-tick). */
  stepOnce(step: (dt: number, tick: number) => void): void {
    this.tick++;
    step(SIM_DT, this.tick);
  }

  reset(tick = 0): void {
    this.tick = tick;
    this.accumulator = 0;
  }
}
