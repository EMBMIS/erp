import React, { useEffect, useMemo, useRef } from 'react'
import useIsDark from '../../hooks/useIsDark'

/**
 * The Simeli symbiote — the living computational object at the centre of EMBMIS.
 *
 * WHAT IT IS
 * ---------------------------------------------------------------------------
 * A procedural 3D structure: ~20 luminous strands looping around an invisible
 * core, threaded with drifting particles and a few thin orbital filaments. It
 * is not a torus and not an image. Every point is computed each frame from the
 * strand's own parameters plus layered noise, projected through a perspective
 * camera, and drawn additively — so the object deforms, breathes, and can
 * propagate a wave around itself.
 *
 * WHY CANVAS AND NOT THREE.JS
 * ---------------------------------------------------------------------------
 * The initial payload is budgeted at 200 kB gzipped (scripts/check-bundle-
 * budget.js) and the dashboard is the first screen an authenticated user
 * loads. Three.js is ~150 kB gzipped on its own — most of a budget spent on
 * one ornament, plus a WebGL context that fails on locked-down corporate GPUs
 * and falls back to nothing. Everything this object needs — 3D points, a
 * perspective divide, painter's-algorithm depth sorting, additive blending —
 * is a few dozen lines of maths over a 2D context, runs on every machine, and
 * costs zero bytes of dependency. The trade is real-time lighting and true
 * volumetrics, neither of which this shape uses.
 *
 * THE STATES — this is what makes it read as alive rather than animated
 * ---------------------------------------------------------------------------
 *   idle       slow breathing, gentle rotation, energy flowing along strands
 *   thinking   faster internal circulation, tightened radius, brighter core
 *   listening  strands draw INWARD toward the core, particles converge, the
 *              whole body pulses on an inhale rhythm
 *   speaking   a wave TRAVELS around the structure — sin(kθ - ωt) driven by a
 *              synthesised syllable envelope, so the body visibly expands and
 *              contracts in rhythm, exactly the way a voice modulates. Strand
 *              brightness rides the same envelope, so energy propagates
 *              around the object as it "generates a response".
 *
 * State changes are never applied directly: every driver (amplitude, radius,
 * spin, glow, wave energy) is a spring lerped toward its target, so the object
 * eases between moods instead of snapping — which is most of the difference
 * between "alive" and "CSS class swapped".
 *
 * ACCESSIBILITY / COST
 * ---------------------------------------------------------------------------
 * Renders a single static frame under prefers-reduced-motion, pauses entirely
 * when scrolled out of view or when the tab is hidden, and caps device pixel
 * ratio at 2. Purely decorative, so it is aria-hidden and the surrounding
 * panel carries the real status text.
 */

const TAU = Math.PI * 2

// The camera sits slightly above the plane every strand circulates in, so the
// body is read as a ring in perspective rather than as a flat spiral. Without
// this the near and far arcs overlap on screen and the object loses its depth
// entirely.
const CAMERA_PITCH = 0.62

const STATE_TARGETS = {
  // amp: strand deformation · radius: body scale · spin: rotation rate
  // glow: brightness multiplier · wave: travelling-wave energy
  // inward: pull toward the core · churn: internal circulation speed
  // Idle is not "off": the object keeps circulating, breathing and shedding
  // particles, because a computational entity that goes still reads as a
  // decorative model that stopped rendering.
  idle:      { amp: 0.030, radius: 1.0,  spin: 1.05, glow: 0.72, wave: 0.10, inward: 0.0,  churn: 1.25 },
  thinking:  { amp: 0.055, radius: 0.95, spin: 1.9,  glow: 0.88, wave: 0.30, inward: 0.10, churn: 2.4 },
  // Listening pulls inward and calms: the object is receiving, not emitting.
  listening: { amp: 0.058, radius: 0.90, spin: 0.72, glow: 0.84, wave: 0.20, inward: 0.26, churn: 1.35 },
  // Speaking is the loudest the object ever gets — energy travelling the
  // filaments, the body swelling, the aura at its brightest.
  speaking:  { amp: 0.115, radius: 1.09, spin: 1.45, glow: 1.18, wave: 1.0,  inward: 0.0,  churn: 2.1 },
}

/** Deterministic PRNG — the structure must be identical on every mount. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Cheap layered value noise: three sines at incommensurate frequencies. */
function noise(x, y) {
  return (
    Math.sin(x * 1.0 + y * 0.7) * 0.5 +
    Math.sin(x * 2.3 - y * 1.9) * 0.32 +
    Math.sin(x * 4.7 + y * 3.1) * 0.18
  )
}

/**
 * The palette is a position along a single energy ramp, not a set of discrete
 * colours: cyan → blue → violet → magenta. Strands sample different windows of
 * it, which is what stops the object from looking like "one neon colour".
 */
function energyColor(u, dark) {
  const stops = dark
    ? [
        [34, 211, 238],   // cyan
        [59, 130, 246],   // electric blue
        [124, 92, 246],   // violet
        [200, 110, 250],  // magenta edge
      ]
    : [
        [14, 165, 233],
        [37, 99, 235],
        [109, 40, 217],
        [147, 51, 234],
      ]
  const t = Math.min(0.9999, Math.max(0, u)) * (stops.length - 1)
  const i = Math.floor(t)
  const f = t - i
  const a = stops[i]
  const b = stops[i + 1] || stops[i]
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]
}

/** Build the immutable structure: strand parameters, particles, filaments. */
function buildStructure(seed) {
  const rnd = mulberry32(seed)

  const strands = []
  const STRAND_COUNT = 16
  for (let s = 0; s < STRAND_COUNT; s++) {
    // Roll is drawn first because the strand's colour is derived from it. In
    // the reference the object is cyan down one flank and violet down the
    // other — the hue tracks where a ribbon sits in space, not which index it
    // happens to have. Keying hue to the strand number instead scatters the
    // ramp evenly around the ring, and evenly-scattered hues average out to a
    // single mauve mush, which is exactly what this looked like.
    const roll = rnd() * TAU
    const arc = roll / TAU
    strands.push({
      phase: rnd() * TAU,
      // Each strand sits on its own slightly tilted plane. This spread is the
      // single most important pair of numbers in the whole object: widen it
      // and the strands stop sharing an axis, the centre fills in, and the
      // result is a hairball. Kept small, every strand still circulates around
      // the same core, and the structure reads as one vortex with a hollow
      // middle — which is what makes it look like it is *surrounding*
      // something rather than being a knot of wire.
      //
      // tiltYaw/tiltPitch are the plane's lean. `seed` is a separate free
      // number used only to decorrelate the noise fields; feeding a full 0–2π
      // rotation in here instead was exactly the bug that made this a tangle.
      tiltYaw: (rnd() - 0.5) * 0.30,
      tiltPitch: (rnd() - 0.5) * 0.24,
      seed: rnd() * TAU,
      // Roll is a rotation within the strand's own plane, so it only shifts
      // where the strand starts — free to vary across the full circle.
      roll,
      minor: 0.1 + rnd() * 0.22,     // thickness of the strand's own coil
      twist: 2 + Math.floor(rnd() * 4), // coils per revolution
      speed: 0.6 + rnd() * 0.9,
      // Hue follows position around the ring, with only a little jitter, so
      // the two flanks stay distinct instead of blending.
      hue0: arc * 0.95 + (rnd() - 0.5) * 0.06,
      hueSpan: 0.10 + rnd() * 0.14,
      // Roughly two strands in five are "ribbons": markedly wider and brighter
      // than the rest. Uniform strand weights are what make a procedural
      // object look procedural — a few dominant lines carrying the eye, with
      // finer ones filling behind them, is what reads as a body with structure
      // instead of a wire ball.
      //
      // These are far wider than they were. The reference's form is built from
      // broad soft sheets of light, closer to smoke than to wire, and at the
      // old widths every stroke read as a drawn line no matter how it was lit.
      // Width and alpha pull against each other here, because the whole object
      // is composited additively: overlapping strokes SUM. Widening the ribbons
      // without dropping their alpha drove every crossing to white and the hue
      // washed out of the form entirely. Wide and dim is what produces a soft
      // sheet of coloured light; narrow and bright produces wire.
      ...(rnd() < 0.4
        ? { width: 2.2 + rnd() * 1.7, alpha: 0.44 + rnd() * 0.24 }
        : { width: 0.55 + rnd() * 0.85, alpha: 0.22 + rnd() * 0.20 }),
      // Where along the loop this strand thins out to nothing, so strands
      // appear to grow from the body and return into it rather than being
      // closed rings.
      fadeAt: rnd(),
      fadeWidth: 0.18 + rnd() * 0.22,
    })
  }

  // Fine filaments: high-twist, hair-thin, very low alpha. They are what makes
  // the object read as filamentary rather than as a set of tubes.
  const filaments = []
  for (let f = 0; f < 16; f++) {
    filaments.push({
      phase: rnd() * TAU,
      tiltYaw: (rnd() - 0.5) * 0.62,
      tiltPitch: (rnd() - 0.5) * 0.54,
      seed: rnd() * TAU,
      roll: rnd() * TAU,
      minor: 0.04 + rnd() * 0.3,
      twist: 5 + Math.floor(rnd() * 9),
      speed: 0.4 + rnd() * 1.6,
      hue0: rnd(),
      hueSpan: 0.20,
      width: 0.34 + rnd() * 0.4,
      alpha: 0.13 + rnd() * 0.2,
      fadeAt: rnd(),
      fadeWidth: 0.3,
    })
  }

  const particles = []
  for (let p = 0; p < 210; p++) {
    particles.push({
      theta: rnd() * TAU,
      // Most particles ride the body; a minority orbit far out as a field.
      shell: rnd() < 0.74 ? 0.86 + rnd() * 0.34 : 1.28 + rnd() * 0.62,
      lift: (rnd() - 0.5) * 0.75,
      // Same discipline as the strands: the field orbits the same axis the
      // body does, with enough spread to read as a volume rather than a hoop.
      tiltPitch: (rnd() - 0.5) * 0.9,
      tiltYaw: (rnd() - 0.5) * 0.9,
      speed: (0.25 + rnd() * 1.0) * (rnd() < 0.5 ? -1 : 1),
      size: 0.5 + rnd() * 1.5,
      hue: rnd(),
      alpha: 0.25 + rnd() * 0.6,
      twinkle: rnd() * TAU,
    })
  }

  // Thin orbiting structures — precise rings that contrast with the organic
  // strands, the way instrumentation contrasts with biology.
  const rings = [
    { pitch: 0.16, yaw: 0.18, radius: 1.38, width: 0.5, alpha: 0.3, hue: 0.1, speed: 0.09 },
    { pitch: -0.34, yaw: -0.42, radius: 1.56, width: 0.4, alpha: 0.22, hue: 0.55, speed: -0.06 },
    { pitch: 0.5, yaw: 0.62, radius: 1.2, width: 0.35, alpha: 0.18, hue: 0.85, speed: 0.13 },
  ]

  return { strands, filaments, particles, rings }
}

/** Rotate a point by yaw (Y), pitch (X), roll (Z). Written out — no matrices,
    no allocation, called ~40k times a second. */
function rotate(p, yaw, pitch, roll) {
  let { x, y, z } = p
  let c = Math.cos(yaw), s = Math.sin(yaw)
  let nx = x * c + z * s
  let nz = -x * s + z * c
  x = nx; z = nz
  c = Math.cos(pitch); s = Math.sin(pitch)
  let ny = y * c - z * s
  nz = y * s + z * c
  y = ny; z = nz
  c = Math.cos(roll); s = Math.sin(roll)
  nx = x * c - y * s
  ny = x * s + y * c
  return { x: nx, y: ny, z }
}

export default function QiraSymbiote({
  state = 'idle',
  seed = 20260521,
  intensity = 1,
  className = '',
  style,
}) {
  const canvasRef = useRef(null)
  const stateRef = useRef(state)
  const dark = useIsDark()
  const darkRef = useRef(dark)
  const structure = useMemo(() => buildStructure(seed), [seed])

  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { darkRef.current = dark }, [dark])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return undefined

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const { strands, filaments, particles, rings } = structure

    let width = 0
    let height = 0
    let dpr = 1
    let raf = 0
    let visible = true
    let last = 0
    let t = 0
    // The symbiote is ambient, not interactive: it does not need to redraw on
    // every display frame, and taking the whole main thread for it makes the
    // rest of the dashboard stutter. It draws at 34 Hz while idle and opens up
    // to full rate only while it is actually responding to the user, where the
    // motion is fast enough for the difference to register.
    let drawn = 0
    const frameBudget = () => (stateRef.current === 'idle' ? 1000 / 34 : 1000 / 60)

    // Every driver is a spring, not a switch — the object eases between moods.
    const drv = { ...STATE_TARGETS.idle }
    // Synthesised syllable envelope for the speaking state.
    let env = 0
    let envTarget = 0
    let envClock = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      // Soft additive light has no hard edges to resolve, so the second
      // pixel of a 2x backing store costs 4x the fill rate for no visible
      // gain. 1.5 keeps the hair-thin filaments from aliasing.
      dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const io = new IntersectionObserver(
      (entries) => { visible = entries.some((e) => e.isIntersecting) },
      { threshold: 0.01 }
    )
    io.observe(canvas)

    const onVisibility = () => { if (!document.hidden) last = performance.now() }
    document.addEventListener('visibilitychange', onVisibility)

    /* --- projection ------------------------------------------------------ */
    // Camera looks down -Z from a fixed distance; scale is derived from the
    // shorter side so the object never overflows a narrow container.
    const project = (p, scale, cx, cy) => {
      const depth = 3.4
      const f = depth / (depth + p.z)
      return { x: cx + p.x * scale * f, y: cy + p.y * scale * f, f, z: p.z }
    }

    /* --- one strand ------------------------------------------------------ */
    // Colour and width change continuously along a strand, but only slightly
    // between neighbouring segments. Issuing one stroke() per segment meant
    // several thousand draw calls a frame, which is what made this the most
    // expensive thing on the page. Instead the style is quantised and
    // consecutive segments that land on the same bucket are batched into one
    // polyline, which collapses that by roughly an order of magnitude without
    // any visible banding.
    const drawStrand = (st, opts) => {
      const { scale, cx, cy, isDark, glowPass, segments, glowScale = 1 } = opts
      const spin = t * 0.11 * drv.spin
      const flow = t * 0.42 * drv.churn * st.speed

      let prev = null
      let runKey = ''
      let runOpen = false
      const flush = () => {
        if (runOpen) { ctx.stroke(); runOpen = false }
        runKey = ''
      }

      for (let i = 0; i <= segments; i++) {
        const u = i / segments
        const th = u * TAU + st.phase

        // Travelling wave: the "talking" motion. k=3 gives three crests around
        // the body, which reads as speech rather than as a wobble.
        const wave = Math.sin(th * 3 - t * 5.2) * drv.wave * (0.35 + env * 0.85)

        // Organic deformation — noise in θ and time, never a clean sine.
        const n = noise(th * 1.4 + st.phase, t * 0.35 + st.seed)

        const R = (1 + n * drv.amp + wave * 0.24) * drv.radius * (1 - drv.inward * 0.28)
        const coil = st.twist * th + flow
        const r = st.minor * (1 + 0.3 * Math.sin(th * 2 + flow * 0.6)) * (1 - drv.inward * 0.3)

        const rad = R + r * Math.cos(coil)
        const base = {
          x: rad * Math.cos(th),
          y: rad * Math.sin(th),
          z: r * Math.sin(coil) + 0.22 * Math.sin(th * 2 + st.phase),
        }

        const rotated = rotate(base, st.tiltYaw, st.tiltPitch, st.roll + spin)
        // Then the camera: one shared tilt applied after every strand's own
        // orientation, so they all lean the same way and the ring holds.
        const pt = project(rotate(rotated, 0, CAMERA_PITCH + Math.sin(t * 0.13) * 0.05, 0), scale, cx, cy)

        if (prev) {
          // Strands grow from and return into the body: alpha tapers around
          // fadeAt, so no strand is a closed hoop.
          let d = Math.abs(u - st.fadeAt)
          d = Math.min(d, 1 - d)
          const taper = Math.min(1, d / st.fadeWidth)

          // Depth cue — the far side of the body is dimmer and thinner, which
          // is what creates the sense of volume without any real lighting.
          const depthMix = (pt.f - 0.72) / 0.62
          const dep = Math.min(1, Math.max(0.12, depthMix))

          const [cr, cg, cb] = energyColor(st.hue0 + st.hueSpan * Math.sin(th + t * 0.2), isDark)
          const pulse = 0.72 + 0.28 * Math.sin(th * 3 - t * 5.2) * (0.3 + env)
          const a =
            st.alpha * taper * dep * drv.glow * intensity * pulse *
            // Higher than it looks: separate per-segment strokes used to sum
            // where their round caps overlapped, roughly doubling the glow.
            // Batched runs draw each pixel once, so the alpha carries it.
            (glowPass ? (glowScale > 1 ? 0.11 : 0.34) : 1) *
            (isDark ? 1 : 0.95)

          if (a > 0.005) {
            const w = Math.max(0.3, st.width * pt.f * (glowPass ? 5.5 * glowScale : 1) * (isDark ? 1 : 1.15))
            // The buckets have to be coarse relative to how fast the style
            // moves along a strand — the brightness ripple runs three full
            // cycles end to end — or every segment lands in its own bucket and
            // nothing batches. Additive blending over sixteen overlapping
            // strands hides the stepping.
            const qa = Math.round(Math.min(1, a) * 14) / 14
            const qw = Math.round(w * 2) / 2
            const key = `${cr >> 5},${cg >> 5},${cb >> 5},${qa},${qw}`
            if (key !== runKey) {
              flush()
              ctx.strokeStyle = `rgba(${cr},${cg},${cb},${qa})`
              ctx.lineWidth = qw
              ctx.beginPath()
              ctx.moveTo(prev.x, prev.y)
              runKey = key
              runOpen = true
            }
            ctx.lineTo(pt.x, pt.y)
          } else {
            flush()
          }
        }
        prev = pt
      }
      flush()
    }

    const drawRing = (ring, opts) => {
      const { scale, cx, cy, isDark } = opts
      const spin = t * ring.speed + t * 0.05 * drv.spin
      const segs = 64
      const [cr, cg, cb] = energyColor(ring.hue, isDark)
      let runKey = ''
      let runOpen = false
      let prevPt = null
      const flush = () => {
        if (runOpen) { ctx.stroke(); runOpen = false }
        runKey = ''
      }
      for (let i = 0; i < segs; i++) {
        const th0 = (i / segs) * TAU
        const th1 = ((i + 1) / segs) * TAU
        const rr = ring.radius * drv.radius * (1 - drv.inward * 0.18) *
          (1 + 0.02 * Math.sin(th0 * 5 + t * 1.2) * (1 + env))
        const at = (th) => project(
          rotate(rotate({ x: rr * Math.cos(th + spin), y: rr * Math.sin(th + spin), z: 0 }, ring.yaw, ring.pitch, 0), 0, CAMERA_PITCH, 0),
          scale, cx, cy
        )
        const p0 = prevPt && Math.abs(prevPt.th - th0) < 1e-9 ? prevPt : at(th0)
        const p1 = at(th1)
        p1.th = th1
        prevPt = p1
        const dep = Math.min(1, Math.max(0.06, (p0.f - 0.72) / 0.62))
        const a = ring.alpha * dep * drv.glow * intensity * (isDark ? 1 : 0.8)
        if (a <= 0.004) { flush(); continue }
        const qa = Math.round(a * 14) / 14
        const qw = Math.round(Math.max(0.25, ring.width * p0.f) * 2) / 2
        const key = `${qa},${qw}`
        if (key !== runKey) {
          flush()
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${qa})`
          ctx.lineWidth = qw
          ctx.beginPath()
          ctx.moveTo(p0.x, p0.y)
          runKey = key
          runOpen = true
        }
        ctx.lineTo(p1.x, p1.y)
      }
      flush()
    }

    const drawParticles = (opts) => {
      const { scale, cx, cy, isDark } = opts
      const spin = t * 0.11 * drv.spin
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        const th = p.theta + t * 0.16 * p.speed * drv.churn
        // In listening the field converges on the core; in speaking it is
        // pushed outward on each syllable.
        const shell = p.shell * drv.radius * (1 - drv.inward * 0.42) * (1 + env * drv.wave * 0.12)
        const base = {
          x: shell * Math.cos(th),
          y: shell * Math.sin(th),
          z: p.lift + 0.14 * Math.sin(th * 3 + p.twinkle),
        }
        const pt = project(
          rotate(rotate(base, p.tiltYaw, p.tiltPitch, spin * 0.3), 0, CAMERA_PITCH, 0),
          scale, cx, cy
        )
        const dep = Math.min(1, Math.max(0.05, (pt.f - 0.7) / 0.64))
        const tw = 0.55 + 0.45 * Math.sin(t * 2.1 + p.twinkle)
        const a = p.alpha * dep * tw * drv.glow * intensity * (isDark ? 1 : 0.75)
        if (a <= 0.006) continue
        const [cr, cg, cb] = energyColor(p.hue, isDark)
        const size = Math.max(0.3, p.size * pt.f * dep)
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${Math.min(1, a)})`
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, size, 0, TAU)
        ctx.fill()
      }
    }

    const render = (now) => {
      raf = requestAnimationFrame(render)
      if (!visible || document.hidden) { last = now; drawn = now; return }
      // Skip the frame but keep `last` running, so t advances with wall time
      // and the motion looks identical at either rate.
      if (now - drawn < frameBudget() - 1) return
      drawn = now

      const dt = Math.min(0.05, (now - last) / 1000 || 0.016)
      last = now
      t += dt

      /* --- drivers ------------------------------------------------------- */
      const target = STATE_TARGETS[stateRef.current] || STATE_TARGETS.idle
      const k = 1 - Math.pow(0.001, dt) // frame-rate independent lerp
      for (const key of Object.keys(drv)) {
        drv[key] += (target[key] - drv[key]) * k
      }

      // Breathing rides on top of every state, so the object is never still.
      const breath = 1 + Math.sin(t * 0.85) * 0.022 + Math.sin(t * 0.31) * 0.014

      // Syllable envelope. Re-targeted on a speech-like cadence (~90–190 ms)
      // and smoothed, which is what makes the wave read as talking rather
      // than as a metronome.
      envClock -= dt
      if (envClock <= 0) {
        envClock = 0.09 + Math.random() * 0.1
        envTarget = stateRef.current === 'speaking'
          ? 0.25 + Math.random() * 0.75
          : stateRef.current === 'listening'
            ? 0.1 + Math.random() * 0.3
            : 0
      }
      env += (envTarget - env) * Math.min(1, dt * 14)

      /* --- frame --------------------------------------------------------- */
      const isDark = darkRef.current
      ctx.clearRect(0, 0, width, height)
      const cx = width / 2
      const cy = height / 2
      const scale = Math.min(width, height) * 0.255 * breath

      // Additive light on dark; ordinary compositing on light, where adding
      // energy to white paper just erases the object.
      ctx.globalCompositeOperation = isDark ? 'lighter' : 'source-over'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      const opts = { scale, cx, cy, isDark, glowPass: false, segments: 46 }

      // Core: an invisible centre that the structure surrounds — only its
      // pressure on the surrounding space is visible.
      const coreR = scale * (0.62 + env * 0.1)
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR)
      // The object's own light. White-hot at the very centre, ultraviolet
      // through the body, electric blue at the edge of its reach — so it reads
      // as something generating light rather than a shape tinted purple. The
      // outermost stop is what spills onto the panel around it.
      const coreAlpha = (isDark ? 0.26 : 0.08) * drv.glow * intensity
      core.addColorStop(0, `rgba(${isDark ? '190,200,255' : '99,102,241'},${coreAlpha * 0.30})`)
      core.addColorStop(0.30, `rgba(${isDark ? '120,80,220' : '99,102,241'},${coreAlpha * 0.42})`)
      core.addColorStop(0.62, `rgba(${isDark ? '46,74,190' : '59,130,246'},${coreAlpha * 0.16})`)
      core.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx, cy, coreR, 0, TAU)
      ctx.fill()

      for (const ring of rings) drawRing(ring, opts)

      // Bloom pass first (thick, faint), then the strand itself over it — a
      // painter's bloom that costs one extra stroke instead of a shader.
      if (isDark) {
        // Two passes at different widths give the halo a falloff. One pass is a
        // uniform skirt around the strand and reads as a sticker outline; two
        // read as light losing intensity with distance.
        // A glow pass is a wide, faint skirt — it carries no detail, so it is
        // resolved at a fraction of the segment count of the strand itself.
        const wideGlow = { ...opts, glowPass: true, segments: 16, glowScale: 2.1 }
        for (const st of strands) drawStrand(st, wideGlow)
        const glowOpts = { ...opts, glowPass: true, segments: 22 }
        for (const st of strands) drawStrand(st, glowOpts)
      }
      for (const st of filaments) drawStrand(st, { ...opts, segments: 30 })
      for (const st of strands) drawStrand(st, opts)

      drawParticles(opts)

      ctx.globalCompositeOperation = 'source-over'

      if (reduced) cancelAnimationFrame(raf)
    }

    last = performance.now()
    raf = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [structure, intensity])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{ display: 'block', width: '100%', height: '100%', ...style }}
    />
  )
}
