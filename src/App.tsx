import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import './App.css'

const GRID_SIZE = 32
const CELL_SIZE = 16
const CANVAS_PX = GRID_SIZE * CELL_SIZE

type Tool = 'draw' | 'erase' | 'picker'

// 1=Fondo Rosa Pastel, 2=Contorno Negro, 3=Rojo, 4=Rosa, 5=Blanco Interior, 6=Piel Pálida
const INITIAL_PALETTE = ['#FCE4EC', '#000000', '#C61730', '#FF6B97', '#FFFFFF', '#FFE0E5']

// Esta función genera el mapa guía estático (la plantilla)
function getSolutionMap(): string[] {
  const grid = new Array<string>(GRID_SIZE * GRID_SIZE).fill('#FCE4EC')

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

  for (let y = 0; y < GRID_SIZE; y++) {
    const rowLeft = leftHalf[y]
    const rowRight = rowLeft.split('').reverse().join('')
    const fullRow = rowLeft + rowRight

    for (let x = 0; x < GRID_SIZE; x++) {
      const char = fullRow[x]
      const color = paletteMap[char]
      if (color) {
        grid[y * GRID_SIZE + x] = color
      }
    }
  }
  return grid
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Guardamos el mapa objetivo para no recalcularlo
  const targetMap = useMemo(() => getSolutionMap(), [])

  // El lienzo inicial comienza completamente vacío (null = sin color pintado por el usuario)
  const [pixels, setPixels] = useState<(string | null)[]>(() => new Array(GRID_SIZE * GRID_SIZE).fill(null))

  const [cursor, setCursor] = useState({ x: 0, y: 0 })
  const [tool, setTool] = useState<Tool>('draw')
  const [palette] = useState<string[]>(INITIAL_PALETTE)
  const [activeSlot, setActiveSlot] = useState(0)

  const activeColor = palette[activeSlot]
  const activeCellColor = pixels[cursor.y * GRID_SIZE + cursor.x]

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    // Limpiamos el lienzo antes de cada render
    ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX)

    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const idx = row * GRID_SIZE + col
        const x = col * CELL_SIZE
        const y = row * CELL_SIZE

        const paintedColor = pixels[idx]
        const solutionColor = targetMap[idx]

        // 1. Pintar fondo: Si el usuario pintó, usa ese color. Si no, blanco puro.
        ctx.fillStyle = paintedColor ?? '#FFFFFF'
        ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE)

        // 2. Dibujar cuadrícula
        ctx.strokeStyle = '#FFB0BF' // Borde rosa claro
        ctx.lineWidth = 0.5
        ctx.strokeRect(x, y, CELL_SIZE, CELL_SIZE)

        // 3. Dibujar el número guía SOLO si la celda no ha sido pintada
        if (!paintedColor && solutionColor) {
          const paletteIndex = palette.indexOf(solutionColor)
          const number = String(paletteIndex + 1)

          // Hacemos el "1" gris clarito para no saturar, y el resto negro nítido
          ctx.fillStyle = paletteIndex === 0 ? '#E0E0E0' : '#000000'
          ctx.font = 'bold 9px monospace'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(number, x + CELL_SIZE / 2, y + CELL_SIZE / 2)
        }
      }
    }

    // Dibujar cursor
    const cx = cursor.x * CELL_SIZE
    const cy = cursor.y * CELL_SIZE
    ctx.strokeStyle = '#ffee44'
    ctx.lineWidth = 2
    ctx.strokeRect(cx + 1, cy + 1, CELL_SIZE - 2, CELL_SIZE - 2)
  }, [pixels, cursor, palette, targetMap])

  const executeTool = useCallback(() => {
    const idx = cursor.y * GRID_SIZE + cursor.x
    if (tool === 'draw') {
      setPixels(prev => {
        const next = [...prev]
        next[idx] = activeColor
        return next
      })
    } else if (tool === 'erase') {
      setPixels(prev => {
        const next = [...prev]
        next[idx] = null
        return next
      })
    } else if (tool === 'picker') {
      const color = pixels[idx] || targetMap[idx] // Permite hacer pick de la solución si no está pintado
      if (color) {
        const slot = palette.indexOf(color)
        if (slot >= 0) setActiveSlot(slot)
      }
    }
  }, [cursor, tool, activeColor, pixels, targetMap, palette])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()

      if (['w', 'a', 's', 'd', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        e.preventDefault()
      }

      if (key === 'w' || key === 'arrowup') {
        setCursor(c => ({ ...c, y: Math.max(0, c.y - 1) }))
      } else if (key === 's' || key === 'arrowdown') {
        setCursor(c => ({ ...c, y: Math.min(GRID_SIZE - 1, c.y + 1) }))
      } else if (key === 'a' || key === 'arrowleft') {
        setCursor(c => ({ ...c, x: Math.max(0, c.x - 1) }))
      } else if (key === 'd' || key === 'arrowright') {
        setCursor(c => ({ ...c, x: Math.min(GRID_SIZE - 1, c.x + 1) }))
      } else if (key === ' ') {
        executeTool()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [executeTool])

  const handleExport = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'plantilla_langostinos.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
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
          <span>Pixela - K version</span>
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
          <button className="tool-btn" onClick={handleExport} title="Exportar">
             💾 Export
          </button>
        </div>

        <div className="main-content">
          <div className="canvas-info">32x32 &nbsp;&nbsp; Layer 1 &nbsp;&nbsp; 100%</div>
          <div className="paint-guide">
            Selecciona un color abajo y pinta sobre los números correspondientes en la cuadrícula.
          </div>
          <div className="canvas-card">
            <canvas
              ref={canvasRef}
              width={CANVAS_PX}
              height={CANVAS_PX}
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
        Cursor ({cursor.x}, {cursor.y}) · Herramienta: {tool} · Número guía: {targetMap[cursor.y * GRID_SIZE + cursor.x] ? palette.indexOf(targetMap[cursor.y * GRID_SIZE + cursor.x]) + 1 : 'Vacío'}
      </div>
    </div>
  )
}

export default App
