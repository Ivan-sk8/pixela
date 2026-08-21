import React, { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

const GRID_SIZE = 32
const CELL_SIZE = 16
const CANVAS_PX = GRID_SIZE * CELL_SIZE

type Tool = 'draw' | 'erase' | 'picker'

const INITIAL_PALETTE = ['#E8B4B8', '#F5F5DC', '#1a2744', '#8B8B8B', '#F5F0D0']

function hexToRgba(hex: string): [number, number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return [r, g, b, 255]
}

function rgbaToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Grid: flat array of rgba tuples or null (transparent)
  const [pixels, setPixels] = useState<(string | null)[]>(() =>
    new Array(GRID_SIZE * GRID_SIZE).fill(null)
  )

  const [cursor, setCursor] = useState({ x: 0, y: 0 })
  const [tool, setTool] = useState<Tool>('draw')
  const [palette, setPalette] = useState<string[]>(INITIAL_PALETTE)
  const [activeSlot, setActiveSlot] = useState(0)

  const activeColor = palette[activeSlot]

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    // Draw checkerboard + pixels
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const idx = row * GRID_SIZE + col
        const x = col * CELL_SIZE
        const y = row * CELL_SIZE

        const color = pixels[idx]
        if (!color) {
          // Checkerboard
          const light = (row + col) % 2 === 0
          ctx.fillStyle = light ? '#555577' : '#3a3a5a'
        } else {
          ctx.fillStyle = color
        }
        ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE)

        // Grid lines
        ctx.strokeStyle = 'rgba(0,0,0,0.2)'
        ctx.lineWidth = 0.5
        ctx.strokeRect(x, y, CELL_SIZE, CELL_SIZE)
      }
    }

    // Cursor highlight
    const cx = cursor.x * CELL_SIZE
    const cy = cursor.y * CELL_SIZE
    ctx.strokeStyle = '#ffee44'
    ctx.lineWidth = 2
    ctx.strokeRect(cx + 1, cy + 1, CELL_SIZE - 2, CELL_SIZE - 2)
  }, [pixels, cursor])

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
      const color = pixels[idx]
      if (color) {
        setPalette(prev => {
          const next = [...prev]
          next[activeSlot] = color
          return next
        })
      }
    }
  }, [cursor, tool, activeColor, pixels, activeSlot])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (['w', 'a', 's', 'd', ' '].includes(key)) {
        e.preventDefault()
      }
      if (key === 'w') setCursor(c => ({ ...c, y: Math.max(0, c.y - 1) }))
      else if (key === 's') setCursor(c => ({ ...c, y: Math.min(GRID_SIZE - 1, c.y + 1) }))
      else if (key === 'a') setCursor(c => ({ ...c, x: Math.max(0, c.x - 1) }))
      else if (key === 'd') setCursor(c => ({ ...c, x: Math.min(GRID_SIZE - 1, c.x + 1) }))
      else if (key === ' ') executeTool()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [executeTool])

  const handleExport = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'pixeldraft.png'
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
      {/* Topbar */}
      <div className="topbar">
        <div className="topbar-title">
          Pixel<span>Draft</span>
        </div>
        <div className="topbar-actions">
          <button className="topbar-btn" title="Save">🔖</button>
          <button className="topbar-btn" title="Share">📤</button>
          <button className="topbar-btn" title="Settings">⚙️</button>
        </div>
      </div>

      {/* Body */}
      <div className="studio-body">
        {/* Sidebar */}
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
          <button className="export-btn" onClick={handleExport} title="Export PNG">
            <span className="tool-icon">📦</span>
            Export
          </button>
        </div>

        {/* Main Canvas Area */}
        <div className="main-content">
          <div className="canvas-info">32x32 &nbsp;&nbsp; Layer 1 &nbsp;&nbsp; 100%</div>
          <div className="canvas-card">
            <canvas
              ref={canvasRef}
              width={CANVAS_PX}
              height={CANVAS_PX}
            />
          </div>
        </div>
      </div>

      {/* Bottom Palette */}
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
    </div>
  )
}

export default App
