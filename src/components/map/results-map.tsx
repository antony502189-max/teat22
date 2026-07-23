import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { MarkerClusterer, SuperClusterAlgorithm } from '@googlemaps/markerclusterer'
import { MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { useApp } from '@/contexts/app-context'
import { getPrimaryPrice } from '@/lib/listings'
import { GOOGLE_MAPS_AUTH_FAILURE_EVENT, googleMapsAuthErrorMessage, googleMapsConfig, googleMapsErrorMessage, GoogleMapsSetupError, loadGoogleMaps } from '@/lib/google-maps/loader'
import { getGoogleMapType, type MapLayerId } from '@/lib/map/providers'
import { loadTenerifeZoneHierarchy, loadTenerifeZones } from '@/lib/map/geojson'
import { canonicalizeZoneId, municipalityZoneId } from '@/lib/map/zones'
import { TENERIFE_BOUNDS, TENERIFE_CENTER, TENERIFE_DEFAULT_ZOOM, isInsideTenerife } from '@/lib/tenerife'
import { AdvancedClusterRenderer, createPriceMarkerContent, priceLabel, setPriceMarkerState } from '@/components/map/map-icons'
import { MapLayerSwitcher, MapToolbar } from '@/components/map/map-toolbar'
import { SelectedListingSheet } from '@/components/map/selected-listing-sheet'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Listing, MapPolygonPoint } from '@/types'
import '@/map.css'

export interface MapBounds {
  north: number
  south: number
  east: number
  west: number
}

export interface ResultsMapProps {
  items: Listing[]
  selectedId?: string
  highlightedId?: string
  onSelect: (id: string) => void
  onHighlight?: (id: string) => void
  fullScreen?: boolean
  showPreview?: boolean
  onBoundsSearch?: (bounds: MapBounds) => void
  onPolygonSearch?: (polygon: MapPolygonPoint[]) => void
  onDrawingStart?: () => boolean | void
  fitResultsKey?: number
  initialAction?: 'draw' | 'near' | null
  onInitialActionHandled?: () => void
}

type ScreenPoint = { x: number; y: number }

const MIN_SAMPLE_DISTANCE = 5
const MIN_CONTOUR_AREA = 900
const SIMPLIFY_TOLERANCE = 2.5

const boundsAreEqual = (left: MapBounds, right: MapBounds) =>
  (Object.keys(left) as (keyof MapBounds)[]).every((key) => Math.abs(left[key] - right[key]) < 0.00001)

const getMapBounds = (map: google.maps.Map): MapBounds | null => {
  const current = map.getBounds()
  if (!current) return null
  const northEast = current.getNorthEast()
  const southWest = current.getSouthWest()
  return { north: northEast.lat(), east: northEast.lng(), south: southWest.lat(), west: southWest.lng() }
}

function fitListings(map: google.maps.Map, listings: Listing[]) {
  if (!listings.length) return
  const bounds = new google.maps.LatLngBounds()
  listings.forEach((listing) => bounds.extend(listing.coordinates))
  const isCompact = map.getDiv().clientWidth < 768
  map.fitBounds(bounds, isCompact
    ? { top: 96, right: 42, bottom: 118, left: 42 }
    : { top: 72, right: 72, bottom: 72, left: 72 })
  map.setCenter(bounds.getCenter())
  google.maps.event.addListenerOnce(map, 'idle', () => {
    const zoom = map.getZoom() ?? 0
    if (zoom > 13) map.setZoom(13)
    else if (isCompact && zoom < 9.65) map.setZoom(9.65)
  })
}

const distanceSquared = (left: ScreenPoint, right: ScreenPoint) => {
  const dx = left.x - right.x
  const dy = left.y - right.y
  return dx * dx + dy * dy
}

const perpendicularDistance = (point: ScreenPoint, start: ScreenPoint, end: ScreenPoint) => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) return Math.sqrt(distanceSquared(point, start))
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)))
  const projected = { x: start.x + t * dx, y: start.y + t * dy }
  return Math.sqrt(distanceSquared(point, projected))
}

function simplifyRdp(points: ScreenPoint[], tolerance = SIMPLIFY_TOLERANCE): ScreenPoint[] {
  if (points.length <= 2) return points
  let maxDistance = 0
  let splitIndex = 0
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], points[0], points[points.length - 1])
    if (distance > maxDistance) {
      maxDistance = distance
      splitIndex = index
    }
  }
  if (maxDistance <= tolerance) return [points[0], points[points.length - 1]]
  const left = simplifyRdp(points.slice(0, splitIndex + 1), tolerance)
  const right = simplifyRdp(points.slice(splitIndex), tolerance)
  return [...left.slice(0, -1), ...right]
}

const polygonArea = (points: ScreenPoint[]) => Math.abs(points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length]
  return sum + point.x * next.y - next.x * point.y
}, 0) / 2)

export function ResultsMap({ items, selectedId, highlightedId, onSelect, onHighlight, fullScreen = false, showPreview = true, onBoundsSearch, onPolygonSearch, onDrawingStart, fitResultsKey = 0, initialAction = null, onInitialActionHandled }: ResultsMapProps) {
  const { filters, mapPolygon, setMapPolygon, clearMapPolygon } = useApp()
  const containerRef = useRef<HTMLDivElement>(null)
  const drawingOverlayRef = useRef<HTMLDivElement>(null)
  const projectionOverlayRef = useRef<google.maps.OverlayView | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const clusterRef = useRef<MarkerClusterer | null>(null)
  const markersRef = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>())
  const markerContentRef = useRef(new Map<string, HTMLElement>())
  const drawingLayerRef = useRef<google.maps.Polygon | google.maps.Polyline | null>(null)
  const drawingRef = useRef(false)
  const activePointerRef = useRef<number | null>(null)
  const rawScreenPointsRef = useRef<ScreenPoint[]>([])
  const frameRef = useRef<number | null>(null)
  const onSelectRef = useRef(onSelect)
  const onHighlightRef = useRef(onHighlight)
  const itemsRef = useRef(items)
  const selectedIdRef = useRef(selectedId)
  const highlightedIdRef = useRef(highlightedId)
  const programmaticMoveRef = useRef(true)
  const fittedResultsRef = useRef(false)
  const skipNextResultsFitRef = useRef(false)
  const manualMovePendingRef = useRef(false)
  const lastSearchedBoundsRef = useRef<MapBounds | null>(null)
  const previousFitResultsKeyRef = useRef(fitResultsKey)
  const fittedPolygonSignatureRef = useRef('')
  const actionHandledRef = useRef(false)
  const geolocationPendingRef = useRef(false)
  const announcementRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [drawSession, setDrawSession] = useState(false)
  const [draftPolygon, setDraftPolygon] = useState<MapPolygonPoint[]>(mapPolygon)
  const [bounds, setBounds] = useState<MapBounds | null>(null)
  const [ready, setReady] = useState(false)
  const [mapError, setMapError] = useState('')
  const [boundsDirty, setBoundsDirty] = useState(false)
  const [actionAnnouncement, setActionAnnouncement] = useState('')
  const [layer, setLayer] = useState<MapLayerId>('street')
  const [focusSheetOnOpen, setFocusSheetOnOpen] = useState(false)

  const selected = items.find((item) => item.id === selectedId)
  const itemSignature = useMemo(() => items.map((item) => `${item.id}:${item.coordinates.lat}:${item.coordinates.lng}:${getPrimaryPrice(item)}`).join('|'), [items])
  const selectedAreaSignature = filters.areas.map(canonicalizeZoneId).sort().join('|')
  itemsRef.current = items
  selectedIdRef.current = selectedId
  highlightedIdRef.current = highlightedId

  useEffect(() => { onSelectRef.current = onSelect }, [onSelect])
  useEffect(() => { onHighlightRef.current = onHighlight }, [onHighlight])
  useEffect(() => { drawingRef.current = drawing }, [drawing])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false
    let resizeObserver: ResizeObserver | null = null
    let initializedMap: google.maps.Map | null = null
    const listeners: google.maps.MapsEventListener[] = []
    const markZoomIntent = () => {
      if (drawingRef.current) return
      programmaticMoveRef.current = false
      manualMovePendingRef.current = true
    }
    const markKeyboardZoomIntent = (event: KeyboardEvent) => {
      if (!drawingRef.current && (event.key === '+' || event.key === '-' || event.key === '=')) {
        programmaticMoveRef.current = false
        manualMovePendingRef.current = true
      }
    }
    const handleAuthFailure = () => setMapError(googleMapsAuthErrorMessage)
    container.addEventListener('wheel', markZoomIntent, { passive: true })
    container.addEventListener('keydown', markKeyboardZoomIntent)
    window.addEventListener(GOOGLE_MAPS_AUTH_FAILURE_EVENT, handleAuthFailure)

    loadGoogleMaps().then(({ maps }) => {
      if (cancelled || !containerRef.current) return
      if (!googleMapsConfig.mapId) throw new GoogleMapsSetupError('missing-map-id')
      const map = new maps.Map(containerRef.current, {
        center: TENERIFE_CENTER,
        zoom: TENERIFE_DEFAULT_ZOOM,
        minZoom: 8,
        maxZoom: 19,
        mapId: googleMapsConfig.mapId,
        mapTypeId: getGoogleMapType('street'),
        disableDefaultUI: true,
        clickableIcons: false,
        keyboardShortcuts: true,
        gestureHandling: 'greedy',
        restriction: { latLngBounds: TENERIFE_BOUNDS, strictBounds: false },
      })
      class ProjectionOverlay extends google.maps.OverlayView {
        onAdd() {}
        draw() {}
        onRemove() {}
      }
      const projectionOverlay = new ProjectionOverlay()
      projectionOverlay.setMap(map)
      projectionOverlayRef.current = projectionOverlay
      mapRef.current = map
      initializedMap = map
      containerRef.current.dataset.mapInstance = 'google-ready'

      const updateBounds = () => {
        const next = getMapBounds(map)
        const center = map.getCenter()
        if (next) setBounds(next)
        if (containerRef.current && center) {
          containerRef.current.dataset.mapCenter = `${center.lat().toFixed(6)},${center.lng().toFixed(6)}`
          containerRef.current.dataset.mapZoom = String(map.getZoom() ?? '')
        }
        if (manualMovePendingRef.current && !programmaticMoveRef.current) {
          manualMovePendingRef.current = false
          setBoundsDirty(true)
        }
      }
      const markManualMove = () => {
        if (drawingRef.current) return
        programmaticMoveRef.current = false
        manualMovePendingRef.current = true
      }
      listeners.push(map.addListener('idle', updateBounds))
      listeners.push(map.addListener('dragstart', markManualMove))
      resizeObserver = new ResizeObserver(() => {
        const center = fittedResultsRef.current ? map.getCenter() : null
        google.maps.event.trigger(map, 'resize')
        if (center) map.setCenter(center)
      })
      resizeObserver.observe(containerRef.current)
      setReady(true)
      setMapError('')
      google.maps.event.addListenerOnce(map, 'idle', updateBounds)
      listeners.push(google.maps.event.addListenerOnce(map, 'idle', () => {
        if (cancelled || !itemsRef.current.length) return
        programmaticMoveRef.current = true
        fitListings(map, itemsRef.current)
        google.maps.event.addListenerOnce(map, 'idle', () => {
          fittedResultsRef.current = true
          programmaticMoveRef.current = false
        })
      }))
    }).catch((error) => {
      if (!cancelled) setMapError(googleMapsErrorMessage(error))
    })

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      listeners.forEach((listener) => listener.remove())
      container.removeEventListener('wheel', markZoomIntent)
      container.removeEventListener('keydown', markKeyboardZoomIntent)
      window.removeEventListener(GOOGLE_MAPS_AUTH_FAILURE_EVENT, handleAuthFailure)
      projectionOverlayRef.current?.setMap(null)
      projectionOverlayRef.current = null
      if (initializedMap) google.maps.event.clearInstanceListeners(initializedMap)
      mapRef.current = null
      fittedResultsRef.current = false
      container.replaceChildren()
    }
  }, [])

  useEffect(() => {
    mapRef.current?.setMapTypeId(getGoogleMapType(layer))
  }, [layer])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    map.setOptions(drawing
      ? { gestureHandling: 'none', draggable: false, keyboardShortcuts: false, disableDoubleClickZoom: true }
      : { gestureHandling: 'greedy', draggable: true, keyboardShortcuts: true, disableDoubleClickZoom: false })
  }, [drawing, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    clusterRef.current?.clearMarkers()
    clusterRef.current?.setMap(null)
    markersRef.current.forEach((marker) => {
      google.maps.event.clearInstanceListeners(marker)
      marker.map = null
    })
    markersRef.current.clear()
    markerContentRef.current.clear()

    const markers = itemsRef.current.map((listing) => {
      const content = createPriceMarkerContent(listing)
      setPriceMarkerState(content, listing.id === selectedIdRef.current, listing.id === highlightedIdRef.current)
      content.dataset.markerZIndex = listing.id === selectedIdRef.current ? '3000' : '10'
      const marker = new google.maps.marker.AdvancedMarkerElement({
        position: listing.coordinates,
        content,
        title: `${listing.area}, ${priceLabel(listing)}`,
        gmpClickable: true,
        collisionBehavior: google.maps.CollisionBehavior.OPTIONAL_AND_HIDES_LOWER_PRIORITY,
        zIndex: listing.id === selectedIdRef.current ? 3000 : 10,
      })
      const select = (original: Event) => {
        setFocusSheetOnOpen(original instanceof KeyboardEvent || (original instanceof MouseEvent && original.detail === 0))
        returnFocusRef.current = original.target instanceof HTMLElement ? original.target : content
        onSelectRef.current(listing.id)
      }
      marker.addEventListener('gmp-click', select)
      content.addEventListener('mouseenter', () => onHighlightRef.current?.(listing.id))
      content.addEventListener('mouseleave', () => onHighlightRef.current?.(''))
      content.addEventListener('focus', () => onHighlightRef.current?.(listing.id))
      content.addEventListener('blur', () => onHighlightRef.current?.(''))
      markersRef.current.set(listing.id, marker)
      markerContentRef.current.set(listing.id, content)
      return marker
    })

    const cluster = new MarkerClusterer({
      map,
      markers,
      algorithm: new SuperClusterAlgorithm({ radius: 58, maxZoom: 16 }),
      renderer: new AdvancedClusterRenderer(),
    })
    clusterRef.current = cluster
    if (itemsRef.current.length && !skipNextResultsFitRef.current) {
      programmaticMoveRef.current = true
      fitListings(map, itemsRef.current)
      google.maps.event.addListenerOnce(map, 'idle', () => {
        fittedResultsRef.current = true
        programmaticMoveRef.current = false
      })
    } else if (skipNextResultsFitRef.current) {
      skipNextResultsFitRef.current = false
    }
    return () => {
      cluster.clearMarkers()
      cluster.setMap(null)
    }
  }, [itemSignature, ready])

  useEffect(() => {
    markersRef.current.forEach((marker, id) => {
      const content = markerContentRef.current.get(id)
      if (content) {
        setPriceMarkerState(content, id === selectedId, id === highlightedId)
        content.dataset.markerZIndex = id === selectedId ? '3000' : id === highlightedId ? '2000' : '10'
      }
      marker.zIndex = id === selectedId ? 3000 : id === highlightedId ? 2000 : 10
    })
    const map = mapRef.current
    const clusterer = clusterRef.current
    if (!map || !clusterer) return
    const applyClusterState = () => {
      containerRef.current?.querySelectorAll('.map-cluster-marker.is-highlighted, .map-cluster-marker.is-selected').forEach((node) => node.classList.remove('is-highlighted', 'is-selected'))
      const clusters = (clusterer as unknown as { clusters: Array<{ marker?: google.maps.Marker | google.maps.marker.AdvancedMarkerElement; markers: Array<google.maps.Marker | google.maps.marker.AdvancedMarkerElement> }> }).clusters
      ;([{ id: highlightedId, className: 'is-highlighted' }, { id: selectedId, className: 'is-selected' }] as const).forEach(({ id, className }) => {
        const listingMarker = id ? markersRef.current.get(id) : undefined
        if (!listingMarker) return
        const cluster = clusters.find((candidate) => candidate.markers.length > 1 && candidate.markers.includes(listingMarker))
        if (!(cluster?.marker instanceof google.maps.marker.AdvancedMarkerElement)) return
        const content = cluster.marker.content
        if (content instanceof HTMLElement) content.querySelector('.map-cluster-marker')?.classList.add(className)
      })
    }
    applyClusterState()
    const idleListener = map.addListener('idle', applyClusterState)
    const clusterListener = google.maps.event.addListener(clusterer, 'clusteringend', applyClusterState)
    return () => {
      idleListener.remove()
      clusterListener.remove()
    }
  }, [highlightedId, itemSignature, ready, selectedId])

  useEffect(() => {
    const previous = previousFitResultsKeyRef.current
    previousFitResultsKeyRef.current = fitResultsKey
    const map = mapRef.current
    if (previous === fitResultsKey || !map || !itemsRef.current.length) return
    programmaticMoveRef.current = true
    setBoundsDirty(false)
    fitListings(map, itemsRef.current)
    google.maps.event.addListenerOnce(map, 'idle', () => { programmaticMoveRef.current = false })
  }, [fitResultsKey])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    let cancelled = false
    map.data.forEach((feature) => map.data.remove(feature))
    if (!selectedAreaSignature) return
    Promise.all([loadTenerifeZones(), loadTenerifeZoneHierarchy().catch(() => null)]).then(([municipalities, hierarchy]) => {
      if (cancelled || !mapRef.current) return
      const selectedAreas = new Set(selectedAreaSignature.split('|'))
      const municipalityFeatures = municipalities.features.map((feature) => ({
        ...feature,
        id: municipalityZoneId(feature.properties.id || feature.properties.label),
        properties: { ...feature.properties, id: municipalityZoneId(feature.properties.id || feature.properties.label) },
      }))
      map.data.addGeoJson({ type: 'FeatureCollection', features: [...municipalityFeatures, ...(hierarchy?.features ?? [])] } as unknown as GeoJSON.GeoJsonObject)
      map.data.setStyle((feature) => ({
        visible: selectedAreas.has(canonicalizeZoneId(String(feature.getProperty('id') ?? ''))),
        fillColor: '#c51a84', fillOpacity: .2, strokeColor: '#9e176d', strokeOpacity: 1, strokeWeight: 3, zIndex: 2,
      }))
    }).catch(() => {
      if (!cancelled) setMapError('No se pudieron cargar los límites seleccionados. El resto del mapa sigue disponible.')
    })
    return () => { cancelled = true }
  }, [ready, selectedAreaSignature])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    drawingLayerRef.current?.setMap(null)
    drawingLayerRef.current = null
    if (draftPolygon.length >= 3) {
      const polygon = new google.maps.Polygon({
        map,
        paths: draftPolygon,
        clickable: false,
        editable: drawSession && !drawing,
        strokeColor: '#9e176d', strokeOpacity: 1, strokeWeight: 3,
        fillColor: '#c51a84', fillOpacity: .22, zIndex: 5,
      })
      drawingLayerRef.current = polygon
      if (drawSession && !drawing) {
        const syncPath = () => setDraftPolygon(polygon.getPath().getArray().map((point) => ({ lat: point.lat(), lng: point.lng() })))
        const setListener = polygon.getPath().addListener('set_at', syncPath)
        const insertListener = polygon.getPath().addListener('insert_at', syncPath)
        const removeListener = polygon.getPath().addListener('remove_at', syncPath)
        return () => {
          setListener.remove(); insertListener.remove(); removeListener.remove(); polygon.setMap(null)
        }
      }
    } else if (draftPolygon.length >= 2) {
      drawingLayerRef.current = new google.maps.Polyline({ map, path: draftPolygon, clickable: false, strokeColor: '#9e176d', strokeWeight: 3, zIndex: 5 })
    }
    return () => drawingLayerRef.current?.setMap(null)
  }, [draftPolygon, drawSession, drawing, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || mapPolygon.length < 3 || drawSession) return
    const signature = mapPolygon.map((point) => `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`).join(';')
    if (fittedPolygonSignatureRef.current === signature) return
    fittedPolygonSignatureRef.current = signature
    const polygonBounds = new google.maps.LatLngBounds()
    mapPolygon.forEach((point) => polygonBounds.extend(point))
    programmaticMoveRef.current = true
    setBoundsDirty(false)
    map.fitBounds(polygonBounds, { top: 72, right: 32, bottom: 96, left: 32 })
    google.maps.event.addListenerOnce(map, 'idle', () => { programmaticMoveRef.current = false })
  }, [drawSession, mapPolygon, ready])

  const screenToLatLng = (point: ScreenPoint) => {
    const projection = projectionOverlayRef.current?.getProjection()
    if (!projection) return null
    const latLng = projection.fromContainerPixelToLatLng(new google.maps.Point(point.x, point.y))
    return latLng ? { lat: latLng.lat(), lng: latLng.lng() } : null
  }

  const publishLiveStroke = () => {
    frameRef.current = null
    const converted = rawScreenPointsRef.current.map(screenToLatLng).filter((point): point is MapPolygonPoint => Boolean(point))
    setDraftPolygon(converted)
  }

  const scheduleLiveStroke = () => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(publishLiveStroke)
  }

  const startDrawing = () => {
    if (onDrawingStart?.() === false) return
    onSelectRef.current('')
    setFocusSheetOnOpen(false)
    activePointerRef.current = null
    rawScreenPointsRef.current = []
    setDraftPolygon([])
    setDrawSession(true)
    setDrawing(true)
    setActionAnnouncement('Modo dibujo activado. Mantén pulsado y dibuja una zona con el ratón, el dedo o el lápiz.')
  }

  const cancelDrawing = () => {
    activePointerRef.current = null
    rawScreenPointsRef.current = []
    setDraftPolygon(mapPolygon)
    setDrawing(false)
    setDrawSession(false)
    setActionAnnouncement('Dibujo cancelado.')
  }

  const finishPointerDrawing = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    if (activePointerRef.current !== event.pointerId) return
    if (drawingOverlayRef.current?.hasPointerCapture(event.pointerId)) drawingOverlayRef.current.releasePointerCapture(event.pointerId)
    activePointerRef.current = null
    if (cancelled) {
      rawScreenPointsRef.current = []
      setDraftPolygon([])
      setActionAnnouncement('Trazo cancelado. Dibuja de nuevo.')
      return
    }
    const raw = rawScreenPointsRef.current
    const simplified = simplifyRdp(raw)
    const area = polygonArea(simplified)
    const converted = simplified.map(screenToLatLng).filter((point): point is MapPolygonPoint => Boolean(point))
    const unique = new Set(converted.map((point) => `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`))
    if (raw.length < 6 || converted.length < 3 || unique.size < 3 || area < MIN_CONTOUR_AREA) {
      rawScreenPointsRef.current = []
      setDraftPolygon([])
      setActionAnnouncement('La zona es demasiado pequeña o no es válida. Dibuja un contorno más amplio.')
      toast.error('La zona dibujada es demasiado pequeña. Inténtalo de nuevo.')
      return
    }
    setDraftPolygon(converted)
    setDrawing(false)
    setActionAnnouncement(`Zona preparada con ${converted.length} vértices. Puedes editarla antes de aplicarla.`)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing || activePointerRef.current !== null || event.button > 0) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    activePointerRef.current = event.pointerId
    rawScreenPointsRef.current = [point]
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraftPolygon([])
    scheduleLiveStroke()
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing || activePointerRef.current !== event.pointerId) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const last = rawScreenPointsRef.current.at(-1)
    if (last && distanceSquared(last, point) < MIN_SAMPLE_DISTANCE * MIN_SAMPLE_DISTANCE) return
    rawScreenPointsRef.current.push(point)
    scheduleLiveStroke()
  }

  const applyDrawing = () => {
    if (draftPolygon.length < 3) return
    setDrawing(false)
    setDrawSession(false)
    setMapPolygon(draftPolygon)
    onPolygonSearch?.(draftPolygon)
    setActionAnnouncement(`Zona dibujada aplicada con ${draftPolygon.length} vértices.`)
    toast.success('Zona dibujada aplicada')
  }

  const deletePolygon = () => {
    setDraftPolygon([])
    clearMapPolygon()
    onPolygonSearch?.([])
    setDrawing(false)
    setDrawSession(false)
    setActionAnnouncement('Zona dibujada eliminada.')
  }

  const locateCurrentPosition = () => {
    if (!navigator.geolocation) { toast.error('Tu navegador no ofrece geolocalización'); return }
    if (geolocationPendingRef.current) return
    geolocationPendingRef.current = true
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      geolocationPendingRef.current = false
      const current = { lat: coords.latitude, lng: coords.longitude }
      if (!isInsideTenerife(current)) {
        setActionAnnouncement('Tu ubicación está fuera de Tenerife. El mapa permanece en la isla.')
        toast.error('Tu ubicación está fuera de Tenerife.')
        return
      }
      programmaticMoveRef.current = true
      mapRef.current?.setCenter(current)
      mapRef.current?.setZoom(14)
      if (mapRef.current) google.maps.event.addListenerOnce(mapRef.current, 'idle', () => { programmaticMoveRef.current = false })
      setActionAnnouncement('Ubicación encontrada en Tenerife.')
    }, () => {
      geolocationPendingRef.current = false
      setActionAnnouncement('No pudimos obtener tu ubicación. Puedes mover el mapa manualmente.')
      toast.error('No pudimos obtener tu ubicación.')
    }, { timeout: 7000 })
  }

  const searchBounds = () => {
    if (!bounds || !onBoundsSearch || !boundsDirty) return
    if (lastSearchedBoundsRef.current && boundsAreEqual(bounds, lastSearchedBoundsRef.current)) { setBoundsDirty(false); return }
    skipNextResultsFitRef.current = true
    onBoundsSearch(bounds)
    lastSearchedBoundsRef.current = bounds
    setBoundsDirty(false)
    setActionAnnouncement('Resultados actualizados para el área visible.')
  }

  useEffect(() => {
    if (!initialAction) { actionHandledRef.current = false; return }
    if (!ready || actionHandledRef.current) return
    actionHandledRef.current = true
    if (initialAction === 'draw') startDrawing()
    else locateCurrentPosition()
    onInitialActionHandled?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAction, onInitialActionHandled, ready])

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  }, [])

  return <section className={cn('results-map google-map-shell', fullScreen && 'results-map--fullscreen google-map-shell--fullscreen', selected && 'has-selection', drawing && 'is-drawing', drawSession && 'is-draw-session', mapPolygon.length >= 3 && 'has-polygon', mapError && 'has-map-error')} aria-label="Mapa de resultados" data-drawing={drawing || undefined} data-draw-session={drawSession || undefined} data-provider="google-maps">
    <div className="results-map__canvas google-map-canvas" ref={containerRef} role="application" aria-label="Google Maps con precios de habitaciones" />
    {drawing ? <div
      ref={drawingOverlayRef}
      className="map-freehand-overlay"
      data-testid="map-freehand-overlay"
      aria-label="Área de dibujo libre sobre el mapa"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointerDrawing(event)}
      onPointerCancel={(event) => finishPointerDrawing(event, true)}
      onContextMenu={(event) => event.preventDefault()}
      style={{ position: 'absolute', inset: 0, zIndex: 7, cursor: 'crosshair', touchAction: 'none', userSelect: 'none' }}
    /> : null}
    <MapLayerSwitcher value={layer} onChange={setLayer} />
    {fullScreen && !drawSession ? <MapToolbar boundsDirty={boundsDirty} canSearchBounds={Boolean(boundsDirty && bounds && onBoundsSearch)} drawing={false} pointCount={draftPolygon.length} hasPolygon={mapPolygon.length >= 3} onSearchBounds={searchBounds} onLocate={locateCurrentPosition} onStartDrawing={startDrawing} onAddPoint={() => undefined} onCancelDrawing={cancelDrawing} onFinishDrawing={applyDrawing} onDeletePolygon={deletePolygon} /> : null}
    {fullScreen && drawSession ? <div className="map-freehand-actions" role="group" aria-label="Acciones de la zona dibujada" style={{ position: 'absolute', zIndex: 9, left: '50%', bottom: '1rem', transform: 'translateX(-50%)', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '.4rem', width: 'min(42rem, calc(100% - 1.25rem))', pointerEvents: 'auto' }}>
      {drawing ? <><span className="map-freehand-hint" role="status" style={{ alignSelf: 'center', padding: '.65rem .8rem', borderRadius: '.4rem', background: 'rgba(255,255,255,.96)', boxShadow: '0 .3rem .9rem rgb(25 31 31 / .24)', fontWeight: 700 }}>Mantén pulsado y dibuja el contorno</span><Button variant="outline" onClick={cancelDrawing}>Cancelar</Button></> : <>
        <Button onClick={applyDrawing} disabled={draftPolygon.length < 3}>Aplicar zona</Button>
        <Button variant="outline" onClick={startDrawing}>Volver a dibujar</Button>
        <Button variant="outline" onClick={cancelDrawing}>Cancelar</Button>
        {(mapPolygon.length >= 3 || draftPolygon.length >= 3) ? <Button variant="outline" onClick={deletePolygon}>Eliminar zona</Button> : null}
      </>}
    </div> : null}
    {actionAnnouncement ? <div ref={announcementRef} className="map-action-announcement" role="status" aria-live="polite" tabIndex={-1}>{actionAnnouncement}</div> : null}
    {!ready && !mapError ? <div className="map-loading" role="status" aria-live="polite"><span aria-hidden="true" /><strong>Cargando Google Maps</strong></div> : null}
    {googleMapsConfig.usesDevelopmentMapId ? <p className="map-dev-notice">Mapa de desarrollo: configura un Map ID propio antes de publicar.</p> : null}
    {mapError ? <div className="map-inline-error" role="alert"><strong>Mapa no disponible</strong><span>{mapError}</span></div> : null}
    {selected && showPreview ? <SelectedListingSheet listing={selected} focusOnOpen={focusSheetOnOpen} returnFocus={returnFocusRef.current} onClose={() => { setFocusSheetOnOpen(false); onSelect('') }} /> : null}
    <div className="map-list-alternative" aria-label="Alternativa textual al mapa">
      {items.map((item) => <button key={item.id} type="button" onFocus={() => onHighlight?.(item.id)} onMouseEnter={() => onHighlight?.(item.id)} onClick={() => onSelect(item.id)} aria-pressed={item.id === selectedId}><MapPin aria-hidden="true" /><span><strong>{item.area}</strong><small>{priceLabel(item)}</small></span></button>)}
    </div>
  </section>
}
