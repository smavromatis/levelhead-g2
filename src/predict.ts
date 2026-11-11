/**
 * Look-ahead for one motion signal.
 *
 * A picture is seen a few hundred milliseconds after the sensor reading it
 * came from, so it is drawn for where the motion will be by then. Boat motion
 * is close to a sum of slow sine waves and forecasts well from its last
 * second, using an autoregressive model re-fitted on every sample.
 *
 * A sample the model did not expect (a head movement) turns forecasting off
 * until the model's window has refilled, and predicted change is rate-capped.
 */

export interface PredictorOptions {
  /** Model order: how many past samples predict the next. */
  order?: number
  /** Forgetting factor of the fit; nearer 1 = longer memory. */
  memory?: number
  /** How much of each new sample to accept over the model's own forecast. */
  blend?: number
  /** A surprise this many times the usual one counts as a jolt... */
  joltRatio?: number
  /** ...provided it is also at least this big, in the signal's units. */
  joltFloor: number
  /** Fastest believable change, in units per second. */
  maxRate: number
}

export class Predictor {
  private readonly p: number
  private readonly memory: number
  private readonly blend: number
  private readonly joltRatio: number
  private readonly joltFloor: number
  private readonly maxRate: number

  private coef: number[]
  private cov: number[][]
  private hist: number[] = []
  private est = 0
  private usual = 0
  private cooldown = 0
  private trust = 0

  constructor(o: PredictorOptions) {
    this.p = o.order ?? 10
    this.memory = o.memory ?? 0.998
    this.blend = o.blend ?? 0.5
    this.joltRatio = o.joltRatio ?? 4
    this.joltFloor = o.joltFloor
    this.maxRate = o.maxRate
    this.coef = []
    this.cov = []
    this.reset()
  }

  reset(): void {
    const p = this.p
    this.coef = new Array<number>(p).fill(0)
    this.cov = Array.from({ length: p }, (_, i) =>
      Array.from({ length: p }, (_, j) => (i === j ? 1000 : 0)),
    )
    this.hist = []
    this.est = 0
    this.usual = 0
    this.cooldown = 0
    this.trust = 0
  }

  /** One-step forecast from the last `p` values of `w`. */
  private step(w: number[]): number {
    let y = 0
    for (let i = 0; i < this.p; i++) y += this.coef[i] * w[w.length - 1 - i]
    return y
  }

  /** Feed the newest sample. Samples are assumed evenly spaced. */
  push(y: number): void {
    const { p, hist } = this
    if (hist.length < p) {
      hist.push(y)
      this.est = y
      return
    }
    const forecast = this.step(hist)
    const surprise = y - forecast
    const size = Math.abs(surprise)
    const jolt = size > this.joltFloor && size > this.joltRatio * this.usual

    if (jolt) {
      // Not swell. Believe the sample, and stop extrapolating until the
      // window no longer straddles the jump.
      this.cooldown = p + 2
      this.trust = 0
      this.est = y
    } else {
      this.usual += (size - this.usual) * 0.02
      if (this.cooldown > 0) {
        this.cooldown--
        this.est = y
      } else {
        this.trust = Math.min(1, this.trust + 0.1)
        this.est = forecast + this.blend * surprise
        this.fit(surprise)
      }
    }
    hist.push(y)
    if (hist.length > p + 4) hist.shift()
  }

  /** Recursive least squares update of the model. */
  private fit(error: number): void {
    const { p, hist, cov, memory } = this
    const x = new Array<number>(p)
    for (let i = 0; i < p; i++) x[i] = hist[hist.length - 1 - i]
    const px = cov.map((row) => row.reduce((s, a, j) => s + a * x[j], 0))
    const denom = memory + x.reduce((s, a, i) => s + a * px[i], 0)
    if (!(denom > 1e-9)) return
    const gain = px.map((a) => a / denom)
    for (let i = 0; i < p; i++) {
      this.coef[i] += gain[i] * error
      for (let j = 0; j < p; j++) cov[i][j] = (cov[i][j] - gain[i] * px[j]) / memory
    }
    if (!this.coef.every(Number.isFinite)) this.reset()
  }

  /**
   * Best estimate of the signal `aheadS` seconds from the newest sample,
   * given how far apart samples are arriving.
   */
  at(aheadS: number, samplePeriodS = 0.1): number {
    const { p, hist, est } = this
    if (aheadS <= 0 || hist.length < p) return est
    const limit = this.maxRate * aheadS
    if (this.trust === 0) {
      // Not forecasting (the head just moved). Carry on in a straight line
      // from the last two samples so the picture keeps gliding between them.
      const rate = (hist[hist.length - 1] - hist[hist.length - 2]) / Math.max(samplePeriodS, 0.02)
      return est + Math.max(-limit, Math.min(limit, rate * Math.min(aheadS, 0.3)))
    }
    const w = hist.slice(-p)
    w[p - 1] = est
    const steps = aheadS / Math.max(samplePeriodS, 0.02)
    const whole = Math.ceil(steps)
    let before = est
    let after = est
    for (let k = 0; k < whole; k++) {
      before = after
      after = this.step(w)
      if (!Number.isFinite(after)) return est
      w.push(after)
    }
    const value = before + (after - before) * (steps - (whole - 1))
    return est + Math.max(-limit, Math.min(limit, (value - est) * this.trust))
  }
}
