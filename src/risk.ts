import { config } from "./config";

/**
 * Rule 6 — Daily Risk Control.
 *   One loss in a day => shut down trading immediately. Resume only after a new
 *   day (and, in spirit, after analysis — we surface that in the log).
 *
 * "Day" is the ET calendar day, to align with Rule 5's US session framing.
 */
export class RiskGate {
  private lossesToday = 0;
  private currentDay = "";
  private halted = false;

  private etDay(nowMsUtc: number): string {
    return new Date(nowMsUtc).toLocaleDateString("en-US", { timeZone: "America/New_York" });
  }

  private rollIfNewDay(nowMsUtc: number) {
    const d = this.etDay(nowMsUtc);
    if (d !== this.currentDay) {
      this.currentDay = d;
      this.lossesToday = 0;
      this.halted = false;
    }
  }

  /** call before considering a trade */
  canTrade(nowMsUtc: number): { ok: boolean; reason: string } {
    this.rollIfNewDay(nowMsUtc);
    if (this.halted)
      return { ok: false, reason: `halted: ${this.lossesToday} loss(es) today; analyze before resuming` };
    return { ok: true, reason: `ok (${this.lossesToday} losses today)` };
  }

  /** call when a settled trade's outcome is known */
  recordOutcome(won: boolean, nowMsUtc: number) {
    this.rollIfNewDay(nowMsUtc);
    if (!won) {
      this.lossesToday += 1;
      if (this.lossesToday >= config.maxLossesPerDay) {
        this.halted = true;
        console.log(
          `[risk] LOSS recorded (${this.lossesToday}/${config.maxLossesPerDay}). Trading HALTED for the day.`
        );
      }
    }
  }

  isHalted(nowMsUtc: number): boolean {
    this.rollIfNewDay(nowMsUtc);
    return this.halted;
  }
}