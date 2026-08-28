# Pixela Studio

Aplicación React para colorear plantillas de pixel art en el navegador.

## Controles táctiles y zoom móvil

En pantallas de hasta 768 px se activa una interfaz pensada para pintar con el dedo:

- Cada celda se muestra inicialmente con un mínimo de **24 px CSS**. Así, una cuadrícula de 64 × 64, cuyas celdas internas miden 10 px, se abre con un zoom de `2.4` en lugar de hacer que cada celda sea difícil de tocar.
- Los controles **−**, **+** y **Auto** permiten disminuir, aumentar o recalcular el nivel de zoom. El rango está limitado entre `1` y `4`.
- El área ampliada se desplaza dentro de `.canvas-card`; no se reduce para encajar en pantalla, ya que reducirla haría que las celdas perdieran precisión táctil.
- La pintura usa Pointer Events, por lo que el mismo código admite mouse, lápiz y toque. Al mantener pulsado y arrastrar, se pinta una vez cada celda cruzada.

### Detección de móvil

`matchMedia` mantiene el estado `isMobile` sincronizado con el breakpoint CSS:

```ts
const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 768px)').matches)

useEffect(() => {
  const media = window.matchMedia('(max-width: 768px)')
  const updateMobileLayout = () => setIsMobile(media.matches)
  media.addEventListener('change', updateMobileLayout)
  return () => media.removeEventListener('change', updateMobileLayout)
}, [])
```

Al cambiar la cuadrícula o entrar a móvil, el zoom automático se calcula con:

```ts
setMobileZoom(clamp(24 / cellSize, 1, 4))
```

`cellSize` es el tamaño interno de una celda del canvas. El estilo del canvas multiplica sus dimensiones visibles, mientras sus píxeles internos y el algoritmo de pintado se conservan:

```tsx
style={{ width: canvasPxW * mobileZoom, height: canvasPxH * mobileZoom }}
```

### Pintura al tocar y arrastrar

`setPointerCapture` permite seguir recibiendo el gesto aunque el dedo salga momentáneamente del canvas. `lastPaintedCellRef` evita repetir el trabajo cuando llegan varios eventos para la misma celda:

```ts
const handleCanvasPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
  event.currentTarget.setPointerCapture(event.pointerId)
  isPaintingRef.current = true
  lastPaintedCellRef.current = paintAtPointer(event)
}
```

Durante `onPointerMove`, se convierte la posición visible a píxeles internos mediante la proporción entre `canvas.width` y `getBoundingClientRect()`. Por eso el cálculo sigue siendo correcto con cualquier nivel de zoom:

```ts
const scaleX = canvas.width / rect.width
const col = Math.floor(((event.clientX - rect.left) * scaleX) / cellSize)
```

`touch-action: none` desactiva el desplazamiento o zoom nativo del navegador sobre el canvas durante el gesto de pintura. El desplazamiento para recorrer un lienzo ampliado ocurre en el contenedor `.canvas-card`.

## Desarrollo

```bash
npm install
npm run build
```
