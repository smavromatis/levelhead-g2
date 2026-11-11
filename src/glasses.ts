/**
 * The link to the glasses: page layout, frame loop, touch input, IMU stream
 * and lifecycle.
 *
 * Page (576 x 288): a full-screen empty text container that captures input,
 * a label and a hint line that show briefly, and one or two 288 x 144 images
 * that carry the cue.
 */
import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  AppLocationAccuracy,
  ImuReportPace,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type DeviceStatus,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { GpsFix, Vec3 } from './motion'
import {
  CUE_Y,
  SCREEN_H,
  SCREEN_W,
  TILE_H,
  TILE_W,
  cueWidth,
  cueX,
  drawCue,
  viewKey,
  type Layout,
  type View,
} from './render'

export type GlassesAction = 'toggleMode' | 'recenter' | 'intensityUp' | 'intensityDown'

export interface GlassesHost {
  /** The view as it will be `aheadS` seconds from now. */
  getView(aheadS: number): View
  onImu(v: Vec3, tMs: number): void
  onGps(fix: GpsFix, tMs: number): void
  onAction(a: GlassesAction): void
  onDevice(status: DeviceStatus): void
}

export interface LinkStats {
  fps: number
  frameMs: number
  /** How far ahead the last picture was drawn for, in ms. */
  leadMs: number
  failures: number
}

/** How often to check for a changed picture when nothing is being sent. */
const IDLE_POLL_MS = 25
/** Estimated trip of a sensor reading from glasses to phone. Not measurable through the SDK. */
const SENSOR_TRIP_MS = 30
/** Look-ahead is only as good as the motion is regular; never reach too far. */
const MAX_LEAD_MS = 650
const CALL_TIMEOUT_MS = 4000
const CHROME_MS = 5000

/** Label and hint line up with the left edge of the centred cue. */
const TEXT_X = 144

const LABEL = { id: 2, name: 'label' }
const HINT = { id: 3, name: 'hint' }
const TILES = [
  { id: 4, name: 'cue-a' },
  { id: 5, name: 'cue-b' },
]

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class GlassesLink {
  stats: LinkStats = { fps: 0, frameMs: 0, leadMs: 0, failures: 0 }

  private readonly bridge: EvenAppBridge
  private readonly host: GlassesHost
  private queue: Promise<unknown> = Promise.resolve()
  private layout: Layout = 'focus'
  private loopId = 0
  private lastKeys = ['', '']
  private nextTile = 0
  private lastFrameAt = 0
  /** Running averages: one send's round trip, and time between sends. */
  private sendMs = 150
  private periodMs = 160
  private chromeTimer: ReturnType<typeof setTimeout> | undefined
  private shown = { label: ' ', hint: ' ' }
  private unsubscribers: Array<() => void> = []
  private locating = false
  private readonly master = document.createElement('canvas')
  private readonly tile = document.createElement('canvas')

  constructor(bridge: EvenAppBridge, host: GlassesHost) {
    this.bridge = bridge
    this.host = host
    this.tile.width = TILE_W
    this.tile.height = TILE_H
    this.master.height = TILE_H
  }

  async start(layout: Layout): Promise<boolean> {
    this.layout = layout
    const result = await this.call(() =>
      this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(this.page())),
    )
    if (result !== StartUpPageCreateResult.success) {
      // The startup call only works once per launch. If the WebView reloaded,
      // the page already exists and has to be rebuilt instead.
      const rebuilt = await this.call(() =>
        this.bridge.rebuildPageContainer(new RebuildPageContainer(this.page())),
      )
      if (!rebuilt) {
        console.error('[levelhead] startup page rejected:', result)
        return false
      }
    }
    this.unsubscribers.push(
      this.bridge.onEvenHubEvent((e) => this.onEvent(e)),
      this.bridge.onDeviceStatusChanged((s) => this.host.onDevice(s)),
      this.bridge.onAppLocationChanged((loc) => {
        if (loc.speed == null) return
        this.host.onGps({ speed: loc.speed, heading: loc.heading ?? NaN }, performance.now())
      }),
    )
    window.addEventListener('beforeunload', () => this.dispose())
    await this.resume()
    return true
  }

  /** Switch between one centred image and two spanning the display. */
  async setLayout(layout: Layout): Promise<void> {
    if (layout === this.layout) return
    this.layout = layout
    await this.call(() => this.bridge.rebuildPageContainer(new RebuildPageContainer(this.page())))
    this.shown = { label: ' ', hint: ' ' }
    this.invalidate()
  }

  /**
   * Turn the phone's GPS feed on or off. It is read on the phone itself and
   * needs no network, only the location permission.
   */
  async setLocation(on: boolean): Promise<void> {
    if (on === this.locating) return
    this.locating = on
    await this.applyLocation()
  }

  private async applyLocation(): Promise<void> {
    if (this.locating) {
      await this.bridge
        .startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 1000, distanceFilter: 0 })
        .catch((e) => console.warn('[levelhead] location unavailable', e))
    } else {
      await this.bridge.stopAppLocationUpdates().catch(() => {})
    }
  }

  /** Force the next frame to be sent even if the picture looks unchanged. */
  invalidate(): void {
    this.lastKeys = ['', '']
  }

  /**
   * Show a label (top) and hint (bottom). Unless `sticky`, both clear after a
   * few seconds so nothing but the cue stays in view.
   */
  showChrome(label: string, hint = ' ', sticky = false): void {
    clearTimeout(this.chromeTimer)
    void this.setText(LABEL, 'label', label)
    void this.setText(HINT, 'hint', hint)
    if (!sticky) {
      this.chromeTimer = setTimeout(() => {
        void this.setText(LABEL, 'label', ' ')
        void this.setText(HINT, 'hint', ' ')
      }, CHROME_MS)
    }
  }

  // ---------------------------------------------------------------- internals

  private page() {
    const tiles = this.layout === 'wide' ? TILES : TILES.slice(0, 1)
    const text = (
      c: { id: number; name: string },
      y: number,
      height: number,
      z: number,
      brightness: number,
    ) =>
      new TextContainerProperty({
        xPosition: TEXT_X,
        yPosition: y,
        width: SCREEN_W - TEXT_X,
        height,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 4,
        containerID: c.id,
        containerName: c.name,
        content: ' ',
        isEventCapture: 0,
        zOrderIndex: z,
        textColor: brightness,
      })
    return {
      containerTotalNum: 3 + tiles.length,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: SCREEN_W,
          height: SCREEN_H,
          borderWidth: 0,
          borderColor: 0,
          paddingLength: 0,
          containerID: 1,
          containerName: 'capture',
          content: ' ',
          isEventCapture: 1,
          zOrderIndex: 1,
        }),
        text(LABEL, 16, 40, 2, 3),
        text(HINT, 232, 40, 3, 2),
      ],
      imageObject: tiles.map(
        (t, i) =>
          new ImageContainerProperty({
            xPosition: cueX(this.layout) + i * TILE_W,
            yPosition: CUE_Y,
            width: TILE_W,
            height: TILE_H,
            containerID: t.id,
            containerName: t.name,
            zOrderIndex: 4 + i,
          }),
      ),
    }
  }

  /** Bridge calls share one BLE link and must not overlap. Each is queued, with a timeout. */
  private call<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = async (): Promise<T | undefined> => {
      try {
        return await Promise.race([
          fn(),
          sleep(CALL_TIMEOUT_MS).then(() => {
            throw new Error('bridge call timed out')
          }),
        ])
      } catch (e) {
        this.stats.failures++
        console.warn('[levelhead]', e)
        return undefined
      }
    }
    const next = this.queue.then(run, run)
    this.queue = next
    return next
  }

  private async setText(c: { id: number; name: string }, slot: 'label' | 'hint', content: string) {
    if (this.shown[slot] === content) return
    this.shown[slot] = content
    await this.call(() =>
      this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: c.id,
          containerName: c.name,
          contentOffset: 0,
          contentLength: 0,
          content,
        }),
      ),
    )
  }

  private async resume(): Promise<void> {
    await this.call(() => this.bridge.imuControl(true, ImuReportPace.P100))
    // The host stops location updates while the WebView is suspended.
    if (this.locating) await this.applyLocation()
    this.invalidate()
    const id = ++this.loopId
    void this.loop(id)
  }

  private async pause(): Promise<void> {
    this.loopId++
    await this.call(() => this.bridge.imuControl(false))
  }

  private async loop(id: number): Promise<void> {
    while (id === this.loopId) {
      const sent = await this.frame()
      // After a send, go again at once; otherwise check back shortly.
      await sleep(sent ? 0 : IDLE_POLL_MS)
    }
  }

  /**
   * Send one tile, drawn for when it will be seen: one send from now, plus
   * half the time it then stays on screen. Returns false if nothing changed.
   */
  private async frame(): Promise<boolean> {
    const layout = this.host.getView(0).layout
    const count = layout === 'wide' ? 2 : 1
    const leadMs = Math.min(SENSOR_TRIP_MS + this.sendMs + (count * this.periodMs) / 2, MAX_LEAD_MS)
    const view = this.host.getView(leadMs / 1000)
    const key = viewKey(view)
    let index = -1
    for (let n = 0; n < count; n++) {
      const i = (this.nextTile + n) % count
      if (this.lastKeys[i] !== key) {
        index = i
        break
      }
    }
    if (index < 0) {
      // Nothing moving: forget the cadence so it is re-measured afresh.
      this.lastFrameAt = 0
      return false
    }
    this.nextTile = (index + 1) % count
    this.lastKeys[index] = key

    const started = performance.now()
    const width = cueWidth(view.layout)
    if (this.master.width !== width) this.master.width = width
    drawCue(this.master.getContext('2d')!, view)
    this.tile
      .getContext('2d')!
      .drawImage(this.master, index * TILE_W, 0, TILE_W, TILE_H, 0, 0, TILE_W, TILE_H)
    const png = await encodePng(this.tile)
    const t = TILES[index]
    const result = await this.call(() =>
      this.bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: t.id, containerName: t.name, imageData: png }),
      ),
    )
    if (result !== ImageRawDataUpdateResult.success) {
      // Make sure a dropped frame is retried rather than left stale.
      this.lastKeys[index] = ''
      if (result !== undefined) console.warn('[levelhead] image update:', result)
    }

    const now = performance.now()
    // Slow averages: a steady look-ahead matters more than chasing each
    // send, since delay that wobbles is worse than delay that is constant.
    const ease = (avg: number, value: number) => avg + (Math.min(value, 1000) - avg) * 0.1
    this.sendMs = ease(this.sendMs, now - started)
    if (this.lastFrameAt) this.periodMs = ease(this.periodMs, now - this.lastFrameAt)
    this.lastFrameAt = now
    this.stats = {
      fps: 1000 / this.periodMs,
      frameMs: this.sendMs,
      leadMs,
      failures: this.stats.failures,
    }
    return true
  }

  private onEvent(e: EvenHubEvent): void {
    const sys = e.sysEvent
    if (sys?.imuData && (sys.eventType ?? 0) === OsEventTypeList.IMU_DATA_REPORT) {
      const { x = 0, y = 0, z = 0 } = sys.imuData
      this.host.onImu([x, y, z], performance.now())
      return
    }
    const source = e.textEvent ?? e.listEvent ?? sys
    if (!source) return
    // Protobuf drops zero values, so a single press arrives with no type.
    switch (source.eventType ?? OsEventTypeList.CLICK_EVENT) {
      case OsEventTypeList.CLICK_EVENT:
        this.host.onAction('toggleMode')
        break
      case OsEventTypeList.SCROLL_TOP_EVENT:
        this.host.onAction('intensityUp')
        break
      case OsEventTypeList.SCROLL_BOTTOM_EVENT:
        this.host.onAction('intensityDown')
        break
      case OsEventTypeList.LONG_PRESS_EVENT:
        this.host.onAction('recenter')
        break
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        // System exit dialog. Cleanup waits for the exit event, because the
        // wearer can still cancel.
        void this.call(() => this.bridge.shutDownPageContainer(1))
        break
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        void this.resume()
        break
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        void this.pause()
        break
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
        this.dispose()
        break
    }
  }

  private dispose(): void {
    this.loopId++
    clearTimeout(this.chromeTimer)
    void this.bridge.imuControl(false).catch(() => {})
    void this.bridge.stopAppLocationUpdates().catch(() => {})
    for (const off of this.unsubscribers.splice(0)) off()
  }
}

/** The host accepts encoded images and does its own 4-bit conversion. */
function encodePng(canvas: HTMLCanvasElement): Promise<number[]> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('could not encode frame'))
      resolve(Array.from(new Uint8Array(await blob.arrayBuffer())))
    }, 'image/png')
  })
}
