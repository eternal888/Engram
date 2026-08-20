import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import axios from 'axios'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api'

/* Node palette. Cream ground, so fills and rings do the work, not glow. */
const NODE = {
  Episode:       { fill: '#191715', ring: '#d5c5a4', label: '#191715' },
  Concept:       { fill: '#a9740c', ring: '#e0cba4', label: '#7d520a' },
  Entity:        { fill: '#fffdf7', ring: '#2f6b46', label: '#2f6b46' },
  Source:        { fill: '#fffdf7', ring: '#8d8471', label: '#5c5344' },
  Contradiction: { fill: '#f01f0a', ring: '#f7a99e', label: '#a81400' },
}
const FALLBACK = { fill: '#8d8471', ring: '#d5c5a4', label: '#5c5344' }

const AGENT_COLOR = {
  pii_scrubber:        '#2f6b46',
  retrieval:           '#191715',
  response_generation: '#a9740c',
  grounding:           '#5c5344',
  extraction:          '#2f6b46',
  contradiction:       '#f01f0a',
  memory_writer:       '#8d8471',
}

const NAV = [
  { id: 'chat',      label: 'Chat' },
  { id: 'documents', label: 'Documents' },
  { id: 'sessions',  label: 'Sessions' },
  { id: 'trace',     label: 'Agent Trace' },
]

/* ──────────────────────────────────────────────────────────────
   Axios instance with auth token auto-injection + 401 logout.
   Streaming uses fetch() so it can read a ReadableStream.
   ────────────────────────────────────────────────────────────── */
const api = axios.create({ baseURL: API_URL })

let _onUnauthorized = null
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('engram_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && _onUnauthorized) _onUnauthorized()
    return Promise.reject(err)
  }
)

const shortId = () => Math.random().toString(16).slice(2, 9)
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/* Extraction still emits reporting phrases on some turns. Strip the shared
   prefix so labels differ from each other in the first few characters. */
const LEAD = /^(THE USER |USER'S |USER IS ASKING ABOUT |USER IS |USER ASKED ABOUT |USER ASKED |USER REQUESTED |USER STATED |USER EXPRESSED |USER EXPRESSES |USER INTRODUCES |USER )/
const nodeLabel = (raw, type) => {
  let t = (raw || type || '').toString().toUpperCase().trim()
  const stripped = t.replace(LEAD, '')
  if (stripped.length > 2) t = stripped
  return truncate(t, 14)
}
const clockTime = () =>
  new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/* ──────────────────────────────────────────────────────────────
   Design tokens.
   ────────────────────────────────────────────────────────────── */
function StyleTokens() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,400;0,500;0,600;0,700;0,800;1,800&family=JetBrains+Mono:wght@400;500;700&display=swap');

      :root{
        --bg:#f4ecdc; --surface:#fbf5e9; --surface-2:#ece0c8;
        --n200:#eee2ca; --n300:#ded1b5; --n400:#c7b593;
        --n500:#a2957c; --n600:#7c7259; --n700:#5c5344;
        --ink:#191715; --ink-dim:#5c5344; --ink-faint:#a2957c;
        --accent:#f01f0a; --accent-700:#a81400; --accent-100:#fdece9;
        --grid:#e6dcc6; --bracket:#c2b08c;
        --sans:"Archivo",system-ui,sans-serif;
        --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
      }
      *{box-sizing:border-box}
      html,body,#root{margin:0;padding:0;height:100%;background:var(--bg);color:var(--ink);font-family:var(--sans)}
      ::-webkit-scrollbar{width:10px;height:10px}
      ::-webkit-scrollbar-track{background:transparent}
      ::-webkit-scrollbar-thumb{background:var(--n400)}
      ::-webkit-scrollbar-thumb:hover{background:var(--n500)}

      .eg-mono{font-family:var(--mono)}
      .eg-label{
        font-family:var(--sans);font-size:11.5px;font-weight:700;letter-spacing:0.06em;
        text-transform:uppercase;color:var(--n600);
      }

      /* wordmark: italic type in a right-pointing chevron block */
      .eg-mark{position:relative;display:inline-flex;isolation:isolate;padding:0 4px 4px 0}
      .eg-mark .shadow{
        position:absolute;top:0;left:0;right:4px;bottom:4px;z-index:1;
        transform:translate(3px,3px);background:#4a4132;
        clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%);
      }
      .eg-mark .block{
        position:relative;z-index:2;display:inline-flex;align-items:center;height:34px;
        padding:0 18px;background:var(--ink);color:var(--surface);
        clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%);
        background-image:linear-gradient(160deg,rgba(255,255,255,0.14),rgba(255,255,255,0) 45%,rgba(0,0,0,0.12));
      }
      .eg-mark .word{
        font-family:var(--sans);font-weight:800;font-style:italic;font-size:18px;
        letter-spacing:-0.035em;line-height:1;
      }

      .eg-nav{
        display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;
        padding:10px 20px;background:transparent;border:0;border-left:3px solid transparent;
        font-family:var(--sans);font-size:12.5px;font-weight:800;letter-spacing:0.04em;
        text-transform:uppercase;color:var(--n600);cursor:pointer;text-align:left;
        transition:color 140ms ease,background 140ms ease;
      }
      .eg-nav:hover{color:var(--ink);background:var(--n200)}
      .eg-nav:focus-visible{outline:2px solid var(--ink);outline-offset:-2px}
      .eg-nav[data-active="true"]{color:var(--ink);border-left-color:var(--ink);background:var(--n200)}
      .eg-nav .badge{font-family:var(--mono);font-weight:400;color:var(--n500);letter-spacing:0.06em}

      .eg-panel-title{
        font-family:var(--sans);font-size:12.5px;font-weight:800;letter-spacing:0.05em;
        text-transform:uppercase;color:var(--ink);
      }

      .eg-input{
        flex:1;min-width:0;background:var(--surface);border:1px solid var(--n400);
        padding:15px 17px;color:var(--ink);font-family:var(--sans);font-size:15px;
        outline:none;transition:border-color 140ms ease;
      }
      .eg-input:focus{border-color:var(--ink)}
      .eg-input::placeholder{color:var(--n500)}

      .eg-send{
        font-family:var(--sans);font-size:13px;font-weight:800;letter-spacing:0.05em;
        text-transform:uppercase;padding:0 28px;border:1px solid var(--ink);
        background:var(--ink);color:var(--surface);cursor:pointer;
        transition:background 140ms ease,color 140ms ease;
      }
      .eg-send:hover:not(:disabled){background:transparent;color:var(--ink)}
      .eg-send:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
      .eg-send:disabled{background:var(--n400);border-color:var(--n400);color:var(--surface);cursor:not-allowed}

      .eg-ghost{
        font-family:var(--sans);font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;
        padding:6px 12px;background:transparent;border:1px solid var(--n400);color:var(--n700);
        cursor:pointer;transition:border-color 140ms ease,color 140ms ease;
      }
      .eg-ghost:hover{border-color:var(--ink);color:var(--ink)}
      .eg-ghost:focus-visible{outline:2px solid var(--ink);outline-offset:1px}
      .eg-ghost[data-tone="warn"]:hover{border-color:var(--accent);color:var(--accent-700)}

      .eg-link{
        font-family:var(--sans);font-size:12px;font-weight:700;letter-spacing:0.04em;
        text-transform:uppercase;background:none;border:0;padding:0;cursor:pointer;
        color:var(--n700);text-decoration:underline;text-underline-offset:3px;
      }
      .eg-link:hover{color:var(--ink)}
      .eg-link:focus-visible{outline:2px solid var(--ink);outline-offset:2px}

      .eg-turn{padding:22px 30px;border-bottom:1px solid var(--n300)}
      .eg-turn[data-weak="true"]{background:var(--n200)}
      .eg-rule{width:2px;flex:none;background:var(--n400);align-self:stretch}
      .eg-rule[data-weak="true"]{background:var(--accent)}

      .eg-seg{display:inline-flex;gap:2px;align-items:center}
      .eg-seg i{width:4px;height:13px;background:var(--n400);display:block}

      .eg-claim{display:flex;align-items:center;gap:12px;padding:7px 0;font-size:14px}
      .eg-tick{width:10px;height:10px;flex:none;background:var(--ink)}
      .eg-tick[data-off="true"]{background:transparent;border:1.5px solid var(--accent)}

      .eg-memrow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0}
      .eg-memrow .acts{display:flex;gap:6px;opacity:0;transition:opacity 120ms ease}
      .eg-memrow:hover .acts,.eg-memrow:focus-within .acts{opacity:1}

      .eg-err{
        margin-top:14px;padding:10px 12px;font-family:var(--mono);font-size:12px;
        background:var(--accent-100);border:1px solid var(--accent);color:var(--accent-700);
      }

      .eg-tracebar{height:6px;min-width:2px;transition:width 240ms ease}

      @keyframes egcaret{0%,49%{opacity:1}50%,100%{opacity:0}}
      .eg-caret{
        display:inline-block;width:7px;height:15px;background:var(--ink);
        margin-left:3px;vertical-align:text-bottom;animation:egcaret 1s steps(1) infinite;
      }
      @media (prefers-reduced-motion:reduce){
        .eg-caret{animation:none}
        *{transition-duration:0ms !important}
      }
    `}</style>
  )
}

/* ──────────────────────────────────────────────────────────────
   Auth screen.
   ────────────────────────────────────────────────────────────── */
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setError('')
    if (!email || !password) { setError('Enter an email and password.'); return }
    if (mode === 'register' && password.length < 8) {
      setError('Password needs at least 8 characters.'); return
    }
    setLoading(true)
    try {
      let res
      if (mode === 'register') {
        res = await api.post('/auth/register', { email, password })
      } else {
        const body = new URLSearchParams()
        body.append('username', email)
        body.append('password', password)
        res = await api.post('/auth/login', body, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      }
      localStorage.setItem('engram_token', res.data.access_token)
      localStorage.setItem('engram_email', res.data.email)
      onAuthed(res.data.email)
    } catch (err) {
      const msg = err.response?.data?.detail || 'Could not reach the server.'
      setError(typeof msg === 'string' ? msg : 'That request was rejected.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 24, background: 'var(--bg)' }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ display: 'grid', gap: 10, justifyItems: 'start', marginBottom: 30 }}>
          <span className="eg-mark">
            <span className="shadow" />
            <span className="block"><span className="word">engram</span></span>
          </span>
          <span className="eg-label">Memory layer</span>
        </div>

        <h1 style={{ margin: '0 0 6px', fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em' }}>
          {mode === 'login' ? 'Open your graph' : 'Start a graph'}
        </h1>
        <p className="eg-mono" style={{ margin: '0 0 26px', fontSize: 12, color: 'var(--n600)' }}>
          {mode === 'login'
            ? 'Everything you told it is still there.'
            : 'Nothing is stored until you say something.'}
        </p>

        <label className="eg-label" style={{ display: 'block', marginBottom: 6 }}>Email</label>
        <input className="eg-input" style={{ width: '100%' }} type="email" value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="you@example.com" disabled={loading} />

        <label className="eg-label" style={{ display: 'block', margin: '16px 0 6px' }}>Password</label>
        <input className="eg-input" style={{ width: '100%' }} type="password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={mode === 'register' ? 'at least 8 characters' : '••••••••'}
          disabled={loading} />

        {error && <div className="eg-err">{error}</div>}

        <button className="eg-send" style={{ width: '100%', padding: '14px 0', marginTop: 22 }}
          onClick={submit} disabled={loading}>
          {loading ? 'Working' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>

        <div className="eg-mono" style={{ marginTop: 18, fontSize: 12, color: 'var(--n600)' }}>
          {mode === 'login' ? 'No account yet?' : 'Already have one?'}
          <button className="eg-link" style={{ marginLeft: 8 }}
            onClick={() => { setError(''); setMode(mode === 'login' ? 'register' : 'login') }}>
            {mode === 'login' ? 'Create one' : 'Log in'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
   Memory graph.

   Force layout runs until kinetic energy falls below a threshold,
   then parks. Hover and selection repaint a single frame without
   waking the physics, so nodes hold still while being aimed at.
   ────────────────────────────────────────────────────────────── */
const SLEEP_ENERGY = 0.012
const SLEEP_FRAMES = 24
const LABEL_LIMIT  = 34
// Above the limit only these carry standing labels; episodes label on hover.
const ALWAYS_LABEL = new Set(['Entity', 'Concept', 'Contradiction'])

function MemoryGraphPanel({ refreshTrigger }) {
  const hostRef = useRef(null)
  const canvasRef = useRef(null)
  const stateRef = useRef({ nodes: [], edges: [], adj: new Map() })
  const viewRef = useRef({ hover: -1, selected: -1, W: 0, H: 0 })
  const loopRef = useRef({ raf: 0, still: 0, running: false })
  const drawRef = useRef(() => {})
  const wakeRef = useRef(() => {})
  const [counts, setCounts] = useState({ nodes: 0, edges: 0, byType: {} })
  const [showEpisodes, setShowEpisodes] = useState(true)
  const showEpisodesRef = useRef(true)

  const loadGraph = useCallback(async () => {
    try {
      const res = await api.get('/memory/graph')
      const { W, H } = viewRef.current
      const w = W || 700, h = H || 520
      const idMap = new Map()
      const byType = {}

      // Shrink nodes as the graph grows so density stays workable.
      const count = res.data.nodes.filter(
        n => showEpisodesRef.current || n.type !== 'Episode'
      ).length
      const scale = Math.max(0.55, Math.min(1, Math.sqrt(20 / Math.max(1, count))))

      const visible = res.data.nodes.filter(
        n => showEpisodesRef.current || n.type !== 'Episode'
      )

      for (const n of res.data.nodes) byType[n.type] = (byType[n.type] || 0) + 1

      const nodes = visible.map((n, i) => {
        const type = n.type
        // area encodes strength, so radius scales with the square root
        const strength = typeof n.confidence === 'number' ? n.confidence : 0.6
        idMap.set(n.id, i)
        return {
          id: n.id, idx: i, type,
          label: nodeLabel(n.label, type),
          r: (5 + Math.sqrt(Math.max(0.05, strength)) * 7.5 + (type === 'Contradiction' ? 2 : 0)) * scale,
          x: w * 0.5 + (Math.random() - 0.5) * w * 0.6,
          y: h * 0.5 + (Math.random() - 0.5) * h * 0.7,
          vx: 0, vy: 0,
        }
      })

      const edges = res.data.edges
        .filter(e => idMap.has(e.source) && idMap.has(e.target))
        .map(e => {
          const a = idMap.get(e.source), b = idMap.get(e.target)
          const conflict = nodes[a].type === 'Contradiction' || nodes[b].type === 'Contradiction'
          return { a, b, conflict, rel: e.relationship }
        })

      const adj = new Map()
      nodes.forEach(n => adj.set(n.idx, []))
      edges.forEach(e => { adj.get(e.a).push(e.b); adj.get(e.b).push(e.a) })

      stateRef.current = { nodes, edges, adj }
      viewRef.current.hover = -1
      viewRef.current.selected = -1
      setCounts({ nodes: nodes.length, edges: edges.length, byType })
      wakeRef.current()
    } catch (err) {
      console.error('Failed to load graph:', err)
    }
  }, [])

  useEffect(() => {
    showEpisodesRef.current = showEpisodes
    loadGraph()
  }, [loadGraph, refreshTrigger, showEpisodes])

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return
    const ctx = canvas.getContext('2d')
    const DPR = Math.min(window.devicePixelRatio || 1, 2)

    const resize = () => {
      const W = host.clientWidth, H = host.clientHeight
      viewRef.current.W = W; viewRef.current.H = H
      canvas.width = W * DPR; canvas.height = H * DPR
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      wake()
    }

    const step = () => {
      const { nodes, edges } = stateRef.current
      const { W, H } = viewRef.current
      const cx = W / 2, cy = H / 2
      let energy = 0

      // Spacing follows the area each node can claim, so the graph fills the
      // panel at any count instead of clumping once it grows.
      const cell = Math.sqrt((W * H) / Math.max(1, nodes.length))
      const rest = Math.max(70, Math.min(210, cell * 0.92))
      const sep = Math.max(26, Math.min(70, cell * 0.46))
      // Fewer nodes need holding together; many push themselves apart.
      // The vertical pull is weaker so the layout uses the full panel height
      // rather than settling into a horizontal band.
      const pull = 0.0009 * Math.max(0.3, Math.min(1, 14 / Math.max(1, nodes.length)))

      for (const n of nodes) {
        n.vx += (cx - n.x) * pull
        n.vy += (cy - n.y) * pull * 0.55
      }
      // Inverse-square repulsion across every pair — this is what opens the
      // graph out. Overlap prevention alone only stops collisions.
      const charge = cell * cell * 0.115
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j]
          let dx = a.x - b.x, dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = 1 }
          const d = Math.sqrt(d2)
          const f = Math.min(charge / d2, 2.4) / d
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f

          const min = a.r + b.r + sep
          if (d < min) {
            const g = 0.8 * (1 - d / min) / d
            a.vx += dx * g; a.vy += dy * g; b.vx -= dx * g; b.vy -= dy * g
          }
        }
      }
      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b]
        const dx = b.x - a.x, dy = b.y - a.y
        const d = Math.hypot(dx, dy) || 0.001
        const f = (d - rest) * 0.0034
        a.vx += (dx / d) * f; a.vy += (dy / d) * f
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
      }
      // A soft margin rather than a hard wall. Clamping made unconnected
      // nodes queue along the frame; this turns them back before they land.
      const margin = Math.max(40, cell * 0.5)
      for (const n of nodes) {
        const push = 0.045
        if (n.x < margin) n.vx += (margin - n.x) * push
        else if (n.x > W - margin) n.vx -= (n.x - (W - margin)) * push
        if (n.y < margin) n.vy += (margin - n.y) * push
        else if (n.y > H - margin) n.vy -= (n.y - (H - margin)) * push

        n.vx *= 0.84; n.vy *= 0.84
        const sp = Math.hypot(n.vx, n.vy)
        if (sp > 2.5) { n.vx = n.vx / sp * 2.5; n.vy = n.vy / sp * 2.5 }
        n.x += n.vx; n.y += n.vy

        // hard stop only at the very edge, as a last resort
        const pad = n.r + 6
        n.x = Math.max(pad, Math.min(W - pad, n.x))
        n.y = Math.max(pad, Math.min(H - pad, n.y))
        energy += n.vx * n.vx + n.vy * n.vy
      }
      return nodes.length ? energy / nodes.length : 0
    }

    const draw = () => {
      const { nodes, edges, adj } = stateRef.current
      const { W, H, hover, selected } = viewRef.current
      ctx.clearRect(0, 0, W, H)

      const focus = selected >= 0 ? selected : hover
      const near = focus >= 0 ? new Set([focus, ...(adj.get(focus) || [])]) : null
      const dim = (i) => (near && !near.has(i) ? 0.4 : 1)

      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b]
        const alpha = Math.min(dim(e.a), dim(e.b))
        ctx.save()
        ctx.globalAlpha = alpha
        if (e.conflict) {
          ctx.strokeStyle = '#f01f0a'
          ctx.lineWidth = 1.6
          ctx.setLineDash([7, 6])
        } else {
          ctx.strokeStyle = '#c7b593'
          ctx.lineWidth = 1.4
        }
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
        ctx.restore()
      }

      for (const n of nodes) {
        const c = NODE[n.type] || FALLBACK
        ctx.save()

        ctx.fillStyle = c.ring
        ctx.globalAlpha = dim(n.idx) * 0.5
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 7, 0, Math.PI * 2); ctx.fill()

        ctx.globalAlpha = dim(n.idx)
        ctx.fillStyle = c.fill
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill()

        if (n.type === 'Entity' || n.type === 'Source') {
          ctx.strokeStyle = c.ring === '#d5c5a4' ? '#8d8471' : c.ring
          ctx.lineWidth = 4
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r - 2, 0, Math.PI * 2); ctx.stroke()
        }
        if (focus === n.idx) {
          ctx.strokeStyle = '#191715'
          ctx.lineWidth = 1.5
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 11, 0, Math.PI * 2); ctx.stroke()
        }
        ctx.restore()
      }

      // Labels last, so a node never covers one. A label flips to the left
      // when it would leave the panel, and is skipped when it would land on
      // one already placed — the focused node always wins its slot.
      ctx.font = '700 9px "JetBrains Mono", monospace'
      ctx.textBaseline = 'middle'
      const placed = []
      const order = focus >= 0 ? [nodes[focus], ...nodes.filter(n => n.idx !== focus)] : nodes
      const showAll = nodes.length <= LABEL_LIMIT

      for (const n of order) {
        const isFocus = focus === n.idx
        if (!showAll && !isFocus && !ALWAYS_LABEL.has(n.type)) continue

        const w = ctx.measureText(n.label).width
        const gap = n.r + 7
        const flip = n.x + gap + w > W - 10
        const x = flip ? n.x - gap - w : n.x + gap
        const box = { x, y: n.y - 6, w, h: 12 }

        const clash = placed.some(p =>
          box.x < p.x + p.w && box.x + box.w > p.x &&
          box.y < p.y + p.h && box.y + box.h > p.y
        )
        if (clash && !isFocus) continue
        placed.push(box)

        const c = NODE[n.type] || FALLBACK
        ctx.save()
        ctx.globalAlpha = dim(n.idx)
        // knock the cream back out from under the text so edges don't cross it
        ctx.fillStyle = '#f4ecdc'
        ctx.fillRect(box.x - 2, box.y, w + 4, 12)
        ctx.fillStyle = c.label
        ctx.fillText(n.label, x, n.y)
        ctx.restore()
      }
    }
    drawRef.current = draw

    const frame = () => {
      const energy = step()
      draw()
      const l = loopRef.current
      l.still = energy < SLEEP_ENERGY ? l.still + 1 : 0
      if (l.still >= SLEEP_FRAMES) { l.running = false; return }
      l.raf = requestAnimationFrame(frame)
    }

    const wake = () => {
      const l = loopRef.current
      l.still = 0
      if (l.running) return
      l.running = true
      l.raf = requestAnimationFrame(frame)
    }
    wakeRef.current = wake

    const pick = (evt) => {
      const r = canvas.getBoundingClientRect()
      const mx = evt.clientX - r.left, my = evt.clientY - r.top
      const { nodes } = stateRef.current
      let best = -1, bd = Infinity
      for (const n of nodes) {
        const d = (n.x - mx) ** 2 + (n.y - my) ** 2
        if (d < bd && d < (n.r + 16) ** 2) { bd = d; best = n.idx }
      }
      return best
    }

    // Repaint only — never wake the simulation, or the target moves.
    const onMove = (e) => {
      const hit = pick(e)
      if (hit === viewRef.current.hover) return
      viewRef.current.hover = hit
      canvas.style.cursor = hit >= 0 ? 'pointer' : 'default'
      draw()
    }
    const onLeave = () => { viewRef.current.hover = -1; draw() }
    const onClick = (e) => {
      const hit = pick(e)
      viewRef.current.selected = hit === viewRef.current.selected ? -1 : hit
      draw()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('click', onClick)

    return () => {
      cancelAnimationFrame(loopRef.current.raf)
      loopRef.current.running = false
      ro.disconnect()
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
      canvas.removeEventListener('click', onClick)
    }
  }, [])

  const legend = [
    ['Episode', 'Episode'], ['Entity', 'Entity'], ['Contradiction', 'Contradiction'],
    ['Concept', 'Concept'], ['Source', 'Source'],
  ]

  return (
    <section style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
      background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 22px 16px 34px', flex: 'none' }}>
        <span className="eg-panel-title">Memory graph</span>
        <span className="eg-mono" style={{ fontSize: 11.5, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'var(--n600)' }}>
          {counts.nodes} nodes · {counts.edges} edges
        </span>
      </div>

      {/* 34px of left padding keeps the panel off the sidebar edge */}
      <div style={{ flex: 1, minHeight: 0, padding: '0 22px 0 34px' }}>
        <div ref={hostRef} style={{ position: 'relative', width: '100%', height: '100%',
          overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
            backgroundImage:
              'linear-gradient(to right, var(--grid) 1px, transparent 1px),' +
              'linear-gradient(to bottom, var(--grid) 1px, transparent 1px)',
            backgroundSize: '58px 58px',
            WebkitMaskImage: 'radial-gradient(ellipse 78% 78% at 50% 50%, #000 55%, transparent 100%)',
            maskImage: 'radial-gradient(ellipse 78% 78% at 50% 50%, #000 55%, transparent 100%)' }} />
          <Brackets />
          <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, display: 'block' }} />
        </div>
      </div>

      <div style={{ padding: '16px 22px 18px 34px', flex: 'none', display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', alignItems: 'baseline' }}>
          <span className="eg-label" style={{ color: 'var(--ink)' }}>How to read</span>
          <span style={{ fontFamily: 'var(--sans)', fontSize: 11.5, fontWeight: 600,
            letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--n600)' }}>
            Area = strength · red = contradiction · click a node to isolate it
          </span>
          <button className="eg-link" style={{ marginLeft: 'auto' }}
            onClick={() => setShowEpisodes(v => !v)} aria-pressed={showEpisodes}>
            {showEpisodes ? 'Hide turns' : 'Show turns'}
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))',
          gridAutoFlow: 'column', gridTemplateRows: 'repeat(3,auto)', gap: '7px 26px' }}>
          {legend.map(([type, name]) => {
            const c = NODE[type]
            return (
              <span key={type} style={{ display: 'flex', alignItems: 'center', gap: 9,
                fontFamily: 'var(--sans)', fontSize: 12.5, fontWeight: 700,
                letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--n700)',
                opacity: type === 'Episode' && !showEpisodes ? 0.4 : 1 }}>
                <span style={{ width: 11, height: 11, flex: 'none', borderRadius: '50%',
                  background: c.fill,
                  border: type === 'Entity' || type === 'Source' ? `3px solid ${c.ring}` : 'none' }} />
                <span style={{ color: type === 'Contradiction' ? 'var(--accent-700)' : 'inherit' }}>
                  {name}
                </span>
                <span style={{ marginLeft: 'auto', color: 'var(--n500)' }}>
                  {counts.byType[type] || 0}
                </span>
              </span>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function Brackets() {
  const arm = 16, off = 8
  const base = { position: 'absolute', width: arm, height: arm, borderColor: 'var(--bracket)',
    borderStyle: 'solid', pointerEvents: 'none' }
  return (
    <>
      <span style={{ ...base, top: off, left: off, borderWidth: '2px 0 0 2px' }} />
      <span style={{ ...base, top: off, right: off, borderWidth: '2px 2px 0 0' }} />
      <span style={{ ...base, bottom: off, left: off, borderWidth: '0 0 2px 2px' }} />
      <span style={{ ...base, bottom: off, right: off, borderWidth: '0 2px 2px 0' }} />
    </>
  )
}

/* ──────────────────────────────────────────────────────────────
   Minimal markdown. Covers what the model actually emits — headings,
   bold, inline code, bullets, numbered lists. Not a full parser.
   ────────────────────────────────────────────────────────────── */
function inline(text, keyBase) {
  const parts = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g
  let last = 0, m, i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) {
      parts.push(<strong key={`${keyBase}b${i++}`}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('`')) {
      parts.push(
        <code key={`${keyBase}c${i++}`} style={{ fontFamily: 'var(--mono)', fontSize: '0.88em',
          background: 'var(--n200)', padding: '1px 5px' }}>{tok.slice(1, -1)}</code>
      )
    } else {
      parts.push(<em key={`${keyBase}i${i++}`}>{tok.slice(1, -1)}</em>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function Markdown({ text }) {
  const blocks = []
  let list = null

  const flush = () => {
    if (!list) return
    const Tag = list.ordered ? 'ol' : 'ul'
    blocks.push(
      <Tag key={`l${blocks.length}`} style={{ margin: '8px 0', paddingLeft: 22 }}>
        {list.items.map((it, i) => (
          <li key={i} style={{ margin: '3px 0', lineHeight: 1.55 }}>{inline(it, `${blocks.length}-${i}`)}</li>
        ))}
      </Tag>
    )
    list = null
  }

  for (const raw of (text || '').split('\n')) {
    const line = raw.trimEnd()
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)

    if (heading) {
      flush()
      const level = heading[1].length
      blocks.push(
        <div key={`h${blocks.length}`} style={{ margin: '14px 0 6px', fontWeight: 700,
          fontSize: level <= 2 ? 15.5 : 14.5, letterSpacing: '-0.01em' }}>
          {inline(heading[2], `h${blocks.length}`)}
        </div>
      )
    } else if (bullet || numbered) {
      const ordered = !!numbered
      const item = (bullet || numbered)[1]
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] } }
      list.items.push(item)
    } else if (line.trim() === '') {
      flush()
    } else {
      flush()
      blocks.push(
        <p key={`p${blocks.length}`} style={{ margin: '8px 0', lineHeight: 1.55 }}>
          {inline(line, `p${blocks.length}`)}
        </p>
      )
    }
  }
  flush()
  return <>{blocks}</>
}

/* ──────────────────────────────────────────────────────────────
   Grounding block. Collapsed by default; a weak score opens itself.
   ────────────────────────────────────────────────────────────── */
const SEGMENTS = 22
const WEAK = 0.5

function GroundingBlock({ grounding, memories, contradictions, onFeedback }) {
  const score = grounding.grounding_score ?? 0
  const weak = score < WEAK
  const [open, setOpen] = useState(weak)

  const cited = grounding.citations || []
  const missing = grounding.ungrounded_claims || []
  const mems = memories || []
  const total = cited.length + missing.length
  const filled = Math.round(score * SEGMENTS)
  const tone = weak ? 'var(--accent)' : 'var(--ink)'

  const summary = total === 0
    ? `no claims to check · ${mems.length} memories`
    : weak
      ? `needs review · ${cited.length}/${total} verified · ${mems.length} memories`
      : `${cited.length}/${total} verified · ${mems.length} memories`

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span className="eg-mono" style={{ fontSize: 22, fontWeight: 700, color: tone,
          letterSpacing: '-0.01em' }}>
          {(score * 100).toFixed(0)}%
        </span>
        <span className="eg-label">Grounded</span>
        <span className="eg-seg" aria-hidden="true">
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <i key={i} style={i < filled ? { background: tone } : undefined} />
          ))}
        </span>
        <span className="eg-mono" style={{ fontSize: 12.5, color: 'var(--n700)' }}>{summary}</span>
        {total > 0 && (
          <button className="eg-link" style={{ marginLeft: 'auto' }}
            onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide evidence' : 'Evidence'}
          </button>
        )}
      </div>

      {open && total > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="eg-label" style={{ marginBottom: 6 }}>Claims checked</div>
          {cited.map((c, i) => (
            <div key={`c${i}`} className="eg-claim">
              <span className="eg-tick" />
              <span style={{ flex: 1, minWidth: 0, color: 'var(--ink-dim)' }}>{c.claim}</span>
              <span className="eg-mono" style={{ fontSize: 12, color: 'var(--ink)' }}>
                {c.trust_score != null ? c.trust_score.toFixed(2) : '—'}
              </span>
            </div>
          ))}
          {missing.map((c, i) => (
            <div key={`u${i}`} className="eg-claim">
              <span className="eg-tick" data-off="true" />
              <span style={{ flex: 1, minWidth: 0, color: 'var(--ink-dim)' }}>{c}</span>
              <span className="eg-mono" style={{ fontSize: 12, color: 'var(--accent)' }}>—</span>
            </div>
          ))}

          {mems.length > 0 ? (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--n300)' }}>
              <div className="eg-label" style={{ marginBottom: 6 }}>Memories used</div>
              {mems.map((m, i) => (
                <div key={i} className="eg-memrow">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0,
                    fontSize: 13, color: 'var(--ink-dim)' }}>
                    <span style={{ width: 9, height: 9, flex: 'none', borderRadius: '50%',
                      background: (NODE[m.type] || FALLBACK).fill }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap' }}>{m.text}</span>
                    <span className="eg-mono" style={{ fontSize: 11, color: 'var(--n500)' }}>
                      {(m.similarity * 100).toFixed(0)}%
                    </span>
                  </span>
                  <span className="acts">
                    <button className="eg-ghost" onClick={() => onFeedback(m.id, 'correct')}>
                      Confirm
                    </button>
                    <button className="eg-ghost" data-tone="warn"
                      onClick={() => onFeedback(m.id, 'incorrect')}>
                      Dispute
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="eg-label" style={{ marginTop: 14, color: 'var(--accent-700)' }}>
              No memory retrieved
            </div>
          )}

          {contradictions?.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid var(--accent)` }}>
              <div className="eg-label" style={{ color: 'var(--accent-700)', marginBottom: 6 }}>
                Conflicts held
              </div>
              {contradictions.map((c, i) => (
                <div key={i} style={{ fontSize: 13, color: 'var(--ink-dim)', padding: '3px 0' }}>
                  {c.existing_fact} <span style={{ color: 'var(--accent)' }}>vs</span> {c.new_fact}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
   Transcript.
   ────────────────────────────────────────────────────────────── */
function Transcript({ messages, stageLabel, input, setInput, send, loading, onFeedback, meanScore, turns }) {
  const scrollRef = useRef(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, loading])

  return (
    <section style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
      background: 'var(--surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 30px', flex: 'none', borderBottom: '1px solid var(--n300)' }}>
        <span className="eg-panel-title">Transcript</span>
        <span className="eg-mono" style={{ fontSize: 11.5, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'var(--n600)' }}>
          {turns} turns{meanScore != null && ` · mean grounding ${(meanScore * 100).toFixed(0)}%`}
        </span>
      </div>

      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {messages.length === 0 && (
          <div style={{ padding: '90px 34px', maxWidth: 460 }}>
            <div className="eg-label" style={{ marginBottom: 10 }}>Nothing stored yet</div>
            <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: 'var(--ink-dim)' }}>
              Say something and it gets recorded, not answered from. The first few turns
              build the graph; grounding starts once there's something to ground against.
            </p>
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.role === 'assistant' && msg.content === '' && msg.streaming) return null
          const weak = msg.grounding ? msg.grounding.grounding_score < WEAK : false

          return (
            <article key={i} className="eg-turn" data-weak={weak}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 11, marginBottom: 9 }}>
                <span className="eg-label" style={{ color: 'var(--ink)' }}>
                  {msg.role === 'user' ? 'You' : 'Engram'}
                </span>
                <span className="eg-mono" style={{ fontSize: 10.5, color: 'var(--n500)' }}>
                  {msg.mid}
                </span>
                <span className="eg-mono" style={{ marginLeft: 'auto', fontSize: 10.5,
                  color: 'var(--n500)' }}>{msg.at}</span>
              </div>

              <div style={{ display: 'flex', gap: 15 }}>
                <span className="eg-rule" data-weak={weak} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, lineHeight: 1.6 }}>
                    {msg.role === 'assistant'
                      ? <Markdown text={msg.content} />
                      : <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>}
                    {msg.streaming && <span className="eg-caret" />}
                  </div>
                  {msg.grounding && (
                    <GroundingBlock
                      grounding={msg.grounding}
                      memories={msg.memories}
                      contradictions={msg.contradictions}
                      onFeedback={onFeedback}
                    />
                  )}
                </div>
              </div>
            </article>
          )
        })}

        {stageLabel && (
          <div className="eg-turn">
            <span className="eg-label">Engram</span>
            <div className="eg-mono" style={{ marginTop: 8, fontSize: 13, color: 'var(--n600)' }}>
              {stageLabel}…
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: 'none', display: 'flex', gap: 12, padding: '18px 30px',
        borderTop: '1px solid var(--n300)' }}>
        <input
          className="eg-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Say something — every claim in the reply gets checked"
          disabled={loading}
        />
        <button className="eg-send" onClick={send} disabled={loading}>Send</button>
      </div>
    </section>
  )
}

/* ──────────────────────────────────────────────────────────────
   Agent trace.
   ────────────────────────────────────────────────────────────── */
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)

function TraceScreen({ refreshTrigger }) {
  const [traces, setTraces] = useState([])
  const [expandedId, setExpandedId] = useState(null)
  const [details, setDetails] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.get('/traces?limit=25')
      .then(res => { if (alive) setTraces(res.data.traces || []) })
      .catch(err => console.error('Failed to load traces:', err))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [refreshTrigger])

  const toggle = async (id) => {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    if (details[id]) return
    try {
      const res = await api.get(`/traces/${id}`)
      setDetails(prev => ({ ...prev, [id]: res.data.events || [] }))
    } catch (err) {
      console.error('Failed to load trace detail:', err)
    }
  }

  const timeAgo = (iso) => {
    if (!iso) return ''
    const s = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  }

  return (
    <div style={{ overflowY: 'auto', padding: '26px 34px' }}>
      {loading && <div className="eg-label">Loading</div>}
      {!loading && traces.length === 0 && (
        <div style={{ maxWidth: 420 }}>
          <div className="eg-label" style={{ marginBottom: 10 }}>No traces</div>
          <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: 'var(--ink-dim)' }}>
            Every turn writes a trace of which agents ran and how long each took.
            Send a message to make one.
          </p>
        </div>
      )}

      {traces.map((t) => {
        const events = details[t.trace_id] || []
        const maxMs = Math.max(...events.map(e => e.latency_ms || 0), 1)
        const open = expandedId === t.trace_id
        return (
          <div key={t.trace_id} style={{ borderBottom: '1px solid var(--n300)' }}>
            <button onClick={() => toggle(t.trace_id)}
              style={{ display: 'flex', alignItems: 'center', gap: 22, width: '100%',
                padding: '13px 4px', background: 'none', border: 0, cursor: 'pointer',
                fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-dim)', textAlign: 'left' }}>
              <span style={{ width: 10, color: 'var(--n500)' }}>{open ? '−' : '+'}</span>
              <span style={{ width: 80, color: 'var(--n600)' }}>{timeAgo(t.started_at)}</span>
              <span style={{ width: 70, color: 'var(--ink)', fontWeight: 500 }}>
                {fmtMs(t.total_latency_ms)}
              </span>
              <span style={{ width: 110 }}>
                {(t.total_tokens_input + t.total_tokens_output).toLocaleString()} tok
              </span>
              <span style={{ width: 90 }}>{t.agent_count} agents</span>
              {t.error_count > 0 && (
                <span style={{ color: 'var(--accent-700)' }}>{t.error_count} errors</span>
              )}
            </button>

            {open && (
              <div style={{ padding: '4px 4px 18px 46px', display: 'grid', gap: 7 }}>
                {events.length === 0 && <span className="eg-label">Loading</span>}
                {events.map((e, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12,
                    fontFamily: 'var(--mono)', fontSize: 11 }}>
                    <span style={{ width: 160, flex: 'none', color: 'var(--ink-dim)' }}>
                      {e.agent_name}
                    </span>
                    <span className="eg-tracebar" style={{
                      width: `${Math.max(2, ((e.latency_ms || 0) / maxMs) * 100)}%`,
                      maxWidth: 320,
                      background: e.status === 'error'
                        ? 'var(--accent)'
                        : (AGENT_COLOR[e.agent_name] || '#8d8471'),
                    }} />
                    <span style={{ color: 'var(--n600)', fontSize: 10 }}>
                      {fmtMs(e.latency_ms || 0)}
                    </span>
                    {(e.tokens_input > 0 || e.tokens_output > 0) && (
                      <span style={{ color: 'var(--n500)', fontSize: 10 }}>
                        · {(e.tokens_input + e.tokens_output).toLocaleString()} tok
                      </span>
                    )}
                    {e.status === 'error' && (
                      <span style={{ color: 'var(--accent-700)', fontSize: 10 }}>· error</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
   Documents. Ingest by URL or PDF, then list what landed.
   Page counts are not stored on Source nodes, so the table reports
   chunks written — which is what actually entered the graph.
   ────────────────────────────────────────────────────────────── */
function DocumentsScreen({ onIngest }) {
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/documents')
      setDocs(res.data.documents || [])
    } catch (err) {
      console.error('Failed to load documents:', err)
      setError('Could not load documents.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const fail = (err, fallback) => {
    const d = err.response?.data?.detail
    setError(typeof d === 'string' ? d : fallback)
  }

  const ingestUrl = async () => {
    if (!url.trim() || busy) return
    setError(''); setBusy('url')
    try {
      await api.post('/documents/url', { url: url.trim() })
      setUrl('')
      await load()
      onIngest()
    } catch (err) {
      fail(err, 'Could not fetch that URL.')
    } finally {
      setBusy('')
    }
  }

  const uploadPdf = async (file) => {
    if (!file || busy) return
    setError(''); setBusy('file')
    const form = new FormData()
    form.append('file', file)
    try {
      // Content-Type is left unset so the browser adds the multipart boundary
      await api.post('/documents/upload', form)
      await load()
      onIngest()
    } catch (err) {
      fail(err, 'Could not read that PDF.')
    } finally {
      setBusy('')
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const remove = async (id) => {
    try {
      await api.delete(`/documents/${id}`)
      await load()
      onIngest()
    } catch (err) {
      fail(err, 'Could not delete that document.')
    }
  }

  const totalChunks = docs.reduce((s, d) => s + (d.total_chunks || 0), 0)
  const totalPages = docs.reduce((s, d) => s + (d.page_count || 0), 0)

  return (
    <div style={{ overflowY: 'auto', padding: '26px 34px 40px' }}>
      <div className="eg-label" style={{ marginBottom: 8 }}>Ingest a source</div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
        <input
          className="eg-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ingestUrl()}
          placeholder="https://…"
          disabled={!!busy}
        />
        <button className="eg-send" style={{ padding: '0 30px', flex: 'none' }}
          onClick={ingestUrl} disabled={!!busy}>
          {busy === 'url' ? 'Reading' : 'Ingest'}
        </button>
        <button className="eg-send" style={{ padding: '0 30px', flex: 'none',
          background: 'transparent', color: 'var(--ink)' }}
          onClick={() => fileRef.current?.click()} disabled={!!busy}>
          {busy === 'file' ? 'Reading' : 'Upload PDF'}
        </button>
        <input ref={fileRef} type="file" accept="application/pdf" style={{ display: 'none' }}
          onChange={(e) => uploadPdf(e.target.files?.[0])} />
      </div>

      {error && <div className="eg-err" style={{ marginTop: 14 }}>{error}</div>}

      <div style={{ height: 1, background: 'var(--n400)', margin: '26px 0 20px' }} />

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 14 }}>
        <span className="eg-panel-title">Documents</span>
        <span className="eg-label">
          {docs.length} sources · {totalChunks} nodes written
          {totalPages > 0 && ` · ${totalPages} pages`}
        </span>
      </div>

      {loading && <div className="eg-label">Loading</div>}

      {!loading && docs.length === 0 && (
        <p style={{ margin: 0, maxWidth: 460, fontSize: 16, lineHeight: 1.6,
          color: 'var(--ink-dim)' }}>
          Nothing ingested yet. Add a URL or a PDF and its text becomes
          retrievable alongside everything you've said.
        </p>
      )}

      {!loading && docs.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14,
          tableLayout: 'fixed' }}>
          <colgroup>
            <col />
            <col style={{ width: 110 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          <thead>
            <tr>
              {[
                ['Source', 'left'], ['Kind', 'left'], ['Pages', 'right'],
                ['Nodes written', 'right'], ['Added', 'left'], ['', 'right'],
              ].map(([h, align], i) => (
                <th key={i} className="eg-label" style={{ textAlign: align,
                  padding: '0 14px 10px 0', borderBottom: '1px solid var(--n400)',
                  fontWeight: 500 }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.document_id} style={{ borderBottom: '1px solid var(--n300)' }}>
                <td style={{ padding: '14px 14px 14px 0' }}>
                  <span style={{ display: 'block', overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.document_name}
                  </span>
                  {d.source_url && (
                    <a href={d.source_url} target="_blank" rel="noreferrer"
                      className="eg-mono" style={{ display: 'block', marginTop: 2,
                        fontSize: 11, color: 'var(--n600)', overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.source_url.replace(/^https?:\/\//, '')}
                    </a>
                  )}
                </td>
                <td className="eg-mono" style={{ padding: '14px 14px 14px 0', fontSize: 11,
                  letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--n600)' }}>
                  {d.document_source}
                </td>
                <td className="eg-mono" style={{ padding: '14px 14px 14px 0', textAlign: 'right',
                  color: d.page_count ? 'var(--ink)' : 'var(--n500)' }}>
                  {d.page_count || '—'}
                </td>
                <td className="eg-mono" style={{ padding: '14px 14px 14px 0', textAlign: 'right' }}>
                  {d.total_chunks}
                </td>
                <td className="eg-mono" style={{ padding: '14px 14px 14px 0', fontSize: 11.5,
                  color: 'var(--n600)' }}>
                  {(d.created_at || '').slice(0, 10)}
                </td>
                <td style={{ padding: '14px 0', textAlign: 'right' }}>
                  <button className="eg-ghost" data-tone="warn"
                    onClick={() => remove(d.document_id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
   Sessions. Episodes carry no session id, so turns are grouped by
   the day they were written — a real boundary rather than a fake one.
   ────────────────────────────────────────────────────────────── */
const DAY_FMT = { weekday: 'long', day: 'numeric', month: 'long' }

function SessionsScreen({ refreshTrigger }) {
  const [episodes, setEpisodes] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.get('/memory/episodes')
      .then(res => { if (alive) setEpisodes(res.data.episodes || []) })
      .catch(err => console.error('Failed to load episodes:', err))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [refreshTrigger])

  const days = useMemo(() => {
    const groups = new Map()
    for (const e of episodes) {
      const key = (e.created_at || '').slice(0, 10)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(e)
    }
    return [...groups.entries()]
  }, [episodes])

  const dayLabel = (key) => {
    if (!key) return 'Undated'
    const d = new Date(key + 'T00:00:00')
    const today = new Date().toISOString().slice(0, 10)
    if (key === today) return 'Today'
    return d.toLocaleDateString('en-GB', DAY_FMT)
  }

  const clock = (iso) => {
    if (!iso) return ''
    const t = iso.includes('T') ? iso.split('T')[1] : ''
    return t.slice(0, 5)
  }

  return (
    <div style={{ overflowY: 'auto', padding: '26px 34px' }}>
      {loading && <div className="eg-label">Loading</div>}

      {!loading && episodes.length === 0 && (
        <div style={{ maxWidth: 440 }}>
          <div className="eg-label" style={{ marginBottom: 10 }}>Nothing recorded</div>
          <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: 'var(--ink-dim)' }}>
            Every turn you take is written as an episode. Say something in Chat
            and it will appear here.
          </p>
        </div>
      )}

      {days.map(([key, items]) => (
        <div key={key} style={{ marginBottom: 30 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12,
            paddingBottom: 8, borderBottom: '1px solid var(--n400)' }}>
            <span className="eg-panel-title">{dayLabel(key)}</span>
            <span className="eg-label">{items.length} turns</span>
          </div>

          {items.map((e) => (
            <div key={e.id} style={{ display: 'flex', gap: 16, padding: '11px 0',
              borderBottom: '1px solid var(--n300)', alignItems: 'baseline' }}>
              <span className="eg-mono" style={{ width: 46, flex: 'none', fontSize: 11.5,
                color: 'var(--n600)' }}>
                {clock(e.created_at)}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 14 }}>
                {e.summary || <span style={{ color: 'var(--n500)' }}>no summary</span>}
              </span>
              <span className="eg-mono" style={{ flex: 'none', fontSize: 11.5,
                color: e.confidence >= 0.9 ? 'var(--ink)' : 'var(--n600)' }}>
                {e.confidence != null ? e.confidence.toFixed(2) : '—'}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
   Shell.
   ────────────────────────────────────────────────────────────── */
function AppInner({ email, onLogout }) {
  const [view, setView] = useState('chat')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [graphRefresh, setGraphRefresh] = useState(0)
  const sessionId = useMemo(
    () => '0x' + Math.random().toString(16).slice(2, 6).toUpperCase(), []
  )

  const sendMessage = async () => {
    if (!input.trim() || loading) return
    const userMessage = input
    setInput('')
    const assistantIndex = messages.length + 1

    setMessages(prev => [
      ...prev,
      { role: 'user', content: userMessage, mid: shortId(), at: clockTime() },
      { role: 'assistant', content: '', mid: shortId(), at: clockTime(),
        memories: null, grounding: null, streaming: true },
    ])
    setLoading(true)

    try {
      const token = localStorage.getItem('engram_token')
      const res = await fetch(`${API_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: userMessage }),
      })

      if (res.status === 401) { _onUnauthorized && _onUnauthorized(); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const frames = buffer.split('\n\n')
        buffer = frames.pop()

        for (const frame of frames) {
          const line = frame.trim()
          if (!line.startsWith('data:')) continue
          let evt
          try { evt = JSON.parse(line.slice(5).trim()) } catch { continue }

          setMessages(prev => {
            const next = [...prev]
            const msg = { ...next[assistantIndex] }
            if (evt.type === 'token') msg.content += evt.text
            else if (evt.type === 'memories') msg.memories = evt.memories
            else if (evt.type === 'grounding') msg.grounding = evt.grounding
            else if (evt.type === 'contradictions') msg.contradictions = evt.contradictions
            else if (evt.type === 'status') msg.stage = evt.stage
            else if (evt.type === 'error') { msg.content = `Error: ${evt.message}`; msg.streaming = false }
            else if (evt.type === 'done') { msg.streaming = false; msg.stage = null }
            next[assistantIndex] = msg
            return next
          })

          if (evt.type === 'done') setGraphRefresh(p => p + 1)
        }
      }
    } catch (err) {
      console.error(err)
      setMessages(prev => {
        const next = [...prev]
        next[assistantIndex] = {
          ...next[assistantIndex],
          content: 'Could not reach the backend. Check that the service is awake and try again.',
          streaming: false,
        }
        return next
      })
    } finally {
      setLoading(false)
    }
  }

  const sendFeedback = async (nodeId, feedback) => {
    try {
      await api.post('/memory/feedback', { node_id: nodeId, feedback })
      setGraphRefresh(p => p + 1)
    } catch (err) {
      console.error('Feedback error:', err)
    }
  }

  const resetSession = () => { setMessages([]); setGraphRefresh(p => p + 1) }

  const lastMsg = messages[messages.length - 1]
  const stageLabel = loading && lastMsg?.role === 'assistant' && lastMsg?.content === ''
    ? (lastMsg?.stage || 'thinking')
    : null

  const scored = messages.filter(m => m.grounding)
  const meanScore = scored.length
    ? scored.reduce((s, m) => s + m.grounding.grounding_score, 0) / scored.length
    : null
  const turns = messages.filter(m => m.role === 'user').length

  const badges = { chat: turns || null, documents: null, sessions: null, trace: null }
  const heading = {
    chat: ['Chat', 'every claim in the reply is checked against the graph'],
    documents: ['Documents', 'sources ingested into the graph'],
    sessions: ['Sessions', 'past conversations and what they wrote'],
    trace: ['Agent Trace', 'which agents ran, and how long each took'],
  }[view]

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg)' }}>
      <nav style={{ width: 196, flex: 'none', position: 'relative', zIndex: 3,
        background: 'var(--bg)', display: 'flex', flexDirection: 'column',
        boxShadow: '3px 0 6px rgba(25,23,21,0.10), 14px 0 30px rgba(25,23,21,0.16)' }}>
        <div style={{ padding: '18px 18px 16px', borderBottom: '1px solid var(--n300)',
          display: 'grid', gap: 9, justifyItems: 'start' }}>
          <span className="eg-mark">
            <span className="shadow" />
            <span className="block"><span className="word">engram</span></span>
          </span>
          <span className="eg-label">Memory layer</span>
        </div>

        <div style={{ padding: '8px 0' }}>
          {NAV.map(n => (
            <button key={n.id} className="eg-nav" data-active={view === n.id}
              onClick={() => setView(n.id)}>
              <span>{n.label}</span>
              {badges[n.id] != null && <span className="badge">{badges[n.id]}</span>}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 'auto', borderTop: '1px solid var(--n300)', padding: '14px 18px',
          display: 'grid', gap: 9 }}>
          <span className="eg-label">Signed in</span>
          <span style={{ fontSize: 13.5, lineHeight: 1.35, wordBreak: 'break-all' }}>{email}</span>
          <button className="eg-link" style={{ justifySelf: 'start' }} onClick={onLogout}>
            Log out
          </button>
        </div>
      </nav>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 24px',
          height: 64, flex: 'none', background: 'var(--surface)', position: 'relative', zIndex: 2,
          boxShadow: '0 1px 0 var(--n400), 0 3px 8px rgba(25,23,21,0.07)' }}>
          <span style={{ fontWeight: 800, fontSize: 17, letterSpacing: '0.01em',
            textTransform: 'uppercase' }}>{heading[0]}</span>
          <span style={{ fontSize: 13.5, color: 'var(--n600)' }}>{heading[1]}</span>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="eg-mono" style={{ fontSize: 12, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: 'var(--n600)' }}>
              session {sessionId}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--n400)', padding: '6px 11px', fontFamily: 'var(--sans)',
              fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em',
              textTransform: 'uppercase' }}>
              <span style={{ width: 7, height: 7, flex: 'none', background: 'var(--accent)' }} />
              live
            </span>
            <button className="eg-ghost" style={{ textTransform: 'none', fontSize: 13,
              letterSpacing: 0, padding: '7px 14px' }}
              onClick={resetSession}>Reset session</button>
          </div>
        </header>

        {view === 'chat' ? (
          <div style={{ flex: 1, minHeight: 0, display: 'grid',
            gridTemplateColumns: 'minmax(0,42fr) 1px minmax(0,58fr)' }}>
            <MemoryGraphPanel refreshTrigger={graphRefresh} />
            <span style={{ background: 'var(--n400)' }} />
            <Transcript
              messages={messages}
              stageLabel={stageLabel}
              input={input}
              setInput={setInput}
              send={sendMessage}
              loading={loading}
              onFeedback={sendFeedback}
              meanScore={meanScore}
              turns={turns}
            />
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex',
            flexDirection: 'column', background: 'var(--surface)' }}>
            {view === 'trace' && <TraceScreen refreshTrigger={graphRefresh} />}
            {view === 'documents' && (
              <DocumentsScreen onIngest={() => setGraphRefresh(p => p + 1)} />
            )}
            {view === 'sessions' && <SessionsScreen refreshTrigger={graphRefresh} />}
          </div>
        )}
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
   Root — auth gate.
   ────────────────────────────────────────────────────────────── */
function App() {
  const [authed, setAuthed] = useState(!!localStorage.getItem('engram_token'))
  const [email, setEmail] = useState(localStorage.getItem('engram_email') || '')

  const logout = () => {
    localStorage.removeItem('engram_token')
    localStorage.removeItem('engram_email')
    setAuthed(false)
    setEmail('')
  }

  useEffect(() => { _onUnauthorized = logout; return () => { _onUnauthorized = null } }, [])

  return (
    <>
      <StyleTokens />
      {authed
        ? <AppInner email={email} onLogout={logout} />
        : <AuthScreen onAuthed={(e) => { setEmail(e); setAuthed(true) }} />}
    </>
  )
}

export default App