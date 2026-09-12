import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera,
  ChevronDown,
  CircleDot,
  ImagePlus,
  Info,
  Pause,
  Play,
  RotateCcw,
  ScanLine,
  StopCircle,
  Upload,
  X,
} from 'lucide-react'
import './App.css'

const API_BASE = '/api'
const SCAN_INTERVAL = 900

const shapeIcon = {
  Circle: '○',
  Ellipse: '◯',
  Triangle: '△',
  Square: '□',
  Rectangle: '▭',
  Pentagon: '⬠',
  Hexagon: '⬡',
  Octagon: '⯃',
  Polygon: '⬢',
  Quadrilateral: '◇',
  Unknown: '◇',
}

function formatArea(value = 0) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`
  }

  return Math.round(value).toLocaleString()
}

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`
}

function getCameraError(error) {
  if (!window.isSecureContext) {
    return 'Camera access requires HTTPS on a phone. Open the HTTPS Vite address shown in your PC terminal.'
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser does not expose camera access. Use Chrome, Edge, or another modern mobile browser.'
  }

  if (error?.name === 'NotAllowedError') {
    return 'Camera permission was denied. Allow camera access for this site and try again.'
  }

  if (error?.name === 'NotFoundError') {
    return 'No camera was found on this device.'
  }

  if (error?.name === 'NotReadableError') {
    return 'The camera is already being used by another app.'
  }

  return `Could not open the camera${
    error?.message ? `: ${error.message}` : '.'
  }`
}

export default function App() {
  const videoRef = useRef(null)
  const imageRef = useRef(null)
  const overlayRef = useRef(null)
  const stageRef = useRef(null)
  const captureCanvasRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const busyRef = useRef(false)
  const objectsRef = useRef([])

  const [mode, setMode] = useState('camera')
  const [cameraState, setCameraState] = useState('stopped')

  const [objects, setObjects] = useState([])
  const [previousRanking, setPreviousRanking] = useState([])

  const [results, setResults] = useState([])
  const [selected, setSelected] = useState(null)

  const [status, setStatus] = useState('Ready to begin')
  const [error, setError] = useState('')

  const [sessionId, setSessionId] = useState(uid)

  const [scannedImages, setScannedImages] = useState(0)
  const [sessionStarted, setSessionStarted] = useState(null)

  const [processing, setProcessing] = useState(false)
  const [backendReady, setBackendReady] = useState(false)

  const [uploadedPreview, setUploadedPreview] = useState('')

  const cameraOn =
    cameraState === 'live' ||
    cameraState === 'paused'

  const ranking = useMemo(
    () => [...objects].sort((a, b) => b.area - a.area),
    [objects],
  )

  const totalArea = useMemo(
    () => objects.reduce((sum, item) => sum + item.area, 0),
    [objects],
  )

  const shapeCount = useMemo(
    () => new Set(objects.map((item) => item.shape)).size,
    [objects],
  )

  const largest = ranking[0]

  /* -----------------------------------------------------------
     BACKEND HEALTH
  ----------------------------------------------------------- */

  const checkBackend = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/health`)
      setBackendReady(response.ok)
    } catch {
      setBackendReady(false)
    }
  }, [])

  useEffect(() => {
    checkBackend()

    const timer = setInterval(checkBackend, 5000)

    return () => clearInterval(timer)
  }, [checkBackend])

  /* -----------------------------------------------------------
     MERGE DETECTIONS
  ----------------------------------------------------------- */

  const mergeResults = useCallback((incoming, source) => {
    if (!incoming?.length) {
      return
    }

    const previousObjects = objectsRef.current.map((item) => ({
      ...item,
    }))

    const previousOrder = [...previousObjects]
      .sort((a, b) => b.area - a.area)
      .map(
        (item) =>
          `${item.track_id}:${Math.round(item.area)}`,
      )
      .join('|')

    const next = previousObjects.map((item) => ({
      ...item,
    }))

    incoming.forEach((item) => {
      const index = next.findIndex(
        (existing) =>
          existing.track_id === item.track_id,
      )

      if (index >= 0) {
        next[index] = {
          ...next[index],
          ...item,
          source:
            next[index].source || source,
          firstSeen:
            next[index].firstSeen,
          lastSeen: Date.now(),
          observations: Math.max(
            next[index].observations || 1,
            item.observations || 1,
          ),
        }
      } else {
        next.push({
          ...item,
          source,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          observations:
            item.observations || 1,
        })
      }
    })

    const nextOrder = [...next]
      .sort((a, b) => b.area - a.area)
      .map(
        (item) =>
          `${item.track_id}:${Math.round(item.area)}`,
      )
      .join('|')

    /*
      Store the exact previous ranking before the
      latest ranking change.
    */
    if (
      previousObjects.length &&
      previousOrder !== nextOrder
    ) {
      setPreviousRanking(
        [...previousObjects].sort(
          (a, b) => b.area - a.area,
        ),
      )
    }

    objectsRef.current = next
    setObjects(next)
  }, [])

  /* -----------------------------------------------------------
     DRAW LIVE DETECTION BOXES
  ----------------------------------------------------------- */

  const drawDetections = useCallback(() => {
    const canvas = overlayRef.current
    const stage = stageRef.current

    if (!canvas || !stage) {
      return
    }

    const source =
      mode === 'camera'
        ? videoRef.current
        : imageRef.current

    const sourceWidth =
      mode === 'camera'
        ? source?.videoWidth
        : source?.naturalWidth

    const sourceHeight =
      mode === 'camera'
        ? source?.videoHeight
        : source?.naturalHeight

    const rect =
      stage.getBoundingClientRect()

    const dpr =
      window.devicePixelRatio || 1

    canvas.width = Math.max(
      1,
      Math.round(rect.width * dpr),
    )

    canvas.height = Math.max(
      1,
      Math.round(rect.height * dpr),
    )

    canvas.style.width =
      `${rect.width}px`

    canvas.style.height =
      `${rect.height}px`

    const ctx =
      canvas.getContext('2d')

    ctx.clearRect(
      0,
      0,
      canvas.width,
      canvas.height,
    )

    ctx.save()
    ctx.scale(dpr, dpr)

    if (
      !sourceWidth ||
      !sourceHeight ||
      !results.length
    ) {
      ctx.restore()
      return
    }

    /*
      The video/image uses object-fit: contain.
      Calculate exactly where the real image sits
      inside the responsive viewer.
    */
    const scale = Math.min(
      rect.width / sourceWidth,
      rect.height / sourceHeight,
    )

    const displayWidth =
      sourceWidth * scale

    const displayHeight =
      sourceHeight * scale

    const offsetX =
      (rect.width - displayWidth) / 2

    const offsetY =
      (rect.height - displayHeight) / 2

    results.forEach((item) => {
      const x =
        offsetX +
        (item.x / 100) *
          displayWidth

      const y =
        offsetY +
        (item.y / 100) *
          displayHeight

      const width =
        (item.w / 100) *
        displayWidth

      const height =
        (item.h / 100) *
        displayHeight

      ctx.strokeStyle = '#e8ff4f'
      ctx.lineWidth = 2

      ctx.strokeRect(
        x,
        y,
        width,
        height,
      )

      const label =
        item.display_name ||
        item.name

      const detail =
        `${label} · ${item.shape} · ${formatArea(item.area)} px²`

      ctx.font =
        '500 11px DM Mono, monospace'

      const textWidth =
        ctx.measureText(detail).width

      const labelWidth =
        Math.min(
          Math.max(textWidth + 12, 90),
          Math.max(100, width + 20),
        )

      const labelY =
        Math.max(0, y - 23)

      ctx.fillStyle =
        '#e8ff4f'

      ctx.fillRect(
        x,
        labelY,
        labelWidth,
        22,
      )

      ctx.fillStyle =
        '#0b0b0b'

      ctx.fillText(
        detail,
        x + 6,
        labelY + 15,
      )
    })

    ctx.restore()
  }, [mode, results])

  useEffect(() => {
    drawDetections()

    const handleResize =
      () => drawDetections()

    window.addEventListener(
      'resize',
      handleResize,
    )

    return () => {
      window.removeEventListener(
        'resize',
        handleResize,
      )
    }
  }, [drawDetections])

  /* -----------------------------------------------------------
     ANALYZE IMAGE / FRAME
  ----------------------------------------------------------- */

  const analyzeBlob = useCallback(
    async (
      blob,
      source = 'upload',
    ) => {
      if (busyRef.current) {
        return
      }

      busyRef.current = true

      setProcessing(true)
      setError('')

      setStatus(
        source === 'camera'
          ? 'Scanning…'
          : 'Analyzing image…',
      )

      try {
        const form =
          new FormData()

        form.append(
          'image',
          blob,
          source === 'camera'
            ? 'camera-frame.jpg'
            : 'uploaded-image.jpg',
        )

        form.append(
          'session_id',
          sessionId,
        )

        const response =
          await fetch(
            `${API_BASE}/analyze`,
            {
              method: 'POST',
              body: form,
            },
          )

        const data =
          await response
            .json()
            .catch(() => ({}))

        if (!response.ok) {
          throw new Error(
            data.detail ||
              `Server error (${response.status})`,
          )
        }

        const incoming =
          data.detections || []

        setResults(incoming)

        mergeResults(
          incoming,
          source,
        )

        setScannedImages(
          (count) => count + 1,
        )

        setSessionStarted(
          (value) =>
            value || Date.now(),
        )

        setStatus(
          incoming.length
            ? `${incoming.length} object${
                incoming.length === 1
                  ? ''
                  : 's'
              } observed`
            : 'No confident objects found',
        )
      } catch (err) {
        setError(
          err.message ||
            'Could not analyze the image.',
        )

        setStatus(
          'Analysis failed',
        )
      } finally {
        busyRef.current = false
        setProcessing(false)
      }
    },
    [mergeResults, sessionId],
  )

  /* -----------------------------------------------------------
     CAMERA FRAME CAPTURE
  ----------------------------------------------------------- */

  const captureFrame = useCallback(() => {
    const video =
      videoRef.current

    const canvas =
      captureCanvasRef.current

    if (
      !video ||
      !canvas ||
      video.readyState < 2 ||
      !video.videoWidth ||
      !video.videoHeight
    ) {
      return
    }

    const maxWidth = 960

    const scale = Math.min(
      1,
      maxWidth /
        video.videoWidth,
    )

    canvas.width =
      Math.max(
        1,
        Math.round(
          video.videoWidth *
            scale,
        ),
      )

    canvas.height =
      Math.max(
        1,
        Math.round(
          video.videoHeight *
            scale,
        ),
      )

    const context =
      canvas.getContext(
        '2d',
        { alpha: false },
      )

    context.drawImage(
      video,
      0,
      0,
      canvas.width,
      canvas.height,
    )

    canvas.toBlob(
      (blob) => {
        if (blob) {
          analyzeBlob(
            blob,
            'camera',
          )
        }
      },
      'image/jpeg',
      0.82,
    )
  }, [analyzeBlob])

  const startScanningTimer =
    useCallback(() => {
      clearInterval(
        timerRef.current,
      )

      timerRef.current =
        setInterval(
          captureFrame,
          SCAN_INTERVAL,
        )
    }, [captureFrame])

  /* -----------------------------------------------------------
     START / RESUME CAMERA
  ----------------------------------------------------------- */

  const startCamera =
    useCallback(async () => {
      setError('')

      if (
        !window.isSecureContext ||
        !navigator.mediaDevices
          ?.getUserMedia
      ) {
        setError(
          getCameraError(),
        )
        return
      }

      try {
        /*
          RESUME after pause.
        */
        if (streamRef.current) {
          streamRef.current
            .getTracks()
            .forEach(
              (track) => {
                track.enabled = true
              },
            )

          await videoRef.current?.play()

          setCameraState('live')
          setStatus(
            'Camera live — move slowly',
          )

          startScanningTimer()

          return
        }

        /*
          First camera start.
        */
        const stream =
          await navigator.mediaDevices.getUserMedia(
            {
              video: {
                facingMode: {
                  ideal: 'environment',
                },
                width: {
                  ideal: 1280,
                },
                height: {
                  ideal: 720,
                },
              },
              audio: false,
            },
          )

        streamRef.current =
          stream

        if (!videoRef.current) {
          throw new Error(
            'Camera preview is not ready.',
          )
        }

        videoRef.current.srcObject =
          stream

        await videoRef.current.play()

        setCameraState('live')

        setSessionStarted(
          (value) =>
            value || Date.now(),
        )

        setStatus(
          'Camera live — move slowly',
        )

        startScanningTimer()
      } catch (err) {
        setError(
          getCameraError(err),
        )

        setCameraState(
          'stopped',
        )
      }
    }, [startScanningTimer])

  /* -----------------------------------------------------------
     PAUSE CAMERA
  ----------------------------------------------------------- */

    const pauseCamera = useCallback(() => {
      clearInterval(timerRef.current)
      timerRef.current = null

      streamRef.current?.getVideoTracks().forEach((track) => {
        track.enabled = false
      })

      setResults([])
      setCameraState('paused')

      setStatus(
        'Camera paused',
      )
    }, [])

  /* -----------------------------------------------------------
     STOP CAMERA
  ----------------------------------------------------------- */

  const stopCamera =
    useCallback(() => {
      clearInterval(
        timerRef.current,
      )

      streamRef.current
        ?.getTracks()
        .forEach(
          (track) => track.stop(),
        )

      streamRef.current =
        null

      if (videoRef.current) {
        videoRef.current.srcObject =
          null
      }

      setCameraState(
        'stopped',
      )

      setStatus(
        'Camera stopped',
      )
    }, [])

  useEffect(() => {
    return () => {
      clearInterval(
        timerRef.current,
      )

      streamRef.current
        ?.getTracks()
        .forEach(
          (track) => track.stop(),
        )
    }
  }, [])

  /* -----------------------------------------------------------
     UPLOAD
  ----------------------------------------------------------- */

  const onUpload = (
    event,
  ) => {
    const file =
      event.target.files?.[0]

    if (!file) {
      return
    }

    stopCamera()

    setMode('upload')

    setSessionStarted(
      (value) =>
        value || Date.now(),
    )

    setUploadedPreview(
      URL.createObjectURL(file),
    )

    analyzeBlob(
      file,
      'upload',
    )

    event.target.value = ''
  }

  /* -----------------------------------------------------------
     MODE SWITCH
  ----------------------------------------------------------- */

  const switchMode = (
    nextMode,
  ) => {
    if (nextMode === mode) {
      return
    }

    if (nextMode === 'upload') {
      stopCamera()
    }

    setResults([])
    setUploadedPreview('')
    setMode(nextMode)
  }

  /* -----------------------------------------------------------
     RESET SESSION
  ----------------------------------------------------------- */

  const resetSession =
    () => {
      stopCamera()

      objectsRef.current =
        []

      setObjects([])

      setPreviousRanking([])

      setResults([])

      setSelected(null)

      setScannedImages(0)

      setSessionStarted(null)

      setUploadedPreview('')

      setStatus(
        'Ready to begin',
      )

      setError('')

      /*
        New backend session too.
      */
      setSessionId(uid())
    }

  /* -----------------------------------------------------------
     UI
  ----------------------------------------------------------- */

  return (
    <div className="app">
      <header className="topbar">
        <div className="polygonk-logo" aria-label="Polygonk">
          <svg
            width="34"
            height="34"
            viewBox="0 0 34 34"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Outer polygon */}
            <path
              d="M17 2.5L30.5 10.25V23.75L17 31.5L3.5 23.75V10.25L17 2.5Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />

            {/* P */}
            <path
              d="M10 24V10H16.2C19.2 10 21 11.55 21 14C21 16.45 19.2 18 16.2 18H10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* K */}
            <path
              d="M21.5 18L26 10M21.5 18L26 24"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Census detection point */}
            <circle
              cx="17"
              cy="21.5"
              r="1.6"
              fill="currentColor"
            />
          </svg>

          <span className="polygonk-wordmark">
            POLYGONK
          </span>
        </div>
      </header>

      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">
              A COMPUTER VISION SYSTEM FOR GEOMETRIC CENSUS
            </p>

            <h1>
              Measure everything.
              <br />
              <em>
                For no reason.
              </em>
            </h1>
          </div>

          <p className="intro-copy">
            Polygonk scans the world
            around you, identifies
            objects and their geometric
            shapes, measures their
            apparent area, and ranks
            them.
          </p>
        </section>

        <section className="workspace">
          <div className="scanner-card">
            <div className="scanner-head">
              <div>
                <span className="label">
                  01 / SCANNER
                </span>

                <h2>
                  {mode === 'camera'
                    ? 'Live Census'
                    : 'Image Census'}
                </h2>
              </div>

              <div className="status">
                <span
                  className={
                    cameraState ===
                      'live' ||
                    processing
                      ? 'status-dot active'
                      : 'status-dot'
                  }
                />

                {status}
              </div>
            </div>

            <div
              className="viewer"
              ref={stageRef}
            >
              {mode === 'camera' ? (
                <>
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    className={
                      cameraOn
                        ? 'visible'
                        : ''
                    }
                    onLoadedMetadata={
                      drawDetections
                    }
                  />

                  {cameraState ===
                    'stopped' && (
                    <div className="viewer-empty">
                      <Camera size={34} />

                      <strong>
                        Camera is stopped
                      </strong>

                      <span>
                        Start the camera and
                        slowly scan the room.
                      </span>

                      <button
                        className="primary"
                        onClick={
                          startCamera
                        }
                        disabled={
                          !backendReady
                        }
                      >
                        <Play size={16} />
                        Start camera
                      </button>
                    </div>
                  )}

                  {cameraState ===
                    'paused' && (
                    <div className="pause-badge">
                      <Pause size={15} />
                      PAUSED
                    </div>
                  )}

                  {cameraState ===
                    'live' && (
                    <div className="scan-overlay">
                      <span>
                        ● LIVE
                      </span>

                      <span>
                        MOVE SLOWLY
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {uploadedPreview ? (
                    <img
                      ref={imageRef}
                      src={
                        uploadedPreview
                      }
                      className="uploaded-image"
                      alt="Uploaded scene"
                      onLoad={
                        drawDetections
                      }
                    />
                  ) : (
                    <div className="viewer-empty upload-zone">
                      <ImagePlus
                        size={34}
                      />

                      <strong>
                        Analyze a real image
                      </strong>

                      <span>
                        Upload a classroom,
                        room, street, desk —
                        anything.
                      </span>

                      <label className="primary">
                        <Upload size={16} />
                        Choose image

                        <input
                          type="file"
                          accept="image/*"
                          onChange={
                            onUpload
                          }
                        />
                      </label>
                    </div>
                  )}
                </>
              )}

              <canvas
                ref={overlayRef}
                className="detection-overlay"
              />

              <canvas
                ref={captureCanvasRef}
                hidden
              />

              {processing && (
                <div className="processing">
                  <ScanLine
                    size={20}
                  />
                  ANALYZING
                </div>
              )}
            </div>

            <div className="scanner-actions">
              {mode === 'camera' ? (
                <>
                  {cameraState ===
                    'stopped' && (
                    <button
                      className="primary"
                      onClick={
                        startCamera
                      }
                      disabled={
                        !backendReady
                      }
                    >
                      <Play size={16} />
                      Start
                    </button>
                  )}

                  {cameraState ===
                    'live' && (
                    <button
                      className="secondary"
                      onClick={
                        pauseCamera
                      }
                    >
                      <Pause
                        size={16}
                      />
                      Pause
                    </button>
                  )}

                  {cameraState ===
                    'paused' && (
                    <button
                      className="primary"
                      onClick={
                        startCamera
                      }
                    >
                      <Play size={16} />
                      Resume
                    </button>
                  )}

                  {cameraState !==
                    'stopped' && (
                    <button
                      className="secondary danger"
                      onClick={
                        stopCamera
                      }
                    >
                      <StopCircle
                        size={16}
                      />
                      Stop
                    </button>
                  )}
                </>
              ) : (
                <label className="secondary upload-button">
                  <Upload size={16} />
                  Upload another

                  <input
                    type="file"
                    accept="image/*"
                    onChange={
                      onUpload
                    }
                  />
                </label>
              )}

              <button
                className="secondary"
                onClick={() =>
                  switchMode(
                    mode ===
                      'camera'
                      ? 'upload'
                      : 'camera',
                  )
                }
              >
                {mode ===
                'camera' ? (
                  <>
                    <ImagePlus
                      size={16}
                    />
                    Image mode
                  </>
                ) : (
                  <>
                    <Camera
                      size={16}
                    />
                    Camera mode
                  </>
                )}
              </button>

              <button
                className="icon-button"
                onClick={
                  resetSession
                }
                title="Start a new census"
              >
                <RotateCcw
                  size={17}
                />
              </button>
            </div>

            {error && (
              <div className="error">
                <Info size={16} />
                {error}
              </div>
            )}

            {mode === 'camera' &&
              !window.isSecureContext && (
                <div className="secure-note">
                  <Info size={15} />

                  <span>
                    On mobile, use the
                    <strong>
                      HTTPS
                    </strong>{' '}
                    Vite address from
                    your PC terminal.
                    Plain HTTP LAN
                    addresses cannot
                    request the camera.
                  </span>
                </div>
              )}
          </div>

          <aside className="rank-card">
            <div className="rank-head">
              <div>
                <span className="label">
                  02 / LIVE RANKING
                </span>

                <h2>
                  Largest shapes
                </h2>
              </div>

              <span className="count">
                {objects.length
                  .toString()
                  .padStart(
                    2,
                    '0',
                  )}{' '}
                OBJECTS
              </span>
            </div>

            <div className="ranking-list">
              {!ranking.length ? (
                <div className="empty-rank">
                  <CircleDot
                    size={24}
                  />

                  <span>
                    Nothing has been
                    catalogued yet.
                  </span>

                  <small>
                    Start scanning to
                    build the live
                    ranking.
                  </small>
                </div>
              ) : (
                ranking.map(
                  (
                    item,
                    index,
                  ) => (
                    <button
                      className={`rank-row ${
                        selected?.track_id ===
                        item.track_id
                          ? 'selected'
                          : ''
                      }`}
                      key={
                        item.track_id
                      }
                      onClick={() =>
                        setSelected(
                          item,
                        )
                      }
                    >
                      <span className="rank-no">
                        {String(
                          index + 1,
                        ).padStart(
                          2,
                          '0',
                        )}
                      </span>

                      <span className="shape-symbol">
                        {shapeIcon[
                          item.shape
                        ] ||
                          '◇'}
                      </span>

                      <span className="rank-object">
                        <strong>
                          {item.display_name ||
                            item.name}
                        </strong>

                        <small>
                          {item.shape}
                        </small>
                      </span>

                      <span className="rank-area">
                        {formatArea(
                          item.area,
                        )}

                        <small>
                          px²
                        </small>
                      </span>
                    </button>
                  ),
                )
              )}
            </div>

            {ranking.length > 0 && (
              <div className="rank-footer">
                <span>
                  Largest currently
                  observed
                </span>

                <strong>
                  {largest?.display_name ||
                    largest?.name}{' '}
                  ·{' '}
                  {formatArea(
                    largest?.area,
                  )}{' '}
                  px²
                </strong>
              </div>
            )}
          </aside>
        </section>

        <section className="stats-grid">
          <Stat
            label="OBJECTS CATALOGUED"
            value={
              objects.length
            }
          />

          <Stat
            label="SHAPES FOUND"
            value={shapeCount}
          />

          <Stat
            label="TOTAL APPARENT AREA"
            value={`${formatArea(
              totalArea,
            )} px²`}
          />

          <Stat
            label="IMAGES / FRAMES SCANNED"
            value={scannedImages}
          />
        </section>

        <section className="analysis-grid">
          <div className="panel">
            <div className="panel-head">
              <div>
                <span className="label">
                  03 / CURRENT OBSERVATION
                </span>

                <h2>
                  What the camera sees
                </h2>
              </div>

              <ChevronDown
                size={18}
              />
            </div>

            <div className="observation">
              <div className="observation-canvas">
                {results.length ? (
                  results.map(
                    (
                      item,
                      index,
                    ) => (
                      <div
                        key={
                          item.track_id ||
                          index
                        }
                        className="observation-item"
                        style={{
                          left: `${item.x}%`,
                          top: `${item.y}%`,
                          width: `${item.w}%`,
                          height: `${item.h}%`,
                        }}
                      >
                        <span>
                          {item.display_name ||
                            item.name}
                        </span>

                        <small>
                          {item.shape} ·{' '}
                          {formatArea(
                            item.area,
                          )}{' '}
                          px²
                        </small>
                      </div>
                    ),
                  )
                ) : (
                  <span>
                    No current
                    detections
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <span className="label">
                  04 / OBJECT PROFILE
                </span>

                <h2>
                  {selected
                    ? selected.display_name ||
                      selected.name
                    : 'Select a ranked object'}
                </h2>
              </div>

              {selected && (
                <button
                  className="close"
                  onClick={() =>
                    setSelected(null)
                  }
                >
                  <X size={16} />
                </button>
              )}
            </div>

            {selected ? (
              <div className="profile">
                <div className="profile-shape">
                  {shapeIcon[
                    selected.shape
                  ] || '◇'}
                </div>

                <div className="profile-grid">
                  <Metric
                    k="Shape"
                    v={
                      selected.shape
                    }
                  />

                  <Metric
                    k="Area"
                    v={`${formatArea(
                      selected.area,
                    )} px²`}
                  />

                  <Metric
                    k="Perimeter"
                    v={`${formatArea(
                      selected.perimeter,
                    )} px`}
                  />

                  <Metric
                    k="Observations"
                    v={
                      selected.observations
                    }
                  />

                  <Metric
                    k="Confidence"
                    v={`${Math.round(
                      (selected.confidence ||
                        0) * 100,
                    )}%`}
                  />

                  <Metric
                    k="ID"
                    v={
                      selected.track_id
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="profile empty-profile">
                <Info size={22} />

                <span>
                  Click an object in
                  the ranking to
                  inspect its geometric
                  profile.
                </span>
              </div>
            )}
          </div>
        </section>

        <section className="previous">
          <div>
            <span className="label">
              05 / PREVIOUS RANKING
            </span>

            <h2>
              Immediately before the
              latest change.
            </h2>

            <p>
              Polygonk keeps only
              the previous order for
              comparison. Refresh the
              page and the census
              starts over.
            </p>
          </div>

          <div className="previous-list">
            {previousRanking.length ? (
              previousRanking
                .slice(0, 5)
                .map(
                  (
                    item,
                    index,
                  ) => (
                    <div
                      key={
                        item.track_id
                      }
                    >
                      <span>
                        {String(
                          index + 1,
                        ).padStart(
                          2,
                          '0',
                        )}
                      </span>

                      <strong>
                        {item.display_name ||
                          item.name}
                      </strong>

                      <em>
                        {item.shape}
                      </em>

                      <b>
                        {formatArea(
                          item.area,
                        )}{' '}
                        px²
                      </b>
                    </div>
                  ),
                )
            ) : (
              <span className="muted">
                No previous ranking
                yet.
              </span>
            )}
          </div>
        </section>
      </main>

      <footer>
        <span>
          POLYGONK / SESSION{' '}
          {sessionId
            .slice(0, 8)
            .toUpperCase()}
        </span>

        <span>
          APPARENT AREA ONLY
        </span>
      </footer>
    </div>
  )
}

function Stat({
  label,
  value,
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function Metric({
  k,
  v,
}) {
  return (
    <div className="metric">
      <span>{k}</span>
      <strong>{v}</strong>
    </div>
  )
}