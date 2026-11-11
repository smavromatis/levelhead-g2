/**
 * Draws the cue, for both the glasses and the phone preview. White on black:
 * on the G2 white is lit and black is off, i.e. see-through.
 */
import type { Mode, MotionState } from './motion'

export type Intensity = 0 | 1 | 2

export interface View {
  mode: Mode
  intensity: Intensity
  state: MotionState
  /** False when there is nothing trustworthy to draw (not calibrated). */
  active: boolean
}

/** One image container, at the SDK's maximum size, centred on the display. */
export const TILE_W = 288
export const TILE_H = 144
export const SCREEN_W = 576
export const SCREEN_H = 288
export const CUE_Y = (SCREEN_H - TILE_H) / 2

export const CUE_X = (SCREEN_W - TILE_W) / 2

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const smooth = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
const grey = (level: number) => {
  const v = Math.round(clamp(level, 0, 1) * 255)
  return `rgb(${v},${v},${v})`
}

/**
 * Roll is always drawn 1:1; a line that does not match the real horizon did
 * nothing in the research. Pitch is drawn at about a third of true scale
 * (~23 px/deg), because an accelerometer cannot tell pitching from surging
 * and full scale would amplify that error.
 */
const PITCH_PX_PER_DEG = 8
/** Dot travel in pixels per g of vehicle acceleration. */
const CAR_PX_PER_G = [70, 110, 160]

interface Geometry {
  /** Horizon rotation, radians (canvas direction). */
  angle: number
  /** Horizon vertical offset, px. */
  lift: number
  /** Dot field offset, px. */
  dx: number
  dy: number
}

function geometry(view: View): Geometry {
  const { state, intensity } = view
  const roll = clamp(state.roll, -40, 40)
  return {
    // Right ear down -> the horizon climbs on the right of the view.
    angle: (-roll * Math.PI) / 180,
    // Nose down -> the horizon rises in the view.
    lift: clamp(-state.pitch * PITCH_PX_PER_DEG, -TILE_H / 2 + 16, TILE_H / 2 - 16),
    // Dots hold their place in the world, so they slide against the motion:
    // a right turn carries them left, speeding up carries them down.
    dx: clamp(-state.turn * CAR_PX_PER_G[intensity], -44, 44),
    dy: clamp(state.surge * CAR_PX_PER_G[intensity], -30, 30),
  }
}

/**
 * A string that changes only when the picture would. The glasses link skips
 * the BLE send when it has not, which keeps a steady head from costing power.
 */
export function viewKey(view: View): string {
  if (!view.active) return 'off'
  const g = geometry(view)
  return view.mode === 'ship'
    ? `s${(g.angle * 120).toFixed(0)}:${g.lift.toFixed(0)}`
    : `c${g.dx.toFixed(0)}:${g.dy.toFixed(0)}`
}

type Ctx = CanvasRenderingContext2D

/** Paint the cue into a `TILE_W` x `TILE_H` area at the origin. */
export function drawCue(ctx: Ctx, view: View): void {
  const w = TILE_W
  const h = TILE_H
  ctx.save()
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  if (view.active) {
    ctx.beginPath()
    ctx.rect(0, 0, w, h)
    ctx.clip()
    const g = geometry(view)
    if (view.mode === 'ship') drawHorizon(ctx, w, h, g)
    else drawDots(ctx, w, h, g)
  }
  ctx.restore()
}

/** Ship: a horizon line that stays level with the real one. The centre is left open. */
function drawHorizon(ctx: Ctx, w: number, h: number, g: Geometry): void {
  const cx = w / 2
  const cy = h / 2
  const gap = 30
  // Stop the line short of the top and bottom of the picture when it is
  // steeply tilted, so it fades out instead of being cut off.
  const steep = Math.abs(Math.sin(g.angle))
  const room = h / 2 - 8 - Math.abs(g.lift)
  const reach = Math.max(gap + 24, Math.min(w / 2, steep > 1e-3 ? room / steep : Infinity))

  ctx.save()
  ctx.translate(cx, cy + g.lift)
  ctx.rotate(g.angle)
  ctx.lineCap = 'round'

  for (const side of [-1, 1]) {
    // Brightest beside the gap, fading to nothing at its end.
    const fade = ctx.createLinearGradient(side * gap, 0, side * reach, 0)
    fade.addColorStop(0, grey(1))
    fade.addColorStop(0.7, grey(0.6))
    fade.addColorStop(1, grey(0))
    ctx.strokeStyle = fade
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(side * gap, 0)
    ctx.lineTo(side * reach, 0)
    ctx.stroke()

    // Short ticks on the water side, so "down" reads at a glance.
    ctx.strokeStyle = grey(0.4)
    ctx.lineWidth = 2
    for (let x = gap + 22; x < reach - 20; x += 44) {
      ctx.beginPath()
      ctx.moveTo(side * x, 7)
      ctx.lineTo(side * x, 14)
      ctx.stroke()
    }
  }
  ctx.restore()
  // Nothing head-fixed is drawn; only an earth-fixed line helped (Hemmerich 2020).
}

/** Car: dots at the sides that slide against each turn, pull-away and brake. */
function drawDots(ctx: Ctx, w: number, h: number, g: Geometry): void {
  const cx = w / 2
  const cy = h / 2
  const stepX = 48
  const stepY = 40
  const clear = 60
  const edge = 18

  const cols = Math.ceil(w / 2 / stepX) + 1
  const rows = Math.ceil(h / 2 / stepY) + 1
  for (let j = -rows; j <= rows; j++) {
    for (let i = -cols; i < cols; i++) {
      const x = cx + (i + 0.5) * stepX + g.dx
      const y = cy + j * stepY + g.dy
      const fromCentre = Math.abs(x - cx)
      // Dots fade in and out at every boundary instead of popping.
      const alpha =
        smooth(clear, clear + 22, fromCentre) *
        smooth(0, edge, w / 2 - fromCentre) *
        smooth(0, edge, h / 2 - Math.abs(y - cy))
      if (alpha < 0.08) continue
      // Brighter further out, where peripheral vision picks up motion best.
      const reachOut = smooth(clear, w / 2, fromCentre)
      ctx.fillStyle = grey(alpha * (0.55 + 0.45 * reachOut))
      ctx.beginPath()
      ctx.arc(x, y, 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
