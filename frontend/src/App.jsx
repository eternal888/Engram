import { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'

const API_URL = 'http://localhost:8000/api'

const TYPE_COLOR = {
  Episode:       '#5b9bff',
  Concept:       '#4ec9a3',
  Entity:        '#f59e5b',
  Source:        '#b87dff',
  Contradiction: '#ff5d6c',
}
const FALLBACK = '#6b7280'

/* ──────────────────────────────────────────────────────────────
   Design tokens + fonts injected once. No Tailwind config needed.
   ────────────────────────────────────────────────────────────── */
function StyleTokens() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap');

      :root{
        --bg:#0a0a0a; --bg-2:#0d0d0f;
        --ink:#ededed; --ink-dim:#8a8a8e; --ink-faint:#4a4a4f;
        --line:rgba(255,255,255,0.06); --line-strong:rgba(255,255,255,0.12);
        --episode:#5b9bff; --concept:#4ec9a3; --entity:#f59e5b;
        --source:#b87dff; --contradiction:#ff5d6c;
        --sans:"Space Grotesk",ui-sans-serif,system-ui,sans-serif;
        --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
      }
      *{box-sizing:border-box}
      html,body,#root{margin:0;padding:0;min-height:100%;background:var(--bg);color:var(--ink);font-family:var(--sans)}
      body{background:radial-gradient(120% 80% at 50% 30%, #0e0e10 0%, #0a0a0a 55%, #060607 100%)}
      ::-webkit-scrollbar{width:9px;height:9px}
      ::-webkit-scrollbar-track{background:transparent}
      ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:6px}
      ::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.16)}

      .eg-grid{
        position:absolute;inset:0;pointer-events:none;
        background-image:
          linear-gradient(to right, rgba(255,255,255,0.035) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(255,255,255,0.035) 1px, transparent 1px);
        background-size:56px 56px;
        -webkit-mask-image:radial-gradient(ellipse at 50% 40%, #000 0%, rgba(0,0,0,0.6) 50%, transparent 82%);
        mask-image:radial-gradient(ellipse at 50% 40%, #000 0%, rgba(0,0,0,0.6) 50%, transparent 82%);
      }

      .eg-mono{font-family:var(--mono)}
      .eg-pill{
        display:inline-flex;align-items:center;gap:8px;padding:6px 12px;
        border:1px solid var(--line-strong);border-radius:999px;
        background:rgba(20,20,22,0.55);backdrop-filter:blur(8px);
        font-family:var(--mono);font-size:11px;color:var(--ink-dim);letter-spacing:0.04em;
      }
      .eg-pill .dot{width:6px;height:6px;border-radius:50%;background:var(--concept);box-shadow:0 0 8px var(--concept)}

      .eg-eyebrow{
        display:inline-flex;align-items:center;gap:10px;
        font-family:var(--mono);font-size:11px;letter-spacing:0.18em;text-transform:uppercase;
        color:var(--ink-dim);padding:6px 12px;border:1px solid var(--line-strong);
        border-radius:999px;background:rgba(14,14,16,0.55);backdrop-filter:blur(6px);
      }
      .eg-eyebrow .seq,.eg-eyebrow .sep{color:var(--ink-faint)}

      .eg-title{
        font-family:var(--sans);font-weight:500;
        font-size:clamp(56px,10vw,140px);line-height:0.92;letter-spacing:-0.045em;
        margin:18px 0 14px;color:var(--ink);
        text-shadow:0 0 60px rgba(91,155,255,0.08),0 0 120px rgba(78,201,163,0.05);
      }
      .eg-title .blink{
        display:inline-block;width:0.16em;height:0.16em;border-radius:50%;
        background:var(--episode);transform:translateY(-0.6em);margin-left:0.05em;
        box-shadow:0 0 16px var(--episode);animation:egblink 2.8s ease-in-out infinite;
      }
      @keyframes egblink{0%,55%,100%{opacity:1}60%,68%{opacity:0.25}72%{opacity:1}}

      .eg-tagline{
        font-family:var(--sans);font-weight:400;font-size:clamp(15px,1.3vw,19px);
        color:var(--ink-dim);max-width:620px;line-height:1.45;
      }
      .eg-tagline em{color:var(--ink);font-style:normal;font-weight:500}

      .eg-btn{
        font-family:var(--mono);font-size:12px;letter-spacing:0.04em;
        padding:11px 18px;border-radius:8px;text-decoration:none;cursor:pointer;
        display:inline-flex;align-items:center;gap:10px;border:1px solid transparent;
        transition:transform .15s ease,background .2s,border-color .2s;
      }
      .eg-btn.primary{background:var(--ink);color:#0a0a0a;font-weight:500}
      .eg-btn.primary:hover{transform:translateY(-1px);background:#fff}
      .eg-btn.ghost{color:var(--ink);border-color:var(--line-strong);background:rgba(20,20,22,0.55)}
      .eg-btn.ghost:hover{border-color:rgba(255,255,255,0.28);background:rgba(28,28,32,0.65)}

      .eg-card{
        background:rgba(13,13,15,0.7);border:1px solid var(--line-strong);
        border-radius:14px;backdrop-filter:blur(8px);
      }
      .eg-bubble-user{
        background:linear-gradient(135deg,#1f3a66,#1a2f52);
        border:1px solid rgba(91,155,255,0.25);
      }
      .eg-bubble-ai{
        background:rgba(20,20,23,0.85);border:1px solid var(--line-strong);
      }
      .eg-input{
        flex:1;background:rgba(14,14,16,0.8);border:1px solid var(--line-strong);
        border-radius:10px;padding:13px 16px;color:var(--ink);font-family:var(--sans);
        font-size:14px;outline:none;transition:border-color .2s;
      }
      .eg-input:focus{border-color:rgba(91,155,255,0.5)}
      .eg-input::placeholder{color:var(--ink-faint)}
      .eg-send{
        font-family:var(--mono);font-size:12px;letter-spacing:0.04em;font-weight:500;
        padding:0 22px;border-radius:10px;border:1px solid transparent;
        background:var(--ink);color:#0a0a0a;cursor:pointer;transition:background .2s,transform .15s;
      }
      .eg-send:hover:not(:disabled){background:#fff;transform:translateY(-1px)}
      .eg-send:disabled{background:#2a2a30;color:var(--ink-faint);cursor:not-allowed}

      .eg-fb{
        font-family:var(--mono);font-size:11px;padding:3px 9px;border-radius:6px;
        cursor:pointer;border:1px solid var(--line-strong);background:transparent;
        transition:background .15s,border-color .15s;
      }
      .eg-fb.ok{color:var(--concept)}
      .eg-fb.ok:hover{background:rgba(78,201,163,0.12);border-color:rgba(78,201,163,0.4)}
      .eg-fb.no{color:var(--contradiction)}
      .eg-fb.no:hover{background:rgba(255,93,108,0.12);border-color:rgba(255,93,108,0.4)}

      .eg-sw{width:8px;height:8px;border-radius:50%;display:inline-block;box-shadow:0 0 8px currentColor}

      @keyframes egfade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      .eg-fade{animation:egfade .35s ease both}
    `}</style>
  )
}

/* ──────────────────────────────────────────────────────────────
   Hero graph — real Neo4j data rendered on a glowing canvas.
   Mouse attracts/repels, click pulses through neighbors.
   ────────────────────────────────────────────────────────────── */
function HeroGraph({ refreshTrigger }) {
  const canvasRef = useRef(null)
  const stateRef = useRef({ nodes: [], edges: [], adj: new Map() })
  const mouseRef = useRef({ x: -9999, y: -9999, active: false })
  const [counts, setCounts] = useState({ nodes: 0, edges: 0 })

  // pull real graph, seed positions, build adjacency
  const loadGraph = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/memory/graph?user_id=default`)
      const W = window.innerWidth, H = 520
      const idMap = new Map()
      const nodes = res.data.nodes.map((n, i) => {
        const node = {
          id: n.id, idx: i,
          type: n.type,
          label: (n.label || n.type || '').toString().slice(0, 42),
          color: TYPE_COLOR[n.type] || FALLBACK,
          x: W * 0.5 + (Math.random() - 0.5) * W * 0.6,
          y: H * 0.5 + (Math.random() - 0.5) * H * 0.7,
          vx: 0, vy: 0,
          baseR: 3 + (n.type === 'Contradiction' ? 1.4 : 0) + Math.random() * 1.6,
          pulse: 0, wakePhase: Math.random() * Math.PI * 2,
        }
        idMap.set(n.id, i)
        return node
      })
      const edges = res.data.edges
        .filter(e => idMap.has(e.source) && idMap.has(e.target))
        .map(e => ({ a: idMap.get(e.source), b: idMap.get(e.target), pulse: 0 }))
      const adj = new Map()
      nodes.forEach(n => adj.set(n.idx, []))
      edges.forEach(e => { adj.get(e.a).push({ nbr: e.b, edge: e }); adj.get(e.b).push({ nbr: e.a, edge: e }) })
      stateRef.current = { nodes, edges, adj }
      setCounts({ nodes: nodes.length, edges: edges.length })
    } catch (err) {
      console.error('Failed to load graph:', err)
    }
  }, [])

  useEffect(() => { loadGraph() }, [loadGraph, refreshTrigger])

  // animation + interaction loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const DPR = Math.min(window.devicePixelRatio || 1, 2)
    let W = 0, H = 0, raf = 0

    const resize = () => {
      W = canvas.parentElement.clientWidth
      H = 520
      canvas.width = W * DPR; canvas.height = H * DPR
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const rectMouse = (e) => {
      const r = canvas.getBoundingClientRect()
      mouseRef.current.x = e.clientX - r.left
      mouseRef.current.y = e.clientY - r.top
      mouseRef.current.active = true
    }
    const leave = () => { mouseRef.current.active = false; mouseRef.current.x = -9999 }
    canvas.addEventListener('mousemove', rectMouse)
    canvas.addEventListener('mouseleave', leave)

    const click = (e) => {
      const r = canvas.getBoundingClientRect()
      const mx = e.clientX - r.left, my = e.clientY - r.top
      const { nodes, adj } = stateRef.current
      let best = null, bd = Infinity
      for (const n of nodes) {
        const dx = n.x - mx, dy = n.y - my, d = dx * dx + dy * dy
        if (d < bd) { bd = d; best = n }
      }
      if (!best || bd > 90 * 90) return
      const visited = new Set([best.idx]); best.pulse = 1
      const queue = [{ i: best.idx, d: 0 }]
      while (queue.length) {
        const { i, d } = queue.shift()
        if (d > 4) continue
        for (const { nbr, edge } of (adj.get(i) || [])) {
          if (visited.has(nbr)) continue
          visited.add(nbr)
          const nd = nodes[nbr]
          setTimeout(() => { nd.pulse = 1; edge.pulse = 1 }, (d + 1) * 95)
          queue.push({ i: nbr, d: d + 1 })
        }
      }
    }
    canvas.addEventListener('click', click)

    const hexA = (hex, a) => {
      const h = hex.replace('#', '')
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
      return `rgba(${r},${g},${b},${a})`
    }

    let last = performance.now()
    let lastAuto = 0
    const frame = (t) => {
      const dt = Math.min(40, t - last); last = t
      const { nodes, edges, adj } = stateRef.current
      const m = mouseRef.current
      const cx = W / 2, cy = H / 2

      // physics
      for (const n of nodes) {
        n.vx += (cx - n.x) * 0.0009
        n.vy += (cy - n.y) * 0.0009
        n.wakePhase += dt * 0.001
        n.vx += Math.cos(n.wakePhase) * 0.006
        n.vy += Math.sin(n.wakePhase * 0.8 + 1.3) * 0.006
      }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j]
          const dx = a.x - b.x, dy = a.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 < 70 * 70 && d2 > 0.01) {
            const d = Math.sqrt(d2), f = 0.55 * (1 - d / 70) / d
            a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f
          }
        }
      }
      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b]
        const dx = b.x - a.x, dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 0.001
        const f = (d - 110) * 0.0025
        a.vx += (dx / d) * f; a.vy += (dy / d) * f
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
      }
      if (m.active) {
        for (const n of nodes) {
          const dx = m.x - n.x, dy = m.y - n.y, d2 = dx * dx + dy * dy
          if (d2 < 220 * 220) {
            const d = Math.sqrt(d2) || 0.001
            if (d < 50) { const f = -0.6 * (1 - d / 50) / d; n.vx += dx * f; n.vy += dy * f }
            else { const f = 0.018 * (1 - d / 220) / d; n.vx += dx * f; n.vy += dy * f }
          }
        }
      }
      for (const n of nodes) {
        n.vx *= 0.86; n.vy *= 0.86
        const sp = Math.hypot(n.vx, n.vy)
        if (sp > 2.5) { n.vx = n.vx / sp * 2.5; n.vy = n.vy / sp * 2.5 }
        n.x += n.vx; n.y += n.vy
        const pad = 30
        if (n.x < pad) { n.x = pad; n.vx *= -0.5 }
        else if (n.x > W - pad) { n.x = W - pad; n.vx *= -0.5 }
        if (n.y < pad) { n.y = pad; n.vy *= -0.5 }
        else if (n.y > H - pad) { n.y = H - pad; n.vy *= -0.5 }
        n.pulse *= 0.95
      }
      for (const e of edges) e.pulse *= 0.94

      // ambient thinking pulse
      if (t - lastAuto > 2400 + Math.random() * 1800 && nodes.length) {
        lastAuto = t
        const seed = nodes[Math.floor(Math.random() * nodes.length)]
        seed.pulse = Math.max(seed.pulse, 0.8)
        const nb = (adj.get(seed.idx) || []).slice(0, 3)
        nb.forEach(({ nbr, edge }, i) => setTimeout(() => { nodes[nbr].pulse = 0.85; edge.pulse = 1 }, 110 + i * 70))
      }

      // draw
      ctx.clearRect(0, 0, W, H)
      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b]
        const d = Math.hypot(b.x - a.x, b.y - a.y)
        const lenA = Math.max(0, 1 - (d - 100) / 280)
        const baseA = Math.min(0.08 + 0.16 * lenA + 0.5 * e.pulse, 0.7)
        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
        grad.addColorStop(0, hexA(a.color, baseA))
        grad.addColorStop(1, hexA(b.color, baseA))
        ctx.strokeStyle = grad
        ctx.lineWidth = 0.6 + 1.6 * e.pulse
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      }
      for (const n of nodes) {
        const breathe = 0.85 + 0.15 * Math.sin(n.wakePhase * 1.4)
        const r = n.baseR * (1 + 0.5 * n.pulse) * breathe
        const glowR = r * 6
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, glowR)
        g.addColorStop(0, hexA(n.color, 0.35 * (0.55 + n.pulse * 0.9)))
        g.addColorStop(0.4, hexA(n.color, 0.08))
        g.addColorStop(1, hexA(n.color, 0))
        ctx.fillStyle = g
        ctx.beginPath(); ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = hexA(n.color, 0.95)
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(0.6, r * 0.35), 0, Math.PI * 2); ctx.fill()
        if (n.pulse > 0.05) {
          ctx.strokeStyle = hexA(n.color, 0.6 * n.pulse)
          ctx.lineWidth = 1
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 5 + 12 * n.pulse, 0, Math.PI * 2); ctx.stroke()
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('mousemove', rectMouse)
      canvas.removeEventListener('mouseleave', leave)
      canvas.removeEventListener('click', click)
    }
  }, [])

  return (
    <section style={{ position: 'relative', height: 520, overflow: 'hidden', borderBottom: '1px solid var(--line-strong)' }}>
      <div className="eg-grid" />
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, display: 'block' }} />

      {/* chrome */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex',
        justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px', zIndex: 5, pointerEvents: 'none' }}>
        <div className="eg-mono" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--ink-dim)' }}>
          <span style={{ width: 13, height: 13, borderRadius: 3,
            background: 'radial-gradient(circle at 30% 30%, #ededed 0 22%, transparent 23%), linear-gradient(135deg,#1a1a1d,#2a2a30)',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 0 18px rgba(91,155,255,0.18)' }} />
          <span style={{ color: 'var(--ink)', fontWeight: 500, letterSpacing: '0.04em' }}>engram</span>
          <span style={{ color: 'var(--ink-faint)' }}>/ memory os</span>
        </div>
        <span className="eg-pill" style={{ pointerEvents: 'auto' }}><span className="dot" /> live · neo4j</span>
      </div>

      {/* centerpiece */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center', zIndex: 4, pointerEvents: 'none', padding: '0 24px' }}>
        <span className="eg-eyebrow" style={{ pointerEvents: 'auto' }}>
          <span className="seq">001</span><span className="sep">/</span><span>memory operating system</span>
        </span>
        <h1 className="eg-title">Engram<span className="blink" /></h1>
        <p className="eg-tagline">
          A multi-agent <em>memory operating system</em>. Specialized agents read, write,
          and reconcile memories across a live knowledge graph — talk to it below.
        </p>
      </div>

      {/* legend + stats */}
      <div className="eg-mono" style={{ position: 'absolute', left: 28, bottom: 22, zIndex: 5,
        display: 'flex', flexDirection: 'column', gap: 7, fontSize: 11, color: 'var(--ink-dim)' }}>
        <span style={{ color: 'var(--ink-faint)', letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 2 }}>Node types</span>
        {Object.entries(TYPE_COLOR).map(([t, c]) => (
          <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span className="eg-sw" style={{ color: c, background: c }} />{t}
          </span>
        ))}
      </div>
      <div className="eg-mono" style={{ position: 'absolute', right: 28, bottom: 22, zIndex: 5,
        display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, color: 'var(--ink-dim)',
        textAlign: 'right', alignItems: 'flex-end' }}>
        <span><span style={{ color: 'var(--ink-faint)' }}>nodes </span><span style={{ color: 'var(--ink)' }}>{counts.nodes}</span></span>
        <span><span style={{ color: 'var(--ink-faint)' }}>edges </span><span style={{ color: 'var(--ink)' }}>{counts.edges}</span></span>
        <span style={{ color: 'var(--ink-faint)' }}>move · click to explore</span>
      </div>
    </section>
  )
}

/* ──────────────────────────────────────────────────────────────
   Main app — hero on top, real chat below. All logic preserved.
   ────────────────────────────────────────────────────────────── */
function App() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [graphRefresh, setGraphRefresh] = useState(0)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, loading])

  const sendMessage = async () => {
    if (!input.trim() || loading) return
    const userMessage = input
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setLoading(true)
    try {
      const res = await axios.post(`${API_URL}/chat`, { message: userMessage, user_id: 'default' })
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: res.data.response,
        memories: res.data.memories_used,
        contradictions: res.data.contradictions,
        grounding: res.data.grounding,
      }])
      setGraphRefresh(prev => prev + 1)
    } catch (err) {
      console.error(err)
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error connecting to backend.' }])
    } finally {
      setLoading(false)
    }
  }

  const sendFeedback = async (nodeId, feedbackType) => {
    try {
      await axios.post(`${API_URL}/memory/feedback`, { node_id: nodeId, feedback: feedbackType })
      setGraphRefresh(prev => prev + 1)
    } catch (err) {
      console.error('Feedback error:', err)
    }
  }

  const groundingColor = (s) => s >= 0.8 ? 'var(--concept)' : s >= 0.5 ? '#f5c84e' : 'var(--contradiction)'

  return (
    <>
      <StyleTokens />
      <div style={{ minHeight: '100vh' }}>
        <HeroGraph refreshTrigger={graphRefresh} />

        {/* chat section */}
        <div style={{ maxWidth: 920, margin: '0 auto', padding: '40px 24px 64px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--ink)' }}>
                Talk to Engram
              </h2>
              <p className="eg-mono" style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ink-dim)' }}>
                every turn is stored, grounded, and reconciled in the graph above
              </p>
            </div>
            <span className="eg-pill"><span className="dot" /> session active</span>
          </div>

          <div className="eg-card" style={{ padding: 20 }}>
            <div ref={scrollRef} style={{ height: 460, overflowY: 'auto', paddingRight: 8, marginBottom: 16 }}>
              {messages.length === 0 && (
                <div className="eg-mono" style={{ textAlign: 'center', padding: '120px 20px', color: 'var(--ink-faint)', fontSize: 13 }}>
                  Start a conversation. Engram will remember.
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className="eg-fade" style={{ display: 'flex', marginBottom: 14,
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  <div className={msg.role === 'user' ? 'eg-bubble-user' : 'eg-bubble-ai'}
                    style={{ maxWidth: '86%', borderRadius: 12, padding: '13px 16px', fontSize: 14, lineHeight: 1.5 }}>
                    <div style={{ whiteSpace: 'pre-wrap', color: 'var(--ink)' }}>{msg.content}</div>

                    {msg.grounding && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line-strong)', fontSize: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span className="eg-mono" style={{ color: 'var(--ink-dim)', textTransform: 'uppercase', letterSpacing: '0.12em', fontSize: 10 }}>
                            Grounding
                          </span>
                          <span className="eg-mono" style={{ color: groundingColor(msg.grounding.grounding_score), fontWeight: 500 }}>
                            {(msg.grounding.grounding_score * 100).toFixed(0)}%
                          </span>
                        </div>
                        {msg.grounding.citations?.length > 0 && (
                          <div style={{ marginBottom: 8 }}>
                            <div style={{ color: 'var(--ink-dim)', marginBottom: 4 }}>✓ Verified</div>
                            {msg.grounding.citations.map((c, j) => (
                              <div key={j} style={{ color: 'var(--ink-dim)', marginLeft: 8, marginBottom: 2 }}>
                                {c.claim.substring(0, 80)}…
                                <span style={{ color: 'var(--concept)', marginLeft: 6 }} className="eg-mono">
                                  {(c.trust_score * 100).toFixed(0)}%
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {msg.grounding.ungrounded_claims?.length > 0 && (
                          <div>
                            <div style={{ color: '#f5c84e', marginBottom: 4 }}>⚠ Unverified</div>
                            {msg.grounding.ungrounded_claims.map((c, j) => (
                              <div key={j} style={{ color: 'var(--ink-faint)', marginLeft: 8 }}>{c.substring(0, 80)}…</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {msg.memories?.length > 0 && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line-strong)', fontSize: 12 }}>
                        <div className="eg-mono" style={{ color: 'var(--ink-dim)', textTransform: 'uppercase', letterSpacing: '0.12em', fontSize: 10, marginBottom: 6 }}>
                          Memories used
                        </div>
                        {msg.memories.map((m, j) => (
                          <div key={j} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0', gap: 10 }}>
                            <span style={{ color: 'var(--ink-dim)' }}>
                              <span className="eg-sw" style={{ color: TYPE_COLOR[m.type] || FALLBACK, background: TYPE_COLOR[m.type] || FALLBACK, marginRight: 7 }} />
                              {m.text}
                              <span className="eg-mono" style={{ color: 'var(--ink-faint)', marginLeft: 6 }}>
                                {(m.similarity * 100).toFixed(0)}%
                              </span>
                            </span>
                            <span style={{ display: 'flex', gap: 6 }}>
                              <button className="eg-fb ok" title="Mark correct" onClick={() => sendFeedback(m.id, 'correct')}>✓</button>
                              <button className="eg-fb no" title="Mark incorrect" onClick={() => sendFeedback(m.id, 'incorrect')}>✗</button>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {msg.contradictions?.length > 0 && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,93,108,0.3)', fontSize: 12 }}>
                        <div style={{ color: 'var(--contradiction)', marginBottom: 4 }}>⚠ Contradictions detected</div>
                        {msg.contradictions.map((c, j) => (
                          <div key={j} style={{ color: 'var(--ink-dim)' }}>
                            {c.existing_fact} → superseded by → {c.new_fact}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {loading && (
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <div className="eg-bubble-ai eg-mono" style={{ borderRadius: 12, padding: '13px 16px', color: 'var(--ink-dim)', fontSize: 13 }}>
                    thinking<span style={{ animation: 'egblink 1.2s infinite' }}>…</span>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <input
                className="eg-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Tell Engram something…"
                disabled={loading}
              />
              <button className="eg-send" onClick={sendMessage} disabled={loading}>SEND</button>
            </div>
          </div>

          <p className="eg-mono" style={{ textAlign: 'center', marginTop: 28, fontSize: 11, color: 'var(--ink-faint)' }}>
            Engram · multi-agent memory operating system · Ritish Nandikonda · 2026
          </p>
        </div>
      </div>
    </>
  )
}

export default App





