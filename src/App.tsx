import React, { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

const MAX_CANVAS_PX = 640
const MIN_GRID = 8
const MAX_GRID = 64
const DEFAULT_GRID = 32

type Tool = 'draw' | 'erase' | 'picker'
type ColorCount = 8 | 16 | 32
type Dithering = 'none' | 'bayer4x4'

// 1=Fondo Rosa Pastel, 2=Contorno Negro, 3=Rojo, 4=Rosa, 5=Blanco Interior, 6=Piel Pálida
const INITIAL_PALETTE = ['#FCE4EC', '#000000', '#C61730', '#FF6B97', '#FFFFFF', '#FFE0E5']

// Esta función genera el mapa guía estático (la plantilla) inicial en formato de 32x32
function getSolutionMap(): string[] {
  const grid = new Array<string>(DEFAULT_GRID * DEFAULT_GRID).fill('#FCE4EC')

  const paletteMap: Record<string, string> = {
    '1': '#FCE4EC',
    '2': '#000000',
    '3': '#C61730',
    '4': '#FF6B97',
    '5': '#FFFFFF',
    '6': '#FFE0E5'
  }

  // Trazado de la mitad izquierda basado en image_5c9c03
  const leftHalf = [
    "1111111111111111", // 00
    "1111111111111111", // 01
    "1111111111111111", // 02
    "1111111112222166", // 03
    "1111111124564226", // 04
    "1111111245255426", // 05
    "1111111245425426", // 06
    "1111111245254262", // 07
    "1111111122554262", // 08
    "1111111111124222", // 09
    "1111111111224262", // 10
    "1111111112224226", // 11
    "1111111122424226", // 12
    "1111111244442266", // 13
    "1111112444442666", // 14
    "1111122444426666", // 15
    "1111242444422666", // 16
    "1111242244426662", // 17
    "1112244424255266", // 18
    "1112244422555556", // 19
    "1124222252555566", // 20
    "1123333222555562", // 21
    "1123333255555552", // 22
    "1123333225555533", // 23
    "1123333225555533", // 24
    "1112333333225523", // 25
    "1112333333322233", // 26
    "1111223333333311", // 27
    "1111112222332311", // 28
    "1111111111231111", // 29
    "1111111111111111", // 30
    "1111111111111111"  // 31
  ]

  for (let y = 0; y < DEFAULT_GRID; y++) {
    const rowLeft = leftHalf[y]
    const rowRight = rowLeft.split('').reverse().join('')
    const fullRow = rowLeft + rowRight

    for (let x = 0; x < DEFAULT_GRID; x++) {
      const char = fullRow[x]
      const color = paletteMap[char]
      if (color) {
        grid[y * DEFAULT_GRID + x] = color
      }
    }
  }
  return grid
}

// ---------- Utilidades de procesamiento de imagen (pixel art), 100% en cliente ----------

const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
]

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function toHex(r: number, g: number, b: number) {
  const h = (n: number) => n.toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase()
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function colorDistance(a: [number, number, number], b: [number, number, number]) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
}

/** Devuelve el color de `palette` más cercano a `hex` (o el propio `hex` si ya está incluido). */
function nearestPaletteColor(hex: string, palette: string[]): string {
  if (palette.includes(hex)) return hex
  if (palette.length === 0) return hex
  const target = hexToRgb(hex)
  let best = palette[0]
  let bestDist = Infinity
  for (const candidate of palette) {
    const d = colorDistance(target, hexToRgb(candidate))
    if (d < bestDist) {
      bestDist = d
      best = candidate
    }
  }
  return best
}

/** Lee la imagen a su resolución nativa para poder muestrear bloques sin perder detalle. */
function getNativeImageData(img: HTMLImageElement) {
  const nw = img.naturalWidth || img.width
  const nh = img.naturalHeight || img.height
  const off = document.createElement('canvas')
  off.width = nw
  off.height = nh
  const ctx = off.getContext('2d')!
  ctx.drawImage(img, 0, 0, nw, nh)
  return { data: ctx.getImageData(0, 0, nw, nh).data, width: nw, height: nh }
}

function detectPixelGrid(width: number, height: number, data: Uint8ClampedArray) {
  if (width <= 8 || height <= 8) return null;

  // Probamos tamaños de celda candidatos desde 1 hasta Math.min(width, height, 64)
  // Un tamaño de celda candidato c debe dividir exactamente a 'width' y a 'height'
  const limit = Math.min(width, height, 64);
  const candidates: number[] = [];
  for (let c = 1; c <= limit; c++) {
    if (width % c === 0 && height % c === 0) {
      candidates.push(c);
    }
  }

  // Ordenamos de mayor a menor para probar primero celdas grandes (pixelart con bloques grandes)
  candidates.sort((a, b) => b - a);

  const threshold = 0.95; // Un 95% de los píxeles del bloque deben coincidir con la moda para aceptar el tamaño de celda

  for (const c of candidates) {
    if (c === 1) continue; // 1 siempre es 100% uniforme, se deja como fallback

    let matchingPixels = 0;
    const blocksX = width / c;
    const blocksY = height / c;

    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        const colorCounts = new Map<string, number>();
        for (let dy = 0; dy < c; dy++) {
          for (let dx = 0; dx < c; dx++) {
            const px = bx * c + dx;
            const py = by * c + dy;
            const idx = (py * width + px) * 4;

            const a = data[idx + 3];
            if (a < 128) {
              colorCounts.set('transparent', (colorCounts.get('transparent') || 0) + 1);
            } else {
              // Agrupamos colores ligeramente para tolerar pequeñas imperfecciones o compresión JPEG
              const r = Math.round(data[idx] / 12) * 12;
              const g = Math.round(data[idx + 1] / 12) * 12;
              const b = Math.round(data[idx + 2] / 12) * 12;
              const key = `${r},${g},${b}`;
              colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
            }
          }
        }

        let modeCount = 0;
        colorCounts.forEach((count) => {
          if (count > modeCount) {
            modeCount = count;
          }
        });
        matchingPixels += modeCount;
      }
    }

    const score = matchingPixels / (width * height);
    if (score >= threshold) {
      return { width: width / c, height: height / c, cell: c };
    }
  }

  return { width, height, cell: 1 };
}

// ---------- Utilidades de Serialización / RLE para compartir sin Base de Datos ----------

// Codifica un índice de paleta a una letra: 0 -> 'a', 25 -> 'z', 26 -> 'A', 51 -> 'Z'
function indexToChar(idx: number): string {
  if (idx < 26) return String.fromCharCode(97 + idx); // a-z
  return String.fromCharCode(65 + idx - 26); // A-Z
}

// Decodifica una letra a un índice de paleta
function charToIdx(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 97 && code <= 122) return code - 97; // a-z
  if (code >= 65 && code <= 90) return code - 65 + 26; // A-Z
  return 0;
}

// Comprime el targetMap a una cadena RLE usando la paleta
function compressGrid(targetMap: string[], palette: string[]): string {
  const indices = targetMap.map(color => {
    const idx = palette.indexOf(color);
    return idx >= 0 ? idx : 0;
  });

  let compressed = '';
  let i = 0;
  while (i < indices.length) {
    let runLength = 1;
    const char = indexToChar(indices[i]);
    while (i + runLength < indices.length && indexToChar(indices[i + runLength]) === char) {
      runLength++;
    }
    if (runLength > 1) {
      compressed += runLength + char;
    } else {
      compressed += char;
    }
    i += runLength;
  }
  return compressed;
}

// Descomprime una cadena RLE a un array de colores (string[]) usando la paleta
function decompressGrid(compressed: string, palette: string[], expectedSize: number): string[] {
  const grid: string[] = [];
  let i = 0;
  while (i < compressed.length) {
    let countStr = '';
    while (i < compressed.length && /[0-9]/.test(compressed[i])) {
      countStr += compressed[i];
      i++;
    }
    const count = countStr ? parseInt(countStr, 10) : 1;
    if (i < compressed.length) {
      const char = compressed[i];
      const idx = charToIdx(char);
      const color = palette[idx] ?? palette[0] ?? '#FFFFFF';
      for (let c = 0; c < count; c++) {
        grid.push(color);
      }
      i++;
    } else {
      break;
    }
  }
  while (grid.length < expectedSize) {
    grid.push(palette[0] ?? '#FFFFFF');
  }
  return grid.slice(0, expectedSize);
}

/**
 * Reduce una imagen a una cuadrícula de pixel art con una paleta acotada de colores.
 * Para evitar el "ruido" gris típico al re-escanear un pixel art ya existente (bordes
 * semitransparentes mezclándose con el fondo), cada celda toma el color MÁS FRECUENTE
 * (moda) de su bloque de píxeles nativos en vez de promediarlos, y los píxeles casi
 * transparentes se ignoran por completo en vez de mezclarse con el color de fondo.
 */
function quantizeImage(img: HTMLImageElement, w: number, h: number, colorCount: ColorCount, dithering: Dithering) {
  const { data, width: nw, height: nh } = getNativeImageData(img)
  const detected = detectPixelGrid(nw, nh, data)

  const rawColors: string[] = new Array(w * h)

  for (let cy = 0; cy < h; cy++) {
    const y0 = Math.floor((cy * nh) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * nh) / h))
    for (let cx = 0; cx < w; cx++) {
      const x0 = Math.floor((cx * nw) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * nw) / w))

      const blockFreq = new Map<string, number>()
      let opaqueCount = 0

      const sourceX0 = detected ? Math.floor((cx * detected.width) / w) : x0
      const sourceX1 = detected ? Math.max(sourceX0 + 1, Math.floor(((cx + 1) * detected.width) / w)) : x1
      const sourceY0 = detected ? Math.floor((cy * detected.height) / h) : y0
      const sourceY1 = detected ? Math.max(sourceY0 + 1, Math.floor(((cy + 1) * detected.height) / h)) : y1

      for (let sourceY = sourceY0; sourceY < sourceY1; sourceY++) {
        for (let sourceX = sourceX0; sourceX < sourceX1; sourceX++) {
          const x = detected
            ? clamp(sourceX * detected.cell + Math.floor(detected.cell / 2), 0, nw - 1)
            : sourceX
          const y = detected
            ? clamp(sourceY * detected.cell + Math.floor(detected.cell / 2), 0, nh - 1)
            : sourceY
          const idx = (y * nw + x) * 4
          const a = data[idx + 3]
          if (a < 128) continue // ignora píxeles transparentes/casi transparentes (evita el "fringing" gris)
          const key = toHex(data[idx], data[idx + 1], data[idx + 2])
          blockFreq.set(key, (blockFreq.get(key) || 0) + 1)
          opaqueCount++
        }
      }

      if (opaqueCount === 0) {
        rawColors[cy * w + cx] = '#FFFFFF'
        continue
      }

      let modeColor = '#FFFFFF'
      let modeCount = -1
      blockFreq.forEach((count, key) => {
        if (count > modeCount) {
          modeCount = count
          modeColor = key
        }
      })
      rawColors[cy * w + cx] = modeColor
    }
  }

  const distinctFreq = new Map<string, number>()
  for (const c of rawColors) distinctFreq.set(c, (distinctFreq.get(c) || 0) + 1)

  // Si ya hay menos colores distintos que el conteo pedido, se reproducen tal cual (sin ditherizar).
  if (distinctFreq.size <= colorCount) {
    const palette = [...distinctFreq.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex)
    return { grid: rawColors, palette }
  }

  // Si hay más colores de los pedidos, se agrupan (posterizado) solo entonces se aplica dithering opcional.
  const levels = colorCount === 8 ? 3 : colorCount === 16 ? 4 : 6
  const step = 255 / (levels - 1)

  const bucketed = rawColors.map((hex, i) => {
    let [r, g, b] = hexToRgb(hex)
    if (dithering === 'bayer4x4') {
      const x = i % w, y = Math.floor(i / w)
      const threshold = (BAYER_4X4[y % 4][x % 4] / 16 - 0.5) * step
      r += threshold
      g += threshold
      b += threshold
    }
    r = clamp(Math.round(Math.round(clamp(r, 0, 255) / step) * step), 0, 255)
    g = clamp(Math.round(Math.round(clamp(g, 0, 255) / step) * step), 0, 255)
    b = clamp(Math.round(Math.round(clamp(b, 0, 255) / step) * step), 0, 255)
    return toHex(r, g, b)
  })

  const freq2 = new Map<string, number>()
  for (const c of bucketed) freq2.set(c, (freq2.get(c) || 0) + 1)

  const palette = [...freq2.entries()].sort((a, b) => b[1] - a[1]).slice(0, colorCount).map(([hex]) => hex)
  const nearestCache = new Map<string, string>()

  const grid = bucketed.map(hex => {
    if (palette.includes(hex)) return hex
    const cached = nearestCache.get(hex)
    if (cached) return cached
    const best = nearestPaletteColor(hex, palette)
    nearestCache.set(hex, best)
    return best
  })

  return { grid, palette }
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [gridW, setGridW] = useState(DEFAULT_GRID)
  const [gridH, setGridH] = useState(DEFAULT_GRID)
  const [targetMap, setTargetMap] = useState<string[]>(() => getSolutionMap())

  // El lienzo inicial comienza completamente vacío (null = sin color pintado por el usuario)
  const [pixels, setPixels] = useState<(string | null)[]>(() => new Array(DEFAULT_GRID * DEFAULT_GRID).fill(null))
  const [palette, setPalette] = useState<string[]>(INITIAL_PALETTE)

  const cellSize = Math.max(2, Math.floor(MAX_CANVAS_PX / Math.max(gridW, gridH)))
  const canvasPxW = gridW * cellSize
  const canvasPxH = gridH * cellSize

  const [cursor, setCursor] = useState({ x: 0, y: 0 })
  const [tool, setTool] = useState<Tool>('draw')
  const [activeSlot, setActiveSlot] = useState(0)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  const [mobileZoom, setMobileZoom] = useState(1)

  const activeColor = palette[activeSlot] ?? palette[0]

  // ---------- Estado del modal "Importar imagen" (solo visual/en memoria; se pierde al recargar) ----------
  const [importOpen, setImportOpen] = useState(false)
  const [importStep, setImportStep] = useState<1 | 2>(1)
  const [sourceImg, setSourceImg] = useState<HTMLImageElement | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [cfgWidth, setCfgWidth] = useState(32)
  const [cfgHeight, setCfgHeight] = useState(32)
  const [lockAspect, setLockAspect] = useState(true)
  const [colorCount, setColorCount] = useState<ColorCount>(16)
  const [dithering, setDithering] = useState<Dithering>('none') // Por defecto 'none' para pixelart
  const [extractedPalette, setExtractedPalette] = useState<string[]>([])
  const [previewGrid, setPreviewGrid] = useState<string[]>([])

  const aspectRef = useRef(1)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)

  // ---------- Estado para compartir y exportar en alta calidad ----------
  const [exportOpen, setExportOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [showPreviewScreen, setShowPreviewScreen] = useState(false)
  const [sharedData, setSharedData] = useState<{ w: number; h: number; palette: string[]; grid: string[] } | null>(null)

  const previewSharedCanvasRef = useRef<HTMLCanvasElement>(null)
  const isPaintingRef = useRef(false)
  const lastPaintedCellRef = useRef<string | null>(null)
  const touchPointsRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)')
    const updateMobileLayout = () => setIsMobile(media.matches)
    updateMobileLayout()
    media.addEventListener('change', updateMobileLayout)
    return () => media.removeEventListener('change', updateMobileLayout)
  }, [])

  useEffect(() => {
    if (!isMobile) {
      setMobileZoom(1)
      return
    }
    setMobileZoom(clamp(24 / cellSize, 1, 4))
  }, [isMobile, cellSize])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    // Limpiamos el lienzo antes de cada render
    ctx.clearRect(0, 0, canvasPxW, canvasPxH)

    for (let row = 0; row < gridH; row++) {
      for (let col = 0; col < gridW; col++) {
        const idx = row * gridW + col
        const x = col * cellSize
        const y = row * cellSize

        const paintedColor = pixels[idx]
        const solutionColor = targetMap[idx]

        // 1. Pintar fondo: Si el usuario pintó, usa ese color. Si no, blanco puro.
        ctx.fillStyle = paintedColor ?? '#FFFFFF'
        ctx.fillRect(x, y, cellSize, cellSize)

        // 2. Dibujar cuadrícula
        ctx.strokeStyle = '#FFB0BF' // Borde rosa claro
        ctx.lineWidth = 0.5
        ctx.strokeRect(x, y, cellSize, cellSize)

        // 3. Dibujar el número guía SOLO si la celda no ha sido pintada
        if (!paintedColor && solutionColor) {
          const paletteIndex = palette.indexOf(solutionColor)
          const number = String(paletteIndex + 1)

          // Hacemos el "1" gris clarito para no saturar, y el resto negro nítido
          ctx.fillStyle = paletteIndex === 0 ? '#E0E0E0' : '#000000'
          ctx.font = `bold ${Math.max(7, Math.floor(cellSize * 0.55))}px monospace`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(number, x + cellSize / 2, y + cellSize / 2)
        }
      }
    }

    // Dibujar cursor
    const cx = cursor.x * cellSize
    const cy = cursor.y * cellSize
    ctx.strokeStyle = '#ffee44'
    ctx.lineWidth = 2
    ctx.strokeRect(cx + 1, cy + 1, cellSize - 2, cellSize - 2)
  }, [pixels, cursor, palette, targetMap, gridW, gridH, cellSize, canvasPxW, canvasPxH])

  const applyToolAt = useCallback((x: number, y: number, activeTool: Tool = tool) => {
    const idx = y * gridW + x
    if (activeTool === 'draw') {
      setPixels(prev => {
        const next = [...prev]
        next[idx] = activeColor
        return next
      })
    } else if (activeTool === 'erase') {
      setPixels(prev => {
        const next = [...prev]
        next[idx] = null
        return next
      })
    } else if (activeTool === 'picker') {
      const color = pixels[idx] || targetMap[idx] // Permite hacer pick de la solución si no está pintado
      if (color) {
        const slot = palette.indexOf(color)
        if (slot >= 0) setActiveSlot(slot)
      }
    }
  }, [tool, activeColor, pixels, targetMap, palette, gridW])

  const executeTool = useCallback(() => {
    applyToolAt(cursor.x, cursor.y)
  }, [applyToolAt, cursor])

  const eraseAt = useCallback((x: number, y: number) => {
    const idx = y * gridW + x
    setPixels(prev => {
      const next = [...prev]
      next[idx] = null
      return next
    })
  }, [gridW])

  const paintAtPointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const px = (e.clientX - rect.left) * scaleX
    const py = (e.clientY - rect.top) * scaleY
    const col = clamp(Math.floor(px / cellSize), 0, gridW - 1)
    const row = clamp(Math.floor(py / cellSize), 0, gridH - 1)
    setCursor({ x: col, y: row })
    applyToolAt(col, row)
    return `${col},${row}`
  }, [cellSize, gridW, gridH, applyToolAt])

  const handleCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)

    if (isMobile && e.pointerType === 'touch') {
      touchPointsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (touchPointsRef.current.size === 2) {
        const [firstPoint, secondPoint] = [...touchPointsRef.current.values()]
        pinchRef.current = {
          distance: Math.max(Math.hypot(secondPoint.x - firstPoint.x, secondPoint.y - firstPoint.y), 1),
          zoom: mobileZoom
        }
        isPaintingRef.current = false
        lastPaintedCellRef.current = null
        e.preventDefault()
        return
      }
    }

    isPaintingRef.current = true
    lastPaintedCellRef.current = paintAtPointer(e)
  }, [isMobile, mobileZoom, paintAtPointer])

  const handleCanvasPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isMobile && e.pointerType === 'touch' && touchPointsRef.current.has(e.pointerId)) {
      touchPointsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const pinch = pinchRef.current

      if (touchPointsRef.current.size === 2 && pinch) {
        const [firstPoint, secondPoint] = [...touchPointsRef.current.values()]
        const distance = Math.hypot(secondPoint.x - firstPoint.x, secondPoint.y - firstPoint.y)
        setMobileZoom(clamp(pinch.zoom * distance / pinch.distance, 1, 4))
        e.preventDefault()
        return
      }
    }

    if (!isPaintingRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const col = clamp(Math.floor(((e.clientX - rect.left) * canvas.width / rect.width) / cellSize), 0, gridW - 1)
    const row = clamp(Math.floor(((e.clientY - rect.top) * canvas.height / rect.height) / cellSize), 0, gridH - 1)
    const cell = `${col},${row}`
    if (cell !== lastPaintedCellRef.current) {
      lastPaintedCellRef.current = paintAtPointer(e)
    }
  }, [cellSize, gridW, gridH, isMobile, paintAtPointer])

  const stopCanvasPainting = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    touchPointsRef.current.delete(e.pointerId)
    if (touchPointsRef.current.size < 2) pinchRef.current = null
    isPaintingRef.current = false
    lastPaintedCellRef.current = null
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (importOpen) return // no navegar el lienzo mientras el modal está abierto
      const key = e.key.toLowerCase()

      if (['w', 'a', 's', 'd', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'backspace', 'delete'].includes(key)) {
        e.preventDefault()
      }

      if (key === 'w' || key === 'arrowup') {
        setCursor(c => ({ ...c, y: Math.max(0, c.y - 1) }))
      } else if (key === 's' || key === 'arrowdown') {
        setCursor(c => ({ ...c, y: Math.min(gridH - 1, c.y + 1) }))
      } else if (key === 'a' || key === 'arrowleft') {
        setCursor(c => ({ ...c, x: Math.max(0, c.x - 1) }))
      } else if (key === 'd' || key === 'arrowright') {
        setCursor(c => ({ ...c, x: Math.min(gridW - 1, c.x + 1) }))
      } else if (key === ' ') {
        executeTool()
      } else if (key === 'backspace' || key === 'delete') {
        // Atajo rápido para borrar la celda actual sin cambiar de herramienta activa
        eraseAt(cursor.x, cursor.y)
      } else if (/^[0-9]$/.test(key)) {
        // Los dígitos 1-9 (y 0 para el 10º) seleccionan el color de la paleta directamente
        const slot = key === '0' ? 9 : Number(key) - 1
        if (slot < palette.length) setActiveSlot(slot)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [executeTool, eraseAt, gridW, gridH, importOpen, cursor, palette])

  // ---------- Cargar dibujo compartido desde la URL ----------
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const wStr = params.get('w')
    const hStr = params.get('h')
    const pStr = params.get('p')
    const gStr = params.get('g')

    if (wStr && hStr && pStr && gStr) {
      const w = clamp(parseInt(wStr, 10), MIN_GRID, MAX_GRID)
      const h = clamp(parseInt(hStr, 10), MIN_GRID, MAX_GRID)
      const pal = pStr.split(',').map(c => (c.startsWith('#') ? c : `#${c}`))
      const grid = decompressGrid(gStr, pal, w * h)

      setSharedData({ w, h, palette: pal, grid })
      setShowPreviewScreen(true)
    }
  }, [])

  // Dibuja la miniatura de vista previa para el dibujo compartido
  useEffect(() => {
    if (!showPreviewScreen || !sharedData) return
    const canvas = previewSharedCanvasRef.current
    if (!canvas) return

    const size = 12 // Tamaño de celda en píxeles para la miniatura
    canvas.width = sharedData.w * size
    canvas.height = sharedData.h * size
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    for (let row = 0; row < sharedData.h; row++) {
      for (let col = 0; col < sharedData.w; col++) {
        const color = sharedData.grid[row * sharedData.w + col]
        ctx.fillStyle = color
        ctx.fillRect(col * size, row * size, size, size)
      }
    }
  }, [showPreviewScreen, sharedData])

  // Genera el enlace para compartir cuando se abre el modal
  useEffect(() => {
    if (shareOpen) {
      const paletteHexes = palette.map(c => c.replace('#', ''))
      const compressedG = compressGrid(targetMap, palette)
      const url = new URL(window.location.href)
      url.search = '' // Limpiar parámetros anteriores
      url.searchParams.set('w', String(gridW))
      url.searchParams.set('h', String(gridH))
      url.searchParams.set('p', paletteHexes.join(','))
      url.searchParams.set('g', compressedG)
      setShareUrl(url.toString())
      setCopied(false)
      setCopyError('')
    }
  }, [shareOpen, gridW, gridH, palette, targetMap])

  // Función de exportación de imagen mejorada en alta resolución
  const exportImage = (type: 'current' | 'clean' | 'template') => {
    // Escala del pixelart exportado: cada celda medirá 32x32 píxeles reales
    const exportCellSize = 32
    const w = gridW * exportCellSize
    const h = gridH * exportCellSize

    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const ctx = off.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    for (let row = 0; row < gridH; row++) {
      for (let col = 0; col < gridW; col++) {
        const idx = row * gridW + col
        const x = col * exportCellSize
        const y = row * exportCellSize

        const paintedColor = pixels[idx]
        const solutionColor = targetMap[idx]

        if (type === 'clean') {
          // Arte limpio: Se exporta el color de la solución (o el pintado, pero la solución es el diseño final completo)
          ctx.fillStyle = solutionColor ?? '#FFFFFF'
          ctx.fillRect(x, y, exportCellSize, exportCellSize)
        } else if (type === 'template') {
          // Plantilla vacía con números guía
          ctx.fillStyle = '#FFFFFF'
          ctx.fillRect(x, y, exportCellSize, exportCellSize)

          ctx.strokeStyle = '#FFB0BF'
          ctx.lineWidth = 1
          ctx.strokeRect(x, y, exportCellSize, exportCellSize)

          if (solutionColor) {
            const paletteIndex = palette.indexOf(solutionColor)
            const number = String(paletteIndex + 1)
            ctx.fillStyle = paletteIndex === 0 ? '#C0C0C0' : '#000000'
            ctx.font = `bold ${Math.floor(exportCellSize * 0.5)}px monospace`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(number, x + exportCellSize / 2, y + exportCellSize / 2)
          }
        } else {
          // 'current': Progreso actual pintado por el usuario con guía restante
          ctx.fillStyle = paintedColor ?? '#FFFFFF'
          ctx.fillRect(x, y, exportCellSize, exportCellSize)

          ctx.strokeStyle = '#FFB0BF'
          ctx.lineWidth = 1
          ctx.strokeRect(x, y, exportCellSize, exportCellSize)

          if (!paintedColor && solutionColor) {
            const paletteIndex = palette.indexOf(solutionColor)
            const number = String(paletteIndex + 1)
            ctx.fillStyle = paletteIndex === 0 ? '#C0C0C0' : '#000000'
            ctx.font = `bold ${Math.floor(exportCellSize * 0.5)}px monospace`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(number, x + exportCellSize / 2, y + exportCellSize / 2)
          }
        }
      }
    }

    const link = document.createElement('a')
    link.download = `pixela_${type}_${gridW}x${gridH}.png`
    link.href = off.toDataURL('image/png')
    link.click()
  }

  const handleExport = () => {
    setExportOpen(true)
  }

  const handleCopyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setCopyError('')
    } catch {
      setCopied(false)
      setCopyError('No se pudo copiar automáticamente. Selecciona y copia el enlace manualmente.')
    }
  }

  // ---------- Manejo del modal de importación de imagen ----------

  const resetImportState = () => {
    setImportOpen(false)
    setImportStep(1)
    setSourceImg(null)
    setSourceUrl(null)
    setExtractedPalette([])
    setPreviewGrid([])
  }

  const handleFile = (file: File | undefined | null) => {
    if (!file || !file.type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      aspectRef.current = img.naturalWidth / img.naturalHeight
      const { data, width, height } = getNativeImageData(img)
      const detected = detectPixelGrid(width, height, data)
      if (detected && detected.width >= MIN_GRID && detected.width <= MAX_GRID && detected.height >= MIN_GRID && detected.height <= MAX_GRID) {
        setCfgWidth(detected.width)
        setCfgHeight(detected.height)
      }
      setSourceImg(img)
      setSourceUrl(url)
    }
    img.src = url
  }

  const handleWidthChange = (v: number) => {
    setCfgWidth(v)
    if (lockAspect) setCfgHeight(clamp(Math.round(v / aspectRef.current), MIN_GRID, MAX_GRID))
  }

  const handleHeightChange = (v: number) => {
    setCfgHeight(v)
    if (lockAspect) setCfgWidth(clamp(Math.round(v * aspectRef.current), MIN_GRID, MAX_GRID))
  }

  // Recalcula la vista previa pixelada cada vez que cambia alguna opción del paso 2
  useEffect(() => {
    if (!sourceImg || importStep !== 2) return
    const { grid, palette: pal } = quantizeImage(sourceImg, cfgWidth, cfgHeight, colorCount, dithering)
    setExtractedPalette(pal)
    setPreviewGrid(grid)
  }, [sourceImg, cfgWidth, cfgHeight, colorCount, dithering, importStep])

  // Dibuja el canvas de vista previa cada vez que la cuadrícula o la paleta (tras eliminar colores) cambian
  useEffect(() => {
    const canvas = previewCanvasRef.current
    if (!canvas || previewGrid.length === 0) return
    canvas.width = cfgWidth
    canvas.height = cfgHeight
    const ctx = canvas.getContext('2d')!
    const imgData = ctx.createImageData(cfgWidth, cfgHeight)
    for (let i = 0; i < previewGrid.length; i++) {
      const [r, g, b] = hexToRgb(previewGrid[i])
      imgData.data[i * 4] = r
      imgData.data[i * 4 + 1] = g
      imgData.data[i * 4 + 2] = b
      imgData.data[i * 4 + 3] = 255
    }
    ctx.putImageData(imgData, 0, 0)
  }, [previewGrid, cfgWidth, cfgHeight])

  // Quita un color de la paleta extraída antes de generar: los píxeles que lo usaban
  // se reasignan al color restante más parecido, en vez de perderse.
  const removeExtractedColor = (color: string) => {
    if (extractedPalette.length <= 1) return
    const newPalette = extractedPalette.filter(c => c !== color)
    setPreviewGrid(prev => prev.map(c => (c === color ? nearestPaletteColor(c, newPalette) : c)))
    setExtractedPalette(newPalette)
  }

  const handleGenerateCanvas = () => {
    if (!sourceImg || previewGrid.length === 0) return
    setGridW(cfgWidth)
    setGridH(cfgHeight)
    setTargetMap(previewGrid)
    setPalette(extractedPalette)
    setPixels(new Array(cfgWidth * cfgHeight).fill(null))
    setActiveSlot(0)
    setCursor({ x: 0, y: 0 })
    resetImportState()
  }

  // Quita un color de la paleta de pintura activa: las celdas pintadas con ese color se
  // desmarcan (para repintarse) y la guía se reasigna al color restante más cercano.
  const removePaletteColor = (color: string) => {
    if (palette.length <= 1) return
    const removedIndex = palette.indexOf(color)
    const newPalette = palette.filter(c => c !== color)
    setTargetMap(prev => prev.map(c => (c === color ? nearestPaletteColor(c, newPalette) : c)))
    setPixels(prev => prev.map(c => (c === color ? null : c)))
    setPalette(newPalette)
    setActiveSlot(prev => {
      if (prev === removedIndex) return 0
      return prev > removedIndex ? prev - 1 : prev
    })
  }

  const tools: { id: Tool; icon: string; label: string }[] = [
    { id: 'draw', icon: '✏️', label: 'Draw' },
    { id: 'erase', icon: '🧹', label: 'Erase' },
    { id: 'picker', icon: '💉', label: 'Picker' },
  ]

  if (showPreviewScreen && sharedData) {
    return (
      <main className="shared-preview-screen">
        <section className="shared-preview-card">
          <div className="topbar-title"><span>Pixela</span> Studio</div>
          <h1>Plantilla compartida</h1>
          <p>{sharedData.w} × {sharedData.h} píxeles · {sharedData.palette.length} colores</p>
          <canvas
            ref={previewSharedCanvasRef}
            className="shared-preview-canvas"
            aria-label="Vista previa de la plantilla compartida"
          />
          <div className="shared-palette" aria-label="Paleta de colores">
            {sharedData.palette.map((color, index) => (
              <span key={color} className="shared-swatch" style={{ background: color }} title={`Color ${index + 1}: ${color}`} />
            ))}
          </div>
          <button
            className="btn-primary"
            onClick={() => {
              setGridW(sharedData.w)
              setGridH(sharedData.h)
              setTargetMap(sharedData.grid)
              setPalette(sharedData.palette)
              setPixels(new Array(sharedData.w * sharedData.h).fill(null))
              setActiveSlot(0)
              setCursor({ x: 0, y: 0 })
              window.history.replaceState({}, '', window.location.pathname)
              setShowPreviewScreen(false)
            }}
          >
            Abrir para pintar
          </button>
        </section>
      </main>
    )
  }

  return (
    <div className="studio">
      <div className="topbar">
        <div className="topbar-title">
          <span>Pixela</span> Studio
        </div>
        <div className="topbar-actions">
          <button className="topbar-btn" onClick={() => setShareOpen(true)} title="Compartir plantilla">
            🔗
          </button>
        </div>
      </div>

      <div className="studio-body">
        <div className="sidebar">
          {tools.map(t => (
            <button
              key={t.id}
              className={`tool-btn${tool === t.id ? ' active' : ''}`}
              onClick={() => setTool(t.id)}
              title={t.label}
            >
              <span className="tool-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
          <div className="sidebar-spacer" />
          <button
            className="tool-btn import-trigger"
            onClick={() => { setImportOpen(true); setImportStep(1) }}
            title="Importar imagen"
          >
            <span className="tool-icon">🖼️</span>
            Import
          </button>
          <button className="tool-btn export-btn" onClick={handleExport} title="Exportar">
            <span className="tool-icon">💾</span>
            Export
          </button>
        </div>

        <div className="main-content">
          <div className="canvas-info">{gridW}x{gridH} &nbsp;&nbsp; Layer 1 &nbsp;&nbsp; {Math.round((isMobile ? mobileZoom : 1) * 100)}%</div>
          {isMobile && (
            <div className="mobile-zoom-controls" role="region" aria-label="Controles de zoom">
              <button 
                className="zoom-btn"
                onClick={() => setMobileZoom(zoom => clamp(zoom - 0.25, 1, 4))} 
                aria-label="Alejar"
              >
                −
              </button>
              <span className="zoom-indicator">
                {Math.round(mobileZoom * 100)}%
              </span>
              <button 
                className="zoom-btn"
                onClick={() => setMobileZoom(zoom => clamp(zoom + 0.25, 1, 4))} 
                aria-label="Acercar"
              >
                +
              </button>
              <button 
                className="auto-zoom-btn"
                onClick={() => setMobileZoom(clamp(24 / cellSize, 1, 4))}
              >
                Auto
              </button>
            </div>
          )}
          <div className="paint-guide">
            Toca, arrastra o haz clic en la cuadrícula para pintar · Pellizca con dos dedos para ajustar el zoom · Números 1-9 seleccionan color · Backspace borra la celda actual.
          </div>

          <div className="canvas-card">
            <canvas
              ref={canvasRef}
              width={canvasPxW}
              height={canvasPxH}
              style={isMobile ? { width: canvasPxW * mobileZoom, height: canvasPxH * mobileZoom } : undefined}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={stopCanvasPainting}
              onPointerCancel={stopCanvasPainting}
            />
          </div>
        </div>
      </div>

      <div className="palette-bar">
        {palette.map((color, i) => (
          <div
            key={i}
            className={`palette-slot${activeSlot === i ? ' active' : ''}`}
            onClick={() => setActiveSlot(i)}
          >
            <div className="palette-swatch" style={{ background: color }} />
            <span>{i + 1}</span>
            {palette.length > 1 && (
              <button
                className="swatch-remove"
                title="Quitar color de la paleta"
                onClick={(e) => { e.stopPropagation(); removePaletteColor(color) }}
              >✕</button>
            )}
          </div>
        ))}
      </div>
      <div className="status-line">
        Cursor ({cursor.x}, {cursor.y}) · Herramienta: {tool} · Número guía: {targetMap[cursor.y * gridW + cursor.x] ? palette.indexOf(targetMap[cursor.y * gridW + cursor.x]) + 1 : 'Vacío'}
      </div>

      {importOpen && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) resetImportState() }}>
          <div className="import-modal">
            <div className="import-modal-header">
              <div>
                <h2>Import Image - Step {importStep}: {importStep === 1 ? 'Upload' : 'Configuration'}</h2>
                <p>{importStep === 1 ? 'Selecciona una imagen para convertirla en una plantilla de pixel art.' : 'Ajusta resolución y profundidad de color.'}</p>
              </div>
              <button className="modal-close" onClick={resetImportState}>✕</button>
            </div>

            {importStep === 1 && (
              <div className="import-step1">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => handleFile(e.target.files?.[0])}
                />
                <div
                  className={`dropzone${isDragging ? ' dragging' : ''}${sourceUrl ? ' has-image' : ''}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setIsDragging(false)
                    handleFile(e.dataTransfer.files?.[0])
                  }}
                >
                  {sourceUrl ? (
                    <img src={sourceUrl} alt="original" className="dropzone-preview" />
                  ) : (
                    <>
                      <span className="dropzone-icon">📁</span>
                      <p>Haz clic o arrastra una imagen aquí</p>
                      <span className="dropzone-hint">PNG, JPG, WEBP</span>
                    </>
                  )}
                </div>
                <div className="import-modal-footer">
                  <button className="btn-outline" onClick={resetImportState}>Cancel</button>
                  <button className="btn-primary" disabled={!sourceImg} onClick={() => setImportStep(2)}>Next →</button>
                </div>
              </div>
            )}

            {importStep === 2 && sourceUrl && (
              <>
                <div className="import-step2">
                  <div className="preview-col">
                    <h3>Original</h3>
                    <div className="preview-box">
                      <img src={sourceUrl} alt="original" />
                    </div>
                  </div>
                  <div className="preview-col">
                    <h3>Pixelated Preview</h3>
                    <div className="preview-box">
                      <canvas ref={previewCanvasRef} className="pixel-preview-canvas" />
                    </div>
                  </div>
                  <div className="config-col">
                    <div className="config-block">
                      <h3>Resolution</h3>
                      <label className="slider-row">
                        <span>Width</span>
                        <input type="range" min={MIN_GRID} max={MAX_GRID} value={cfgWidth} onChange={(e) => handleWidthChange(Number(e.target.value))} />
                        <span className="slider-value">{cfgWidth}px</span>
                      </label>
                      <label className="slider-row">
                        <span>Height</span>
                        <input type="range" min={MIN_GRID} max={MAX_GRID} value={cfgHeight} onChange={(e) => handleHeightChange(Number(e.target.value))} />
                        <span className="slider-value">{cfgHeight}px</span>
                      </label>
                      <label className="check-row">
                        <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} />
                        Lock Aspect Ratio
                      </label>
                    </div>

                    <div className="config-block">
                      <h3>Color Count</h3>
                      <div className="segmented">
                        {[8, 16, 32].map(n => (
                          <button
                            key={n}
                            className={colorCount === n ? 'active' : ''}
                            onClick={() => setColorCount(n as ColorCount)}
                          >{n}</button>
                        ))}
                      </div>
                    </div>

                    <div className="config-block">
                      <h3>Dithering</h3>
                      <select value={dithering} onChange={(e) => setDithering(e.target.value as Dithering)}>
                        <option value="none">None</option>
                        <option value="bayer4x4">Bayer 4x4</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="scan-tips">
                  <h3>Consejos para escanear pixel art existente</h3>
                  <ul>
                    <li>Desactiva el <strong>Dithering</strong> ("None") para no mezclar colores que no existen en el original.</li>
                    <li>Ajusta <strong>Color Count</strong> al número real de colores del sprite (cuenta los tonos a simple vista).</li>
                    <li>Iguala Width/Height al tamaño real en píxeles del sprite original para una lectura 1 a 1, sin bloques desalineados.</li>
                    <li>Si aparecen colores "fantasma" (grises de bordes semitransparentes), quítalos con la ✕ de la paleta extraída.</li>
                  </ul>
                </div>

                <div className="extracted-palette">
                  <h3>Extracted Palette ({extractedPalette.length} colors)</h3>
                  <div className="extracted-swatches">
                    {extractedPalette.map((c, i) => (
                      <div key={i} className="extracted-swatch-wrap">
                        <div className="extracted-swatch" style={{ background: c }} title={c} />
                        {extractedPalette.length > 1 && (
                          <button
                            className="swatch-remove extracted"
                            title="Quitar color"
                            onClick={() => removeExtractedColor(c)}
                          >✕</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="import-modal-footer">
                  <button className="btn-outline" onClick={() => setImportStep(1)}>← Back</button>
                  <button className="btn-primary" onClick={handleGenerateCanvas}>Generate Canvas →</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {exportOpen && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setExportOpen(false) }}>
          <div className="action-modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
            <div className="import-modal-header">
              <div>
                <h2 id="export-title">Exportar PNG</h2>
                <p>Cada celda se exportará a 32 × 32 píxeles sin suavizado.</p>
              </div>
              <button className="modal-close" onClick={() => setExportOpen(false)} aria-label="Cerrar">✕</button>
            </div>
            <div className="action-options">
              <button className="btn-primary" onClick={() => { exportImage('current'); setExportOpen(false) }}>Progreso actual</button>
              <button className="btn-outline" onClick={() => { exportImage('clean'); setExportOpen(false) }}>Arte limpio</button>
              <button className="btn-outline" onClick={() => { exportImage('template'); setExportOpen(false) }}>Plantilla numerada</button>
            </div>
          </div>
        </div>
      )}

      {shareOpen && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShareOpen(false) }}>
          <div className="action-modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
            <div className="import-modal-header">
              <div>
                <h2 id="share-title">Compartir plantilla</h2>
                <p>El enlace contiene la cuadrícula y su paleta; no se almacenan datos en un servidor.</p>
              </div>
              <button className="modal-close" onClick={() => setShareOpen(false)} aria-label="Cerrar">✕</button>
            </div>
            <label className="share-url-label" htmlFor="share-url">Enlace compartible</label>
            <input id="share-url" className="share-url" value={shareUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
            {copyError && <p className="action-error" role="alert">{copyError}</p>}
            <div className="action-options">
              <button className="btn-primary" onClick={handleCopyShareUrl}>{copied ? '¡Copiado!' : 'Copiar enlace'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
