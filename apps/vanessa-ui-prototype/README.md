# Vanessa UI — frontend prototype

A running, responsive frontend for Vanessa, built to the reference designs in
`docs/design/android-ui-reference/`. No build step, no framework, no runtime
dependencies: static ES modules served as-is.

```bash
# serve the prototype
python3 -m http.server 8080 --bind 0.0.0.0

# headless flow test (jsdom)
cd test && npm install jsdom && cd ..
node test/flow.mjs
```

There is deliberately **no `package.json` here.** The repo is a pnpm
monorepo whose `pnpm-workspace.yaml` claims `apps/*`, so a `package.json` in
this directory would make the prototype a workspace member and break
`pnpm install --frozen-lockfile` in every CI job until the root lockfile was
regenerated. Adding a dev-only dependency here is not worth invalidating the
lockfile for the whole monorepo, so the test installs its one dependency
directly.

## Screens

The eight specified screens, in order, plus Settings as an implementation
extension reached from the menu/grid controls:

| # | Screen | Purpose |
|---|--------|---------|
| 1 | Welcome | Brand entry point; the orb is the identity, there is no logo |
| 2 | Onboarding | Three value propositions with animated previews |
| 3 | Permissions | Mic / files / notifications with an orbital permission graph |
| 4 | Listening | Dedicated voice surface: orb, live waveform, stop control |
| 5 | Chat | Full transcript, quick intents, composer, history |
| 6 | Confirm Action | Explicit approval gate for destructive work |
| 7 | Task Execution | Progress arcs around the orb and a live stepper |
| 8 | Success | Completion state with celebratory waveform |
| — | Settings | Toggles, permissions state, about |

## Architecture

The orb, its orbital rings, and the waveform are **separate animated
elements**, never one baked illustration — this is what the brief called for
and it is what makes the states feel alive.

```
index.html          markup, 9 screens, inline SVG sprite
css/tokens.css      palette, type scale, spacing, radii, motion tokens
css/app.css         responsive shell + components
js/orb.js           Orb: layered 2D-canvas sphere renderer
js/waves.js         Waveform (superposed luminous ribbons) + ProgressArcs
js/app.js           navigation, interaction state machine, single rAF loop
test/flow.mjs       real-DOM flow test (jsdom + stubbed canvas)
```

### Orb

Rendered as a stack of physically-motivated passes rather than a flat disc:
dark volumetric body, cobalt rim on the upper-left edge, a concentrated cyan
specular glint, lime spill in the lower-right quadrant, and a glassy sheen —
with two or three thin elliptical orbital rings (behind and in front of the
sphere) and a drifting particle field. `setEnergy()` drives amplitude, which
lets the same renderer read as idle, listening, thinking, speaking or
successful.

No face, no letters, no logo. The orb *is* the brand mark.

### Waveform

Four overlapping luminous ribbons at different frequencies, speeds and
opacities, with reflected light beneath them. Deliberately **not** a bar
equaliser. Canvases are independent elements so they can be placed, sized and
animated per screen without ever overflowing text or controls.

### Motion

All canvases share one `requestAnimationFrame` loop with a clamped delta, so
nothing drifts out of sync and tab-switching cannot cause a visual jump.
`prefers-reduced-motion` is honoured in both CSS and JS — the JS path renders
a single static frame so canvases are never blank.

## Responsive behaviour

- **Phones** — full-bleed, no chrome. Uses `100dvh` where supported so the
  composer and dock do not slide under a mobile URL bar, and
  `env(safe-area-inset-*)` via `--safe-top` / `--safe-bottom` (with
  `viewport-fit=cover`) so content clears notches and gesture bars.
- **Tablet** — 460px framed device on a deep background.
- **Desktop** — framed 430px device with a soft blue bloom and deep shadow.
- **Short/landscape viewports** — orb and hero waveform cap their height, and
  every screen scrolls independently (`overflow-y: auto`, `overscroll-behavior:
  contain`) so nothing is ever unreachable.

## Testing

`test/flow.mjs` loads the real `index.html` and the real modules into jsdom
with a stubbed 2D canvas, then asserts the actual user journey:

navigate welcome → onboarding → permissions → chat, type a destructive intent,
confirm it routes to the approval gate, approve, watch the stepper advance, and
reach the success screen with the correct copy.

It catches what static markup review cannot: broken navigation, a stepper that
never runs, a composer that does not submit, and screens whose copy does not
survive `textContent` (a real defect found this way — `<br />` joining words
with no space breaks screen readers and copy/paste).

Run it with `node test/flow.mjs`, after `npm install jsdom` in `test/`.

`test/showcase.png` and `test/orb-render.png` are **rendered from the real
`js/orb.js` and `js/waves.js`** through a Canvas 2D backend, not drawn by hand.
They exist because reading the drawing code is not the same as seeing it — a
rendered frame is what caught the two lighting bugs below.

## Defects found by actually looking at the output

Both were invisible in code review and obvious in a render:

1. **A hard oval on the orb body.** The glass sheen was an ellipse *filled with
   a linear gradient*, so the gradient stopped at the ellipse boundary and left
   a visible edge on a black body. Replaced with a vertically squashed radial
   gradient that reaches zero before its own edge.
2. **A hard rectangle behind the waveform.** The reflected-light wash was a
   `fillRect`, so its left and right edges showed as a box. Masking it with
   `destination-in` made it worse — that operator clears the *whole* canvas
   outside the mask and erased the ribbons. Replaced with a radial gradient that
   fades in every direction on its own.

The orb's lighting was also rebuilt: light is now a thin fresnel rim stroked
*along* the silhouette with a gradient laid along the arc, instead of a filled
wedge clipped to a sector. The wedge approach double-counted light and produced
a thick blue hemisphere with a hard radial seam.

## Porting to Compose

`apps/android/.../ui/` is the port target: the orb is already a `Canvas`
composable. Each pass in `orb.js` maps to one drawing block, and the state
machine in `app.js` (`idle` / `listening` / `thinking` / `speaking` /
`success`) maps to the existing model layer. This prototype is the source of
truth for geometry, colour and timing.
