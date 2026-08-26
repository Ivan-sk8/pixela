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

/** Reduce una imagen a una cuadrícula de pixel art con una paleta acotada de colores. */
function quantizeImage(img: HTMLImageElement, w: number, h: number, colorCount: ColorCount, dithering: Dithering) {
  const off = document.createElement('canvas')
  off.width = w
  off.height = h
  const ctx = off.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(img, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)

  const levels = colorCount === 8 ? 3 : colorCount === 16 ? 4 : 6
  const step = 255 / (levels - 1)

  const rawColors: [number, number, number][] = new Array(w * h)
  const freq = new Map<string, number>()

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4
      let r = data[idx], g = data[idx + 1], b = data[idx + 2]

      if (dithering === 'bayer4x4') {
        const threshold = (BAYER_4X4[y % 4][x % 4] / 16 - 0.5) * step
        r += threshold
        g += threshold
        b += threshold
      }

      r = clamp(Math.round(Math.round(clamp(r, 0, 255) / step) * step), 0, 255)
      g = clamp(Math.round(Math.round(clamp(g, 0, 255) / step) * step), 0, 255)
      b = clamp(Math.round(Math.round(clamp(b, 0, 255) / step) * step), 0, 255)

      rawColors[y * w + x] = [r, g, b]
      const key = toHex(r, g, b)
      freq.set(key, (freq.get(key) || 0) + 1)
    }
  }

  const palette = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, colorCount)
    .map(([hex]) => hex)

  const paletteRgb = palette.map(hexToRgb)
  const nearestCache = new Map<string, string>()

  const grid = rawColors.map(rgb => {
    const key = toHex(rgb[0], rgb[1], rgb[2])
    if (palette.includes(key)) return key
    const cached = nearestCache.get(key)
    if (cached) return cached
    let best = palette[0]
    let bestDist = Infinity
    for (let i = 0; i < paletteRgb.length; i++) {
      const d = colorDistance(rgb, paletteRgb[i])
      if (d < bestDist) {
        bestDist = d
        best = palette[i]
      }
    }
    nearestCache.set(key, best)
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
  const [dithering, setDithering] = useState<Dithering>('bayer4x4')
  const [extractedPalette, setExtractedPalette] = useState<string[]>([])

  const aspectRef = useRef(1)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)

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

  const handleCanvasPointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const px = (e.clientX - rect.left) * scaleX
    const py = (e.clientY - rect.top) * scaleY
    const col = clamp(Math.floor(px / cellSize), 0, gridW - 1)
    const row = clamp(Math.floor(py / cellSize), 0, gridH - 1)
    setCursor({ x: col, y: row })
    applyToolAt(col, row)
  }, [cellSize, gridW, gridH, applyToolAt])

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

  const handleExport = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'pixela.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  // ---------- Manejo del modal de importación de imagen ----------

  const resetImportState = () => {
    setImportOpen(false)
    setImportStep(1)
    setSourceImg(null)
    setSourceUrl(null)
    setExtractedPalette([])
  }

  const handleFile = (file: File | undefined | null) => {
    if (!file || !file.type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      aspectRef.current = img.naturalWidth / img.naturalHeight
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

    const canvas = previewCanvasRef.current
    if (canvas) {
      canvas.width = cfgWidth
      canvas.height = cfgHeight
      const ctx = canvas.getContext('2d')!
      const imgData = ctx.createImageData(cfgWidth, cfgHeight)
      for (let i = 0; i < grid.length; i++) {
        const [r, g, b] = hexToRgb(grid[i])
        imgData.data[i * 4] = r
        imgData.data[i * 4 + 1] = g
        imgData.data[i * 4 + 2] = b
        imgData.data[i * 4 + 3] = 255
      }
      ctx.putImageData(imgData, 0, 0)
    }
  }, [sourceImg, cfgWidth, cfgHeight, colorCount, dithering, importStep])

  const handleGenerateCanvas = () => {
    if (!sourceImg) return
    const { grid, palette: pal } = quantizeImage(sourceImg, cfgWidth, cfgHeight, colorCount, dithering)
    setGridW(cfgWidth)
    setGridH(cfgHeight)
    setTargetMap(grid)
    setPalette(pal)
    setPixels(new Array(cfgWidth * cfgHeight).fill(null))
    setActiveSlot(0)
    setCursor({ x: 0, y: 0 })
    resetImportState()
  }

  const tools: { id: Tool; icon: string; label: string }[] = [
    { id: 'draw', icon: '✏️', label: 'Draw' },
    { id: 'erase', icon: '🧹', label: 'Erase' },
    { id: 'picker', icon: '💉', label: 'Picker' },
  ]

  return (
    <div className="studio">
      <div className="topbar">
        <div className="topbar-title">
          <span>Pixela</span> Studio
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
          <div className="canvas-info">{gridW}x{gridH} &nbsp;&nbsp; Layer 1 &nbsp;&nbsp; 100%</div>
          <div className="paint-guide">
            Toca o haz clic en la cuadrícula para pintar · Números 1-9 seleccionan color · Backspace borra la celda actual.
          </div>
          <div className="canvas-card">
            <canvas
              ref={canvasRef}
              width={canvasPxW}
              height={canvasPxH}
              onPointerDown={handleCanvasPointer}
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

                <div className="extracted-palette">
                  <h3>Extracted Palette ({extractedPalette.length} colors)</h3>
                  <div className="extracted-swatches">
                    {extractedPalette.map((c, i) => (
                      <div key={i} className="extracted-swatch" style={{ background: c }} title={c} />
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
    </div>
  )
}

export default App
