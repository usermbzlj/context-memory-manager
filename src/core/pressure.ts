import type { PressureReading, StrategyPreset } from '../types.js';

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Adaptive context-pressure monitor (PRD §10, §12).
 *
 * Pressure is NOT a hardcoded "used / window > 70%" rule. It blends three
 * live signals into a single 0..1 score:
 *
 *   pressure = clamp(0.55 * usedRatio + 0.25 * growthScore + 0.20 * hotScore)
 *
 * - usedRatio   = usedTokens / contextWindow — how full the host window is.
 * - growthScore = min(1, growthPerTurn / (5% of window)) — how fast the
 *                 window is filling per turn; anticipates pressure before
 *                 the window is actually full.
 * - hotScore    = min(1, hotTokens / (30% of window)) — how much of the
 *                 window our managed HOT events occupy.
 *
 * A tidy pass starts when pressure >= preset.trigger (the trigger itself is
 * strategy-dependent: conservative 0.8 / balanced 0.65 / aggressive 0.5),
 * and stops once pressure falls below preset.release.
 */
export class PressureMonitor {
  constructor(private readonly preset: StrategyPreset) {}

  compute(input: {
    contextWindow: number;
    usedTokens: number;
    hotTokens: number;
    capsuleTokens: number;
    growthPerTurn: number;
    turnsSinceTidy: number;
  }): PressureReading {
    const usedRatio = input.usedTokens / Math.max(1, input.contextWindow);
    const growthScore = Math.min(
      1,
      input.growthPerTurn / Math.max(1, input.contextWindow * 0.05),
    );
    const hotScore = Math.min(
      1,
      input.hotTokens / Math.max(1, input.contextWindow * 0.3),
    );
    const pressure = clamp(
      Math.max(usedRatio, 0.55 * usedRatio + 0.25 * growthScore + 0.2 * hotScore),
      0,
      1,
    );
    const shouldTidy = pressure >= this.preset.trigger;
    const details: Record<string, number> = {
      usedRatio,
      growthScore,
      hotScore,
      usedTokens: input.usedTokens,
      contextWindow: input.contextWindow,
      hotTokens: input.hotTokens,
      capsuleTokens: input.capsuleTokens,
      growthPerTurn: input.growthPerTurn,
      turnsSinceTidy: input.turnsSinceTidy,
      trigger: this.preset.trigger,
      release: this.preset.release,
    };
    return {
      pressure,
      trigger: this.preset.trigger,
      release: this.preset.release,
      shouldTidy,
      details,
    };
  }
}
