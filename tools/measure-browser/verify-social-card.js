// Verifies the share card the way a preview client sees it: as an image decoded by a real browser,
// not as bytes checked by the same code that wrote them. A hand-rolled PNG encoder that agrees with
// its own tests has proven nothing -- the only reader that matters is a decoder someone else wrote.
//
// Usage: node verify-social-card.js [origin]
//
// Not part of the shipped app and not run in CI.

import { chromium } from 'playwright'

const origin = process.argv[2] ?? 'http://127.0.0.1:5080'

const targets = [
  { name: 'atlas', url: `${origin}/social-card.png` },
  { name: 'city', url: `${origin}/social-card.png?database=sales` },
  { name: 'unknown', url: `${origin}/social-card.png?database=no-such-database` },
]

// Sampled where the card's zones are, so a blank or half-drawn card cannot pass. The text band sits
// above the tower ceiling; the ground sits below the horizon.
const probes = [
  { name: 'sky (top-left)', x: 40, y: 30 },
  { name: 'headline band', x: 600, y: 150 },
  { name: 'skyline', x: 600, y: 400 },
  { name: 'ground', x: 600, y: 580 },
  { name: 'sun', x: 1010, y: 300 },
]

const failures = []
const check = (ok, message) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${message}`)
  if (!ok) failures.push(message)
}

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })

for (const target of targets) {
  console.log(`\n${target.name}  ${target.url}`)

  const result = await page.evaluate(async (url) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    const loaded = new Promise((resolve, reject) => {
      image.onload = () => resolve(true)
      image.onerror = () => reject(new Error('decode failed'))
    })
    image.src = url
    await loaded

    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)

    const at = (x, y) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3)

    // Distinct colours across the whole card. A flat fill decodes fine and shows nothing.
    const wide = context.getImageData(0, 0, canvas.width, canvas.height).data
    const seen = new Set()
    for (let index = 0; index < wide.length; index += 4 * 97) {
      seen.add((wide[index] << 16) | (wide[index + 1] << 8) | wide[index + 2])
    }

    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      samples: {
        'sky (top-left)': at(40, 30),
        'headline band': at(600, 150),
        skyline: at(600, 400),
        ground: at(600, 580),
        sun: at(1010, 300),
        'ground under the sun': at(1010, 560),
        'ground far from the sun': at(120, 560),
      },
      distinctColours: seen.size,
    }
  }, target.url)

  check(result.width === 1200 && result.height === 630,
    `decoded 1200x630 (got ${result.width}x${result.height})`)

  for (const probe of probes) {
    const [r, g, b] = result.samples[probe.name]
    // Pure black is what an undrawn buffer reads as, and nothing in the card is drawn pure black.
    check(r + g + b > 0, `${probe.name} is drawn, not an empty buffer  rgb(${r}, ${g}, ${b})`)
  }

  check(result.distinctColours > 200,
    `card carries detail rather than a flat fill (${result.distinctColours} distinct sampled colours)`)

  const [skyR, , skyB] = result.samples['sky (top-left)']
  const near = result.samples['ground under the sun']
  const far = result.samples['ground far from the sun']
  check(skyB > skyR, 'sky is the cool end of the ramp')

  // The ground carries a wash from the sun rather than a flat fill. Comparing warmth across the
  // card is the assertion that holds: the ground is cool everywhere at dusk, and only *relatively*
  // warm where the sun reaches it. Asserting it is warm outright fails on a correct card.
  const warmth = (rgb) => rgb[0] - rgb[2]
  check(warmth(near) > warmth(far),
    `the sun washes the ground it reaches  near ${warmth(near)} > far ${warmth(far)}`)
}

await browser.close()

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
