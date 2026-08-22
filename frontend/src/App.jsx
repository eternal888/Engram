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

/* Plain words throughout. The database calls these episodes, concepts and
   entities; a visitor calls them things they said, facts, and people. The
   schema names stay in the code and in the docs — not on screen. */
const NAV = [
  { id: 'chat',      label: 'Chat' },
  { id: 'documents', label: 'Documents' },
  { id: 'sessions',  label: 'History' },
  { id: 'trace',     label: 'Behind the answer' },
]

// what each node type is called where a person can read it
const TYPE_NAME = {
  Episode:       'Things you said',
  Concept:       'Facts',
  Entity:        'People & places',
  Source:        'From documents',
  Contradiction: 'Conflicts',
}

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
/* The transcript survives a refresh but not the tab closing. The graph is the
   real persistence layer — this is only so a reload does not look like the
   product lost your conversation. Scoped per account so switching users cannot
   surface someone else's turns. */
const TRANSCRIPT_KEY = (email) => `engram_transcript:${email || 'anon'}`

const loadTranscript = (email) => {
  try {
    const raw = sessionStorage.getItem(TRANSCRIPT_KEY(email))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    // a reply cut off mid-stream would restore with its caret still blinking
    return Array.isArray(parsed)
      ? parsed.map(m => ({ ...m, streaming: false, stage: null }))
      : []
  } catch {
    return []
  }
}

const saveTranscript = (email, messages) => {
  try {
    const done = messages.filter(m => !m.streaming)
    if (!done.length) sessionStorage.removeItem(TRANSCRIPT_KEY(email))
    else sessionStorage.setItem(TRANSCRIPT_KEY(email), JSON.stringify(done.slice(-40)))
  } catch {
    // a full quota is not worth breaking the interface over
  }
}

const clockTime = () =>
  new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/* ──────────────────────────────────────────────────────────────
   Wordmark. Letters break out of a tilted block — reversed inside
   it, dark outside. One instance per mount needs its own clip and
   mask ids, or the second render inherits the first one's geometry.
   ────────────────────────────────────────────────────────────── */
const MARK_LETTERS = (
  <>
    <g transform="rotate(-1.5 33 45)">
      <polygon points="10,12 55,8 56,20 21,22 22,38 47,36 48,47 22,49 23,68 57,70 56,81 9,78" />
    </g>
    <g transform="rotate(1.8 85 45)">
      <polygon points="60,84 71,4 82,4 102,57 98,7 109,7 106,82 94,82 72,24 71,83" />
    </g>
    <g transform="rotate(-1 121 50)">
      <polygon points="122,16 142,28 135,37 122,30 108,37 107,63 120,74 135,67 135,57 125,58 124,48 146,47 146,72 121,85 96,68 96,31" />
    </g>
    <g transform="rotate(2 166 45)">
      <polygon points="146,6 182,10 185,36 164,40 188,84 175,85 154,42 157,82 145,80" />
      <polygon points="157,20 174,22 174,30 157,32" />
    </g>
    <g transform="rotate(-2 211 45)">
      <polygon points="186,80 208,2 220,3 237,79 225,79 214,22 199,81" />
      <polygon points="195,50 224,48 224,58 195,59" />
    </g>
    <g transform="rotate(1.2 250 45)">
      <polygon points="228,84 232,6 243,6 251,47 261,7 271,7 269,86 258,85 260,32 253,67 246,67 239,31 239,84" />
    </g>
  </>
)

let _markSeq = 0

function Wordmark({ width = 148, ink = '#191715', face = '#fbf5e9', shadow = '#4a4132', depth = 10 }) {
  const id = useMemo(() => `mk${++_markSeq}`, [])
  const block = { x: 18, y: 16, width: 236, height: 58, transform: 'rotate(-3 136 45)' }

  return (
    <svg className="eg-mark" viewBox="2 -6 286 116" width={width} role="img" aria-label="engram">
      <defs>
        <clipPath id={`in-${id}`}><rect {...block} /></clipPath>
        <mask id={`out-${id}`}>
          <rect x="-80" y="-80" width="470" height="290" fill="#fff" />
          <rect {...block} fill="#000" />
        </mask>
      </defs>

      {/* offset shadow, cast by the whole silhouette rather than the block alone */}
      <g transform={`translate(${depth},${depth})`}>
        <rect {...block} fill={shadow} />
        <g fill={shadow} mask={`url(#out-${id})`}>{MARK_LETTERS}</g>
      </g>

      <rect {...block} fill={ink} />
      <g fill={ink} mask={`url(#out-${id})`}>{MARK_LETTERS}</g>
      <g fill={face} clipPath={`url(#in-${id})`}>{MARK_LETTERS}</g>
    </svg>
  )
}

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
      /* the kicker under the wordmark sits back so the mark leads */
      .eg-kicker{
        font-family:var(--sans);font-size:10px;font-weight:600;letter-spacing:0.22em;
        text-transform:uppercase;color:var(--n600);
      }

      .eg-mark{display:block;max-width:100%;height:auto}

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

      /* ── shell ── */
      .eg-shell{height:100vh;display:flex;background:var(--bg)}
      .eg-rail{
        width:196px;flex:none;position:relative;z-index:3;background:var(--bg);
        display:flex;flex-direction:column;
        box-shadow:3px 0 6px rgba(25,23,21,0.10),14px 0 30px rgba(25,23,21,0.16);
      }
      .eg-rail-brand{padding:18px 18px 16px;border-bottom:1px solid var(--n300);
        display:grid;gap:9px;justify-items:start}
      .eg-rail-foot{margin-top:auto;border-top:1px solid var(--n300);
        padding:14px 18px;display:grid;gap:9px}
      .eg-main{flex:1;min-width:0;display:flex;flex-direction:column}

      .eg-topbar{
        display:flex;align-items:center;gap:16px;padding:0 24px;height:64px;flex:none;
        background:var(--surface);position:relative;z-index:2;
        box-shadow:0 1px 0 var(--n400),0 3px 8px rgba(25,23,21,0.07);
      }
      .eg-topbar-title{font-weight:800;font-size:17px;letter-spacing:0.01em;text-transform:uppercase}
      .eg-topbar-desc{font-size:13.5px;color:var(--n600)}
      .eg-topbar-right{margin-left:auto;display:flex;align-items:center;gap:12px}
      .eg-live{
        display:flex;align-items:center;gap:8px;border:1px solid var(--n400);padding:6px 11px;
        font-family:var(--sans);font-size:11.5px;font-weight:700;letter-spacing:0.04em;
        text-transform:uppercase;
      }
      .eg-live .dot{width:7px;height:7px;flex:none;background:var(--accent)}

      .eg-panes{
        flex:1;min-height:0;display:grid;
        grid-template-columns:minmax(0,42fr) 1px minmax(0,58fr);
      }
      .eg-divider{background:var(--n400)}
      .eg-screen{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;
        background:var(--surface)}

      .eg-burger{
        display:none;background:none;border:0;padding:8px 4px;cursor:pointer;
        flex-direction:column;gap:4px;margin-left:-4px;
      }
      .eg-burger i{width:20px;height:2.5px;background:var(--ink);display:block}
      .eg-scrim{position:fixed;inset:0;z-index:4;background:rgba(25,23,21,0.45)}
      .eg-tabs{display:none}

      /* ── phone: the rail becomes a drawer, the panes become tabs ── */
      @media (max-width:900px){
        .eg-shell{display:block;height:100dvh;overflow:hidden}
        .eg-main{height:100dvh}
        .eg-burger{display:flex}

        .eg-rail{
          position:fixed;top:0;left:0;bottom:0;z-index:5;width:250px;
          transform:translateX(-100%);transition:transform 180ms ease;
        }
        .eg-rail[data-open="true"]{transform:none}

        .eg-topbar{padding:0 16px;gap:12px;height:60px}
        .eg-topbar-title{font-size:15px}
        .eg-topbar-right{gap:8px}
        .eg-live{padding:4px 8px;font-size:10px}
        .eg-live .dot{width:6px;height:6px}

        .eg-tabs{display:grid;grid-template-columns:1fr 1fr;flex:none;
          border-bottom:1px solid var(--n400);background:var(--bg)}
        .eg-tab{
          padding:12px 0;background:none;border:0;border-bottom:3px solid transparent;
          font-family:var(--sans);font-size:12px;font-weight:800;letter-spacing:0.06em;
          text-transform:uppercase;color:var(--n600);cursor:pointer;
          display:flex;align-items:center;justify-content:center;gap:7px;
        }
        .eg-tab[data-active="true"]{color:var(--ink);border-bottom-color:var(--ink)}
        .eg-tab .n{font-family:var(--mono);font-weight:400;color:var(--n500)}

        /* one pane at a time, filling what is left */
        .eg-panes{grid-template-columns:1fr;min-height:0}

        /* the graph and transcript lose the inset that made room for the sidebar */
        .eg-turn{padding:16px 16px}
        .eg-gtop{padding:14px 16px !important}
        .eg-gcanvas{padding:0 12px !important}
        .eg-glegend{padding:12px 16px 16px !important}
        .eg-glegend > div:last-child{grid-template-columns:1fr 1fr !important;
          grid-auto-flow:row !important;grid-template-rows:none !important}
        .eg-ttop{padding:14px 16px !important}
        .eg-inputrow{padding:12px 16px !important;gap:8px !important}
        .eg-inputrow .eg-send{padding:0 18px}

        /* screens that are not chat */
        .eg-screen > div{padding:20px 16px !important}
      }

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

      /* ── auth screen: demo left, form right ── */
      .eg-auth{min-height:100vh;display:grid;grid-template-columns:minmax(0,58fr) minmax(0,42fr)}
      /* the demo sits on its own tone so it reads as a different layer */
      .eg-auth{--paper:#fbf5e9;--demo-surface:#efe6d2}
      .eg-auth-try{
        position:relative;overflow-y:auto;background:var(--demo-surface);
        display:flex;padding:44px 46px;
      }
      .eg-auth-grid{
        position:absolute;inset:0;pointer-events:none;
        background-image:
          linear-gradient(to right, var(--grid) 1px, transparent 1px),
          linear-gradient(to bottom, var(--grid) 1px, transparent 1px);
        background-size:52px 52px;
        -webkit-mask-image:radial-gradient(ellipse 80% 80% at 45% 45%, #000 50%, transparent 100%);
        mask-image:radial-gradient(ellipse 80% 80% at 45% 45%, #000 50%, transparent 100%);
      }
      .eg-auth-inner{position:relative;z-index:1;width:100%;max-width:560px;margin:auto}
      .eg-auth-head{
        margin:10px 0 14px;font-size:38px;font-weight:800;letter-spacing:-0.035em;line-height:1.05;
      }
      .eg-auth-sub{
        margin:0 0 24px;font-size:15px;line-height:1.6;color:var(--ink-dim);max-width:52ch;
      }

      /* fields are recessed rather than flat */
      .eg-auth .eg-input{box-shadow:inset 0 2px 4px rgba(25,23,21,0.07)}
      .eg-demo-entry{display:flex;gap:0;margin-bottom:10px}
      .eg-demo-entry .eg-input{border-right:0}
      .eg-demo-entry .eg-send{flex:none}

      /* the warning and the try chips share one slot so nothing shifts */
      .eg-demo-hintrow{min-height:26px;margin-bottom:20px;display:flex;align-items:center}
      .eg-demo-samples{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      .eg-demo-samples .eg-ghost{text-transform:none;letter-spacing:0;font-size:12.5px;font-weight:500}
      .eg-demo-warn{
        margin:0;font-size:12.5px;line-height:1.4;color:#7d520a;
        display:flex;align-items:center;gap:8px;
      }
      .eg-demo-warn::before{content:"";width:9px;height:9px;background:#a9740c;flex:none}

      /* the record is a raised sheet: lit top edge, contact edge, cast shadow */
      .eg-demo-store{
        border:1px solid var(--n400);background:var(--paper);
        box-shadow:0 1px 0 #fff inset, 0 2px 0 var(--n300), 0 18px 40px rgba(25,23,21,0.14);
      }
      .eg-demo-head{
        display:flex;align-items:center;justify-content:space-between;
        padding:11px 16px;border-bottom:1px solid var(--n300);
        background:linear-gradient(#fffdf7,#f6eede);
      }
      .eg-demo-viz{position:relative;height:184px;border-bottom:1px solid var(--n300)}
      .eg-demo-canvas{position:absolute;inset:0}
      .eg-demo-canvas canvas{display:block}
      .eg-demo-affordance{
        position:absolute;right:10px;bottom:8px;pointer-events:none;
        font-family:var(--mono);font-size:9.5px;letter-spacing:0.08em;
        text-transform:uppercase;color:var(--n500);
      }
      .eg-demo-empty{
        position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;
        padding:0 20px;border-left:2px solid var(--n400);margin:22px 0 22px 20px;
        pointer-events:none;
      }
      .eg-demo-empty p{margin:0;font-size:14px;line-height:1.5;color:var(--ink-dim)}
      .eg-demo-empty p b{font-size:16px;color:var(--ink);font-weight:800;letter-spacing:-0.01em}
      .eg-demo-empty p+p{margin-top:5px}

      .eg-demo-list{max-height:164px;overflow-y:auto}
      .eg-demo-fact{
        position:relative;display:flex;gap:12px;align-items:flex-start;padding:12px 16px;
        border-bottom:1px solid var(--n200);animation:egstamp 320ms ease both;
        transition:background 140ms ease,box-shadow 140ms ease;
      }
      .eg-demo-fact[data-kind="conflict"]{background:#f6ecd6}
      .eg-demo-fact[data-focus="true"]{background:var(--n200);box-shadow:inset 3px 0 0 var(--ink)}
      .eg-demo-fact[data-kind="conflict"][data-focus="true"]{box-shadow:inset 3px 0 0 var(--accent)}
      .eg-demo-fact[data-flash="true"]{animation:egpulse 900ms ease}
      @keyframes egpulse{
        0%{background:var(--n200)} 40%{background:var(--n200)} 100%{background:transparent}
      }
      .eg-demo-fact .mark{
        width:10px;height:10px;flex:none;margin-top:5px;background:var(--ink);
        transition:transform 140ms ease;
      }
      .eg-demo-fact[data-focus="true"] .mark{transform:scale(1.25)}
      .eg-demo-fact .mark[data-kind="conflict"]{background:var(--accent)}
      .eg-demo-fact .mark[data-kind="disputed"]{background:#a9740c}
      .eg-demo-fact .mark[data-kind="retired"]{background:transparent;border:2px solid var(--n500)}
      .eg-demo-fact p{margin:0;font-size:14px;line-height:1.5}
      .eg-demo-fact p[data-retired="true"]{text-decoration:line-through;color:var(--n500)}
      .eg-demo-fact .note{
        display:block;margin-top:4px;font-size:10.5px;letter-spacing:0.1em;
        text-transform:uppercase;color:var(--n600);
      }
      .eg-demo-fact .note[data-kind="conflict"]{color:var(--accent-700)}
      .eg-demo-fact .note[data-kind="retired"]{color:var(--n500)}
      .eg-demo-resolve{
        flex:none;align-self:center;font-family:var(--sans);font-size:10.5px;font-weight:700;
        letter-spacing:0.06em;text-transform:uppercase;padding:6px 10px;cursor:pointer;
        background:transparent;border:1px solid var(--accent);color:var(--accent-700);
        transition:background 140ms ease,color 140ms ease;
      }
      .eg-demo-resolve:hover{background:var(--accent);color:var(--surface)}
      @keyframes egstamp{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}

      .eg-demo-score{
        padding:12px 16px;border-top:1px solid var(--n300);display:flex;align-items:center;
        gap:11px;flex-wrap:wrap;background:linear-gradient(#f8f1e2,#f3ead6);
      }
      .eg-demo-score .n{
        font-family:var(--mono);font-weight:700;font-size:17px;font-variant-numeric:tabular-nums;
      }
      .eg-demo-score .n[data-weak="true"]{color:var(--accent-700)}
      .eg-demo-bar{display:flex;gap:2px}
      .eg-demo-bar i{width:5px;height:13px;background:var(--n400);display:block}
      .eg-demo-bar i[data-on="true"]{background:var(--ink)}
      .eg-demo-bar i[data-on="true"][data-weak="true"]{background:var(--accent)}
      .eg-demo-score .t{
        font-size:11.5px;line-height:1.4;color:var(--n700);flex:1;min-width:180px;
      }
      .eg-demo-foot{
        margin:16px 0 0;font-size:12.5px;line-height:1.6;color:var(--n700);max-width:52ch;
      }

      .eg-auth-form{
        position:relative;z-index:2;background:var(--bg);display:flex;
        padding:40px 46px;overflow-y:auto;
        box-shadow:-4px 0 8px rgba(25,23,21,0.10), -22px 0 44px rgba(25,23,21,0.13);
      }
      .eg-auth-form > div{margin:auto}
      .eg-auth-formhead{
        margin:0 0 8px;font-size:29px;font-weight:800;letter-spacing:-0.03em;line-height:1.06;
      }
      .eg-auth-formsub{margin:0 0 26px;font-size:14.5px;line-height:1.55;color:var(--n700)}
      /* the primary button physically depresses: its edge collapses as it moves down */
      .eg-auth-go{
        width:100%;padding:15px 18px;margin-top:24px;
        display:flex;align-items:center;justify-content:space-between;
        box-shadow:0 2px 0 #4a4132;transition:transform 90ms ease,box-shadow 90ms ease,
          background 140ms ease,color 140ms ease;
      }
      .eg-auth-go:active:not(:disabled){transform:translateY(2px);box-shadow:0 0 0 #4a4132}

      /* fills what was dead space under the form at tall viewports */
      .eg-auth-rail{
        margin-top:40px;padding-top:20px;border-top:1px solid var(--n300);display:grid;gap:12px;
      }
      .eg-auth-rail > div{
        display:flex;gap:11px;align-items:flex-start;
        font-size:12.5px;line-height:1.5;color:var(--n700);
      }
      .eg-auth-rail .sq{width:9px;height:9px;flex:none;margin-top:4px}
      .eg-auth-rail .sq.ink{background:var(--ink)}
      .eg-auth-rail .sq.red{background:var(--accent)}
      .eg-auth-rail .sq.amber{background:#a9740c}

      .eg-auth-scrollhint{
        display:none;margin:26px 0 0;padding-top:18px;border-top:1px solid var(--n300);
        font-family:var(--sans);font-size:12.5px;font-weight:700;letter-spacing:0.04em;
        text-transform:uppercase;color:var(--n700);
      }
      .eg-auth-scrollhint span{margin-right:8px}
      @media (max-width:960px){ .eg-auth-scrollhint{display:block} }

      /* ── narrow: the two columns stack, form first ── */
      /* A visitor on a phone is the one who most needs the explanation, so the
         demo stays. It runs down the page instead of beside the form. */
      @media (max-width:960px){
        .eg-auth{grid-template-columns:1fr;min-height:auto}
        .eg-auth-form{
          box-shadow:0 4px 8px rgba(25,23,21,0.08), 0 20px 40px rgba(25,23,21,0.10);
          padding:36px 22px 34px;order:1;
        }
        .eg-auth-try{order:2;padding:30px 22px 44px;overflow:visible}
        .eg-auth-inner{max-width:none}
        .eg-auth-head{font-size:29px;margin:8px 0 12px}
        .eg-auth-sub{font-size:14.5px;margin-bottom:20px}

        /* the input and its button stop sharing a row — the button gets a tap target */
        .eg-demo-entry{flex-direction:column;gap:8px}
        .eg-demo-entry .eg-input{border-right:1px solid var(--n400)}
        .eg-demo-entry .eg-send{padding:14px 0;width:100%}

        .eg-demo-hintrow{min-height:0;margin-bottom:16px}
        .eg-demo-samples{gap:6px}
        .eg-demo-samples .eg-ghost{font-size:12px;padding:7px 10px}

        /* a shorter band — at this width the layout holds fewer nodes anyway */
        .eg-demo-viz{height:152px}
        .eg-demo-affordance{font-size:9px;right:8px;bottom:6px}
        .eg-demo-list{max-height:none}          /* the page scrolls, not the list */
        .eg-demo-fact{padding:11px 13px;gap:10px;flex-wrap:wrap}
        .eg-demo-resolve{width:100%;margin-top:8px;padding:9px 0}
        .eg-demo-score{padding:11px 13px;gap:9px}
        .eg-demo-score .t{min-width:0;flex-basis:100%;order:3}
        .eg-demo-head{padding:10px 13px}
        .eg-demo-foot{font-size:12px}

        .eg-auth-rail{margin-top:30px}
      }

      /* narrower still: the form is what a returning user came for */
      @media (max-width:420px){
        .eg-auth-form{padding:30px 16px 28px}
        .eg-auth-try{padding:26px 16px 40px}
        .eg-auth-head{font-size:25px}
        .eg-demo-viz{height:136px}
      }

      .eg-err{
        margin-top:14px;padding:10px 12px;font-family:var(--mono);font-size:12px;
        background:var(--accent-100);border:1px solid var(--accent);color:var(--accent-700);
      }

      .eg-graph-hint{
        position:absolute;right:10px;bottom:8px;pointer-events:none;
        font-family:var(--mono);font-size:9.5px;letter-spacing:0.08em;
        text-transform:uppercase;color:var(--n500);
      }
      .eg-tracebar{height:6px;min-width:2px;transition:width 240ms ease}

      @keyframes egcaret{0%,49%{opacity:1}50%,100%{opacity:0}}
      .eg-caret{
        display:inline-block;width:7px;height:15px;background:var(--ink);
        margin-left:3px;vertical-align:text-bottom;animation:egcaret 1s steps(1) infinite;
      }
      @media (prefers-reduced-motion:reduce){
        .eg-caret{animation:none}
        *{transition-duration:1ms !important;animation-duration:1ms !important}
      }
    `}</style>
  )
}

/* ──────────────────────────────────────────────────────────────
   Auth screen.

   The left side is a working demo: type a fact, watch it enter a
   store, then type something that conflicts with it. Everything
   lives in component state and dies on refresh — which is the
   point the copy makes about signing in. Nothing typed here is
   ever sent anywhere.

   Topic matching is deliberately crude. Two facts in the same
   bucket that differ are treated as a conflict. Enough to show
   the behaviour without pretending to be the real agent.
   ────────────────────────────────────────────────────────────── */
const DEMO_STOP = new Set(['i','a','an','the','is','am','in','on','to','of','my',
  'me','it','and','was','are','now','that','this'])

const demoWords = (s) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w && !DEMO_STOP.has(w))

const DEMO_TOPICS = [
  ['deadline','due','ship','launch','march','june','july','august','date','deadlines'],
  ['boca','raton','london','berlin','lisbon','city','based','moved','live','lives'],
  ['work','job','company','team','role','engineer','founder','logistics'],
  ['python','rust','typescript','go','postgres','stack','prefer','prefers'],
]

const topicOf = (text) => {
  const ws = demoWords(text)
  return DEMO_TOPICS.findIndex(g => g.some(w => ws.includes(w)))
}

/* A node label is a name, not a sentence. Drop filler, keep up to three
   content words, truncate only as a fallback. */
const LABEL_DROP = new Set([...DEMO_STOP,
  'actually','just','really','very','quite','currently','live','lives','living',
  'at','for','with','be','been','being','has','have','had','will','would',
  'about','from','but','so','then','also','still','maybe','think','guess'])

const shortLabel = (text) => {
  const kept = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/)
    .filter(w => w && !LABEL_DROP.has(w))
  const name = (kept.length ? kept.slice(0, 3) : text.split(/\s+/)).join(' ').toUpperCase()
  return name.length > 20 ? name.slice(0, 19) + '…' : name
}

const DEMO_SAMPLES = [
  'I live in Boca Raton',
  'The deadline is in March',
  'Actually the deadline moved to June',
]

/* Below this width the console cannot show two panes side by side, so the
   layout changes shape rather than shrinking. */
const NARROW = '(max-width: 900px)'

function useNarrowAuth() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 960px)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 960px)')
    const onChange = (e) => setNarrow(e.matches)
    setNarrow(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}

function useNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW).matches
  )
  useEffect(() => {
    const mq = window.matchMedia(NARROW)
    const onChange = (e) => setNarrow(e.matches)
    setNarrow(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/* ──────────────────────────────────────────────────────────────
   The canvas. Owns physics and drawing only — every piece of
   truth (which facts exist, what is focused) comes in as a prop,
   so the graph and the record can never disagree.
   ────────────────────────────────────────────────────────────── */
function DemoGraph({ facts, edges, focus, onFocus }) {
  const hostRef = useRef(null)
  const canvasRef = useRef(null)
  const simRef = useRef({ nodes: [], edges: [] })
  const viewRef = useRef({ focus: null, hover: null, drag: null })
  const loopRef = useRef({ raf: 0, energy: 1 })
  const focusRef = useRef(onFocus)

  focusRef.current = onFocus
  viewRef.current.focus = focus

  // keep the simulation in step with the facts
  useEffect(() => {
    const host = hostRef.current
    const W = host ? host.clientWidth : 420
    const H = host ? host.clientHeight : 184
    const sim = simRef.current
    const reduced = prefersReducedMotion()

    while (sim.nodes.length < facts.length) {
      const i = sim.nodes.length
      const angle = i * 2.39996
      const radius = 22 + Math.sqrt(i + 1) * 20
      sim.nodes.push({
        id: facts[i].id, label: shortLabel(facts[i].text),
        deg: 0, vx: 0, vy: 0, born: reduced ? 0 : performance.now(),
        x: W / 2 + Math.cos(angle) * radius,
        y: H / 2 + Math.sin(angle) * radius * 0.8,
      })
    }
    if (sim.nodes.length > facts.length) sim.nodes.length = facts.length

    sim.nodes.forEach((n, i) => {
      const f = facts[i]
      if (!f) return
      n.conflict = !!f.conflict
      n.retired = !!f.retired
      n.disputed = !!f.superseded && !f.retired
    })

    sim.edges = edges.map(e => ({ ...e }))
    sim.nodes.forEach(n => { n.deg = 0 })
    for (const e of sim.edges) {
      if (sim.nodes[e.a]) sim.nodes[e.a].deg++
      if (sim.nodes[e.b]) sim.nodes[e.b].deg++
    }
    loopRef.current.energy = 1
  }, [facts, edges])

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return
    const ctx = canvas.getContext('2d')
    const reduced = prefersReducedMotion()
    let W = 0, H = 0

    const radiusOf = (n) => (9 + n.deg * 1.8) * (n.retired ? 0.72 : 1)

    const resize = () => {
      W = host.clientWidth; H = host.clientHeight
      const d = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(W * d); canvas.height = Math.round(H * d)
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
      ctx.setTransform(d, 0, 0, d, 0, 0)
      loopRef.current.energy = 1
    }

    const step = () => {
      const ns = simRef.current.nodes
      const n = ns.length
      if (!n) return 0
      const rest = Math.max(52, Math.min(96, Math.sqrt((W * H) / n) * 0.66))
      const dragId = viewRef.current.drag

      for (let i = 0; i < n; i++) {
        const a = ns[i]
        for (let j = i + 1; j < n; j++) {
          const b = ns[j]
          const dx = b.x - a.x, dy = b.y - a.y
          const d2 = dx * dx + dy * dy || 0.01
          const d = Math.sqrt(d2)
          const f = (rest * rest * 1.4) / d2 / d
          a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f
          if (d < 40) {
            const p = ((40 - d) / d) * 0.5
            a.vx -= dx * p; a.vy -= dy * p; b.vx += dx * p; b.vy += dy * p
          }
        }
      }
      for (const e of simRef.current.edges) {
        const a = ns[e.a], b = ns[e.b]
        if (!a || !b) continue
        const dx = b.x - a.x, dy = b.y - a.y
        const d = Math.hypot(dx, dy) || 0.01
        const f = (d - rest) * 0.014
        a.vx += (dx / d) * f; a.vy += (dy / d) * f
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
      }

      let energy = 0
      for (const p of ns) {
        if (p.id === dragId) { p.vx = 0; p.vy = 0; continue }   // held still by the pointer
        p.vx += (W / 2 - p.x) * 0.0026
        p.vy += (H / 2 - p.y) * 0.0032
        p.vx *= 0.85; p.vy *= 0.85
        p.x += p.vx; p.y += p.vy
        const m = 26
        p.x = Math.max(m, Math.min(W - m, p.x))
        p.y = Math.max(m, Math.min(H - m, p.y))
        energy += Math.abs(p.vx) + Math.abs(p.vy)
      }
      return energy / n
    }

    const draw = () => {
      const { nodes: ns, edges: es } = simRef.current
      const now = performance.now()
      const focusId = viewRef.current.focus
      ctx.clearRect(0, 0, W, H)

      // everything one hop from the focused node stays lit
      let near = null
      if (focusId != null) {
        near = new Set([focusId])
        for (const e of es) {
          const a = ns[e.a], b = ns[e.b]
          if (!a || !b) continue
          if (a.id === focusId) near.add(b.id)
          if (b.id === focusId) near.add(a.id)
        }
      }
      const dim = (id) => (near && !near.has(id) ? 0.22 : 1)

      for (const e of es) {
        const a = ns[e.a], b = ns[e.b]
        if (!a || !b) continue
        const lit = near ? (near.has(a.id) && near.has(b.id)) : false
        ctx.save()
        ctx.globalAlpha = Math.min(dim(a.id), dim(b.id))
        if (e.conflict) {
          ctx.strokeStyle = 'rgba(240,31,10,0.8)'
          ctx.setLineDash([5, 4]); ctx.lineWidth = lit ? 2.2 : 1.6
        } else if (e.resolved) {
          ctx.strokeStyle = 'rgba(240,31,10,0.55)'; ctx.lineWidth = lit ? 2.4 : 1.8
        } else {
          ctx.strokeStyle = 'rgba(92,83,68,0.4)'; ctx.lineWidth = lit ? 2 : 1.2
        }
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
        ctx.restore()
      }

      ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace'
      ctx.textBaseline = 'middle'
      // seed occupancy with the discs so a label can never land on a node
      const taken = ns.map(p => {
        const r = radiusOf(p)
        return { x: p.x - r - 2, y: p.y - r - 2, w: r * 2 + 4, h: r * 2 + 4 }
      })
      const hits = (b) => taken.some(p =>
        b.x < p.x + p.w && b.x + b.w > p.x && b.y < p.y + p.h && b.y + b.h > p.y)

      const order = focusId != null
        ? [...ns].sort((a, b) => (a.id === focusId ? 1 : 0) - (b.id === focusId ? 1 : 0))
        : ns

      for (const p of order) {
        const r = radiusOf(p)
        const age = p.born ? Math.min(1, (now - p.born) / 520) : 1
        const ease = 1 - Math.pow(1 - age, 3)
        const isFocus = p.id === focusId

        ctx.save()
        ctx.globalAlpha = (0.3 + ease * 0.7) * dim(p.id)
        if (age < 1) {
          ctx.strokeStyle = p.conflict ? 'rgba(240,31,10,0.5)' : 'rgba(124,114,89,0.45)'
          ctx.lineWidth = 1.4
          ctx.beginPath(); ctx.arc(p.x, p.y, r + (1 - ease) * 24 + 4, 0, 7); ctx.stroke()
        }
        if (p.conflict) {
          ctx.fillStyle = 'rgba(240,31,10,0.16)'
          ctx.beginPath(); ctx.arc(p.x, p.y, r + 7, 0, 7); ctx.fill()
        }

        ctx.beginPath(); ctx.arc(p.x, p.y, r * (0.6 + ease * 0.4), 0, 7)
        if (p.retired) {
          ctx.fillStyle = '#f4ecdc'; ctx.fill()
          ctx.strokeStyle = '#a2957c'; ctx.lineWidth = 1.6; ctx.stroke()
        } else {
          ctx.fillStyle = p.conflict ? '#f01f0a' : p.disputed ? '#a9740c' : '#191715'
          ctx.fill()
        }
        if (isFocus) {
          ctx.strokeStyle = p.conflict ? '#a81400' : '#191715'
          ctx.lineWidth = 1.4
          ctx.beginPath(); ctx.arc(p.x, p.y, r + 6, 0, 7); ctx.stroke()
        }
        ctx.restore()

        const name = p.label
        const tw = ctx.measureText(name).width
        const gap = r + 8
        const spots = [
          [p.x + gap, p.y], [p.x - gap - tw, p.y],
          [p.x - tw / 2, p.y - gap - 5], [p.x - tw / 2, p.y + gap + 5],
        ]
        let placed = false
        for (const [x, y] of spots) {
          if (x < 5 || x + tw > W - 5 || y < 9 || y > H - 9) continue
          const box = { x: x - 3, y: y - 7, w: tw + 6, h: 14 }
          if (hits(box) && !isFocus) continue
          taken.push(box)
          ctx.save()
          ctx.globalAlpha = (0.25 + ease * 0.75) * dim(p.id)
          ctx.fillStyle = '#fffdf7'
          ctx.fillRect(box.x, box.y, box.w, box.h)
          ctx.fillStyle = p.retired ? '#a2957c' : p.conflict ? '#a81400' : '#332e26'
          ctx.fillText(name, x, y)
          ctx.restore()
          placed = true
          break
        }
        // whatever is being pointed at is always named
        if (!placed && isFocus) {
          const x = Math.max(5, Math.min(W - tw - 5, p.x + gap))
          ctx.save()
          ctx.fillStyle = '#fffdf7'; ctx.fillRect(x - 3, p.y - 7, tw + 6, 14)
          ctx.fillStyle = p.conflict ? '#a81400' : '#332e26'
          ctx.fillText(name, x, p.y)
          ctx.restore()
        }
      }
    }

    const frame = () => {
      loopRef.current.raf = requestAnimationFrame(frame)
      if (loopRef.current.energy > 0.05) loopRef.current.energy = step()
      draw()
    }

    const at = (evt) => {
      const r = canvas.getBoundingClientRect()
      return { x: evt.clientX - r.left, y: evt.clientY - r.top }
    }
    const isTouch = (evt) => evt.pointerType === 'touch' || evt.pointerType === 'pen'
    const pick = (evt) => {
      const { x, y } = at(evt)
      for (const p of simRef.current.nodes) {
        const r = radiusOf(p) + 10
        if ((p.x - x) ** 2 + (p.y - y) ** 2 <= r * r) return p
      }
      return null
    }

    const onMove = (e) => {
      const v = viewRef.current
      if (v.drag != null) {
        const { x, y } = at(e)
        const node = simRef.current.nodes.find(n => n.id === v.drag)
        if (node) { node.x = x; node.y = y; node.vx = 0; node.vy = 0 }
        loopRef.current.energy = 1
        return
      }
      const hit = pick(e)
      const id = hit ? hit.id : null
      canvas.style.cursor = hit ? 'grab' : 'default'
      if (id !== v.hover) { v.hover = id; focusRef.current(id) }
    }
    const onLeave = () => {
      const v = viewRef.current
      if (v.drag != null) return
      if (v.hover !== null) { v.hover = null; focusRef.current(null) }
      canvas.style.cursor = 'default'
    }
    const onDown = (e) => {
      const hit = pick(e)
      if (!hit) return
      viewRef.current.drag = hit.id
      canvas.style.cursor = 'grabbing'
      focusRef.current(hit.id)
      e.preventDefault()
    }
    // released on window, so letting go outside the canvas still lands
    const onUp = () => {
      if (viewRef.current.drag == null) return
      viewRef.current.drag = null
      canvas.style.cursor = 'default'
      loopRef.current.energy = 1
    }

    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    loopRef.current.raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(loopRef.current.raf)
      ro.disconnect()
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div ref={hostRef} className="eg-demo-canvas">
      <canvas ref={canvasRef} />
    </div>
  )
}

function AuthScreen({ onAuthed }) {
  const narrowAuth = useNarrowAuth()
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // ── the demo store ──
  // Facts are kept oldest-first so a fact's index is also its node index.
  const [draft, setDraft] = useState('')
  const [facts, setFacts] = useState([])
  const [edges, setEdges] = useState([])
  const [focus, setFocus] = useState(null)
  const [flash, setFlash] = useState(null)
  const [shown, setShown] = useState(null)      // the tweened score
  const nextId = useRef(1)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const rowRefs = useRef(new Map())

  const live = facts.filter(f => !f.retired)
  const conflicts = live.filter(f => f.conflict).length
  const target = live.length === 0 ? null : Math.max(48, 100 - conflicts * 39)

  // ── the draft is checked against the store on every keystroke ──
  const candidate = (() => {
    const text = draft.trim()
    if (!text) return null
    const t = topicOf(text)
    if (t < 0) return null
    return facts.find(f => !f.retired && !f.conflict && f.topic === t &&
      f.text.trim().toLowerCase() !== text.toLowerCase()) || null
  })()

  const commit = (raw) => {
    const text = (raw || '').trim()
    if (!text) return

    const already = facts.find(f => f.text.toLowerCase() === text.toLowerCase())
    if (already) {
      setDraft(''); setFocus(already.id); setFlash(already.id)
      window.setTimeout(() => setFlash(null), 900)
      inputRef.current?.focus()
      return
    }

    const topic = topicOf(text)
    const next = facts.map(f => ({ ...f }))
    const idx = next.length
    const id = nextId.current++

    // conflict against the most recent unresolved fact on the same topic
    let conflictIdx = -1
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].conflict || next[i].superseded || next[i].retired) continue
      if (topic >= 0 && next[i].topic === topic) { conflictIdx = i; break }
    }

    const fact = { id, text, topic, conflict: conflictIdx >= 0, pairedWith: null,
      superseded: false, retired: false, resolved: false }

    if (conflictIdx >= 0) {
      next[conflictIdx].superseded = true
      // both sides know their partner, so resolving later needs no re-detection
      next[conflictIdx].pairedWith = id
      fact.pairedWith = next[conflictIdx].id
    }
    next.push(fact)

    let link = conflictIdx
    if (link < 0) {
      for (let i = idx - 1; i >= 0; i--) {
        if (topic >= 0 && next[i].topic === topic) { link = i; break }
      }
    }
    if (link < 0 && idx > 0) link = idx - 1

    setFacts(next)
    if (link >= 0) {
      setEdges(es => [...es, { a: link, b: idx, conflict: conflictIdx >= 0, resolved: false }])
    }
    setDraft('')
    inputRef.current?.focus()
  }

  const resolve = (id) => {
    setFacts(fs => fs.map(f => {
      if (f.id === id) return { ...f, conflict: false, resolved: true }
      const winner = fs.find(x => x.id === id)
      if (winner && f.id === winner.pairedWith) {
        return { ...f, retired: true, superseded: false }
      }
      return f
    }))
    setEdges(es => es.map(e => (e.conflict ? { ...e, conflict: false, resolved: true } : e)))
  }

  const forgetAll = () => {
    setFacts([]); setEdges([]); setFocus(null); setDraft('')
    rowRefs.current.clear()
    setShown(null)
    inputRef.current?.focus()
  }

  // ── score tween: step toward the target rather than snapping ──
  useEffect(() => {
    if (target === null) { setShown(null); return }
    if (shown === null) { setShown(target); return }
    if (shown === target) return
    if (prefersReducedMotion()) { setShown(target); return }
    let raf = 0
    const tick = () => {
      setShown(cur => {
        if (cur === null || cur === target) return target
        const delta = target - cur
        const stepBy = Math.ceil(Math.abs(delta) / 6) * Math.sign(delta)
        const nextVal = cur + stepBy
        return (delta > 0 ? nextVal >= target : nextVal <= target) ? target : nextVal
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, shown])

  // ── keep the focused row in view, without scrolling the page ──
  useEffect(() => {
    if (focus == null) return
    const list = listRef.current
    const row = rowRefs.current.get(focus)
    if (!list || !row) return
    const top = row.offsetTop
    const bottom = top + row.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight
    }
  }, [focus])

  const weak = shown !== null && shown < 70
  const filled = shown === null ? 0 : Math.round(shown / 10)

  const scoreNote =
    target === null
      ? 'Nothing to check an answer against yet.'
      : conflicts > 0
        ? `Two of them can't both be true, so an answer drawing on them can't be fully traced.`
        : live.length === 1
          ? 'An answer drawing on this could be traced straight back to it.'
          : 'An answer drawing on these could be traced back to every one of them.'

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

  const noteFor = (f) =>
    f.retired ? 'retired · superseded by a newer fact'
    : f.conflict ? 'conflicts with an earlier fact · both kept'
    : f.resolved ? 'confirmed current · traceable'
    : f.superseded ? 'held, but now disputed'
    : 'stored · traceable'

  const kindFor = (f) =>
    f.retired ? 'retired' : f.conflict ? 'conflict' : f.superseded ? 'disputed' : 'stored'

  return (
    <div className="eg-auth">
      {/* ── left: try it before signing in ── */}
      <section className="eg-auth-try">
        <div className="eg-auth-grid" />
        <div className="eg-auth-inner">
          <span className="eg-kicker">Before you sign in</span>
          <h1 className="eg-auth-head">Tell it something.<br />It won't forget.</h1>
          <p className="eg-auth-sub">
            Engram is a memory layer for AI. Whatever you type becomes a fact it holds
            and links to what it already knows — and every answer it gives later is
            checked against that record, not invented.
          </p>

          <div className="eg-demo-entry">
            <input
              ref={inputRef}
              className="eg-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commit(draft)}
              placeholder="I live in Boca Raton"
              aria-label="Add a fact"
            />
            <button className="eg-send" onClick={() => commit(draft)}>Remember it</button>
          </div>

          {/* the warning and the chips share this slot, so nothing shifts */}
          <div className="eg-demo-hintrow">
            {candidate ? (
              <p className="eg-demo-warn">
                This will conflict with “{candidate.text}” — both get kept.
              </p>
            ) : (
              <div className="eg-demo-samples">
                <span className="eg-kicker">Try</span>
                {DEMO_SAMPLES.map(sample => (
                  <button key={sample} className="eg-ghost" onClick={() => commit(sample)}>
                    {sample}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="eg-demo-store">
            <div className="eg-demo-head">
              <span className="eg-label" style={{ color: 'var(--ink)' }}>What it now holds</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="eg-mono" style={{ fontSize: 11, color: 'var(--n600)' }}>
                  {live.length === 0
                    ? 'empty'
                    : `${live.length} ${live.length === 1 ? 'fact' : 'facts'}`}
                </span>
                {facts.length > 0 && (
                  <button className="eg-link" onClick={forgetAll}>Forget all</button>
                )}
              </span>
            </div>

            <div className="eg-demo-viz">
              <DemoGraph facts={facts} edges={edges} focus={focus} onFocus={setFocus} />
              {facts.length === 0 ? (
                <div className="eg-demo-empty">
                  <p><b>Nothing stored yet.</b></p>
                  <p>Add a fact, then add one that contradicts it.</p>
                </div>
              ) : (
                <span className="eg-demo-affordance">hover to trace · drag to move</span>
              )}
            </div>

            {facts.length > 0 && (
              <div className="eg-demo-list" ref={listRef}>
                {[...facts].reverse().map((f) => (
                  <div
                    key={f.id}
                    ref={(el) => { if (el) rowRefs.current.set(f.id, el)
                                   else rowRefs.current.delete(f.id) }}
                    className="eg-demo-fact"
                    data-kind={kindFor(f)}
                    data-focus={focus === f.id}
                    data-flash={flash === f.id}
                    onMouseEnter={() => setFocus(f.id)}
                    onMouseLeave={() => setFocus(null)}
                  >
                    <span className="mark" data-kind={kindFor(f)} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <p data-retired={f.retired}>{f.text}</p>
                      <span className="note" data-kind={kindFor(f)}>{noteFor(f)}</span>
                    </div>
                    {f.conflict && (
                      <button className="eg-demo-resolve" onClick={() => resolve(f.id)}>
                        This one is current
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="eg-demo-score">
              <span className="n" data-weak={weak}>{shown === null ? '—' : `${shown}%`}</span>
              <span className="eg-demo-bar">
                {Array.from({ length: 10 }, (_, i) => (
                  <i key={i} data-on={i < filled} data-weak={weak} />
                ))}
              </span>
              <span className="t">{scoreNote}</span>
            </div>
          </div>

          <p className="eg-demo-foot">
            This one runs in your browser and forgets on refresh. Log in and the same
            record persists for months, across every session.
          </p>
        </div>
      </section>

      {/* ── right: the form ── */}
      <section className="eg-auth-form">
        <div style={{ width: '100%', maxWidth: 340 }}>
          <div style={{ display: 'grid', gap: 10, justifyItems: 'start', marginBottom: 36 }}>
            <Wordmark width={230} depth={9} />
            <span className="eg-kicker">Memory layer</span>
          </div>

          <h2 className="eg-auth-formhead">
            {mode === 'login' ? 'Open your graph' : 'Start a graph'}
          </h2>
          <p className="eg-auth-formsub">
            {mode === 'login'
              ? 'Everything you told it is still there.'
              : 'Nothing is stored until you say something. Then it stays.'}
          </p>

          <label className="eg-label" style={{ display: 'block', marginBottom: 6 }}>Email</label>
          <input className="eg-input" style={{ width: '100%' }} type="email" value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="you@example.com" disabled={loading} />

          <label className="eg-label" style={{ display: 'block', margin: '16px 0 6px' }}>
            Password
          </label>
          <input className="eg-input" style={{ width: '100%' }} type="password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={mode === 'register' ? 'at least 8 characters' : '••••••••'}
            disabled={loading} />

          {error && <div className="eg-err">{error}</div>}

          <button className="eg-send eg-auth-go" onClick={submit} disabled={loading}>
            <span>{loading ? 'Working' : mode === 'login' ? 'Log in' : 'Create account'}</span>
            <span aria-hidden="true">→</span>
          </button>

          <div className="eg-mono" style={{ marginTop: 20, fontSize: 12, color: 'var(--n600)' }}>
            {mode === 'login' ? 'No account yet?' : 'Already have one?'}
            <button className="eg-link" style={{ marginLeft: 8 }}
              onClick={() => { setError(''); setMode(mode === 'login' ? 'register' : 'login') }}>
              {mode === 'login' ? 'Create one' : 'Log in'}
            </button>
          </div>

          {narrowAuth && (
            <p className="eg-auth-scrollhint">
              <span aria-hidden="true">↓</span> Try it first — no account needed
            </p>
          )}

          <div className="eg-auth-rail">
            <div><span className="sq ink" /><span>Everything you say is kept as a fact you can read back.</span></div>
            <div><span className="sq red" /><span>Contradictions are held, never quietly overwritten.</span></div>
            <div><span className="sq amber" /><span>Every answer shows how much of it came from your own record.</span></div>
          </div>
        </div>
      </section>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
   Memory graph.

   The field is a plane. Physics runs in x and z; y is height above
   it, and height carries meaning — a contradiction floats clear of
   the field rather than sitting in it. A ground shadow and a dashed
   drop line anchor each node, without which height reads as nothing
   more than an arbitrary offset.

   The camera orbits with the pointer and eases toward its target.
   Dragging inverts the projection at the node's own height, so a
   node follows the cursor rather than sliding across the plane.

   The loop parks once kinetic energy settles. Hover and selection
   repaint a single frame without waking the physics.
   ────────────────────────────────────────────────────────────── */
const SLEEP_ENERGY = 0.012
const SLEEP_FRAMES = 24
const LABEL_LIMIT  = 34
const ALWAYS_LABEL = new Set(['Entity', 'Concept', 'Contradiction'])

// height above the plane. Contradictions sit well clear of everything else.
const FLOAT_CONFLICT = -74
const MIN_NODE_PX = 5.5      // no node ever draws smaller than this, however deep
// below this a plain every-pair loop beats the cost of bucketing
const GRID_THRESHOLD = 60
const floatFor = (type, i) => (type === 'Contradiction' ? FLOAT_CONFLICT : -20 - (i % 5) * 6)

function MemoryGraphPanel({ refreshTrigger }) {
  const hostRef = useRef(null)
  const canvasRef = useRef(null)
  const stateRef = useRef({ nodes: [], edges: [], adj: new Map() })
  const viewRef = useRef({ hover: -1, selected: -1, W: 0, H: 0, held: null, k: 1 })
  const camRef = useRef({ yaw: 0, target: 0, pitch: 0.86, focal: 900, back: 620 })
  const projRef = useRef(new Map())
  const loopRef = useRef({ raf: 0, still: 0, running: false })
  const wakeRef = useRef(() => {})
  const [counts, setCounts] = useState({ nodes: 0, edges: 0, byType: {} })
  const [showEpisodes, setShowEpisodes] = useState(true)
  const showEpisodesRef = useRef(true)
  // a coarse pointer has no hover, so the affordance line has to differ
  const coarse = typeof window !== 'undefined' &&
    window.matchMedia && window.matchMedia('(pointer: coarse)').matches

  const loadGraph = useCallback(async () => {
    try {
      const res = await api.get('/memory/graph')
      const k = viewRef.current.k || 1
      const idMap = new Map()
      const byType = {}
      for (const n of res.data.nodes) byType[n.type] = (byType[n.type] || 0) + 1

      const visible = res.data.nodes.filter(
        n => showEpisodesRef.current || n.type !== 'Episode'
      )
      // shrinks as the graph fills, but stops well before it stops being a node
      const scale = Math.max(0.62, Math.min(1, Math.sqrt(22 / Math.max(1, visible.length))))

      const nodes = visible.map((n, i) => {
        idMap.set(n.id, i)
        const strength = typeof n.confidence === 'number' ? n.confidence : 0.6
        const a = i * 2.39996
        const rad = (60 + Math.sqrt(i + 1) * 42) * k
        return {
          id: n.id, idx: i, type: n.type,
          label: nodeLabel(n.label, n.type),
          r: (5 + Math.sqrt(Math.max(0.05, strength)) * 7.5
              + (n.type === 'Contradiction' ? 2 : 0)) * scale,
          x: Math.cos(a) * rad, z: Math.sin(a) * rad,
          h: floatFor(n.type, i), y: 0,
          vx: 0, vz: 0, trail: [], pop: 0,
          // its own phase and rate, so nothing beats in unison
          phase: (i * 1.7) % (Math.PI * 2),
          rate: 0.55 + ((i * 37) % 45) / 100,
          sway: 0.7 + ((i * 23) % 60) / 100,
        }
      })

      // An edge whose source or target is not in idMap is silently unusable.
      // Counting the drops separates two very different explanations for a
      // sparse graph: the backend genuinely returned few edges, or it returned
      // edges pointing at nodes that were filtered out on the way in.
      let dropped = 0
      const edges = []
      for (const e of (res.data.edges || [])) {
        const a = idMap.get(e.source), b = idMap.get(e.target)
        if (a === undefined || b === undefined) { dropped++; continue }
        edges.push({
          a, b, rel: e.relationship,
          conflict: nodes[a].type === 'Contradiction' || nodes[b].type === 'Contradiction',
        })
      }
      const returned = (res.data.edges || []).length
      if (dropped) {
        console.warn(
          `[graph] ${dropped} of ${returned} edges dropped — endpoint not in the node set` +
          (showEpisodesRef.current ? '' : ' (expected: turns are hidden)')
        )
      }
      console.info(
        `[graph] ${res.data.nodes.length} nodes / ${returned} edges from the API · ` +
        `${nodes.length} nodes / ${edges.length} edges drawn`
      )

      const adj = new Map()
      nodes.forEach(n => adj.set(n.idx, []))
      edges.forEach(e => { adj.get(e.a).push(e.b); adj.get(e.b).push(e.a) })

      stateRef.current = { nodes, edges, adj }
      viewRef.current.hover = -1
      viewRef.current.selected = -1
      viewRef.current.held = null
      projRef.current.clear()
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
    const reduced = prefersReducedMotion()

    // ── camera ──
    const project = (x, y, z) => {
      const { W, H } = viewRef.current
      const cam = camRef.current
      const ca = Math.cos(cam.yaw), sa = Math.sin(cam.yaw)
      const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch)
      const rx = x * ca - z * sa, rz = x * sa + z * ca
      const ry = y * cp - rz * sp, dz = y * sp + rz * cp
      const s = cam.focal / (cam.focal + dz + cam.back)
      return { x: W * 0.5 + rx * s, y: H * 0.56 + ry * s, s, depth: dz }
    }

    // Inverse of the plane map at a fixed height — what dragging needs.
    // Solved iteratively because the perspective divide depends on the answer.
    const unproject = (sx, sy, y) => {
      const cam = camRef.current
      const ca = Math.cos(cam.yaw), sa = Math.sin(cam.yaw), sp = Math.sin(cam.pitch)
      let gx = 0, gz = 0
      for (let i = 0; i < 3; i++) {
        const p = project(gx, y, gz)
        const s = p.s
        const dx = sx - p.x, dy = sy - p.y
        const A = ca * s, B = -sa * s, C = -sa * sp * s, D = -ca * sp * s
        const det = A * D - B * C
        if (!det) break
        gx += (dx * D - B * dy) / det
        gz += (A * dy - dx * C) / det
      }
      return { x: gx, z: gz }
    }

    const resize = () => {
      const W = host.clientWidth, H = host.clientHeight
      if (!W || !H) return
      const DPR = Math.min(window.devicePixelRatio || 1, 2)
      // the world extent follows the panel, so the same graph fits any width
      const k = Math.max(0.3, Math.min(1.35, Math.min(W, H) / 560))
      if (Math.abs(k - viewRef.current.k) > 0.001) {
        const f = k / (viewRef.current.k || 1)
        stateRef.current.nodes.forEach(n => { n.x *= f; n.z *= f; n.trail = [] })
        viewRef.current.k = k
      }
      viewRef.current.W = W; viewRef.current.H = H
      canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      wake()
    }

    const step = () => {
      const { nodes, edges } = stateRef.current
      const n = nodes.length
      if (!n) return 0
      if (loopRef.current.settled && viewRef.current.held === null) return 0
      const k = viewRef.current.k || 1
      const held = viewRef.current.held
      const rest = Math.max(92, 210 - n * 6) * k
      const sep = 66 * k
      // A sparse graph has too few springs to pull itself together, so
      // repulsion wins and everything ends up against the boundary. Gravity
      // makes up the difference: the fewer edges per node, the harder it pulls.
      const density = edges.length / Math.max(1, n)
      const gravity = 0.003 + Math.max(0, 1.2 - density) * 0.011
      let energy = 0

      // Repulsion falls off with the square of distance, so a node two cells
      // away contributes almost nothing. Below the threshold the every-pair
      // loop is cheaper than building a grid; above it, bucketing turns an
      // O(n²) pass into something closer to linear.
      const CUT = rest * 2.2                 // beyond this the force is negligible
      const CUT2 = CUT * CUT

      const repel = (a, b) => {
        const dx = b.x - a.x, dz = b.z - a.z
        const d2 = dx * dx + dz * dz || 0.01
        if (d2 > CUT2) return
        const d = Math.sqrt(d2)
        const f = (rest * rest * 1.5) / d2 / d
        a.vx -= dx * f; a.vz -= dz * f; b.vx += dx * f; b.vz += dz * f
        if (d < sep) {
          const g = ((sep - d) / d) * 0.5
          a.vx -= dx * g; a.vz -= dz * g; b.vx += dx * g; b.vz += dz * g
        }
      }

      if (n < GRID_THRESHOLD) {
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) repel(nodes[i], nodes[j])
        }
      } else {
        // one bucket per CUT-sized cell; each node then only has to look at
        // its own cell and the four already-visited neighbours, which covers
        // every pair exactly once without a visited set
        const cells = new Map()
        const key = (cx, cz) => cx * 73856093 ^ cz * 19349663
        for (const p of nodes) {
          p.cx = Math.floor(p.x / CUT); p.cz = Math.floor(p.z / CUT)
          const k2 = key(p.cx, p.cz)
          const bucket = cells.get(k2)
          if (bucket) bucket.push(p); else cells.set(k2, [p])
        }
        const NEIGHBOURS = [[1, 0], [-1, 1], [0, 1], [1, 1]]
        for (const bucket of cells.values()) {
          for (let i = 0; i < bucket.length; i++) {
            const a = bucket[i]
            for (let j = i + 1; j < bucket.length; j++) repel(a, bucket[j])
            for (const [ox, oz] of NEIGHBOURS) {
              const other = cells.get(key(a.cx + ox, a.cz + oz))
              if (!other) continue
              for (const b of other) repel(a, b)
            }
          }
        }
      }
      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b]
        if (!a || !b) continue
        const dx = b.x - a.x, dz = b.z - a.z
        const d = Math.hypot(dx, dz) || 0.001
        const f = (d - rest) * 0.013
        a.vx += (dx / d) * f; a.vz += (dz / d) * f
        b.vx -= (dx / d) * f; b.vz -= (dz / d) * f
        // each edge also drags both ends inward a little, so the node with the
        // most connections ends up nearest the centre rather than by accident
        a.vx -= a.x * 0.0016; a.vz -= a.z * 0.0016
        b.vx -= b.x * 0.0016; b.vz -= b.z * 0.0016
      }

      const lim = 430 * k
      for (const p of nodes) {
        if (held === p.idx) { p.vx = 0; p.vz = 0; p.y = (p.h || 0) * k; continue }
        p.vx += -p.x * gravity; p.vz += -p.z * gravity
        p.vx *= 0.85; p.vz *= 0.85
        p.x += p.vx; p.z += p.vz
        p.x = Math.max(-lim, Math.min(lim, p.x))
        p.z = Math.max(-lim, Math.min(lim, p.z))
        p.y = (p.h || 0) * k
        energy += p.vx * p.vx + p.vz * p.vz
      }

      const cam = camRef.current
      const dy = cam.target - cam.yaw
      if (Math.abs(dy) > 0.0004) { cam.yaw += dy * 0.07; energy += 0.4 }

      return energy / n
    }

    const drawFloor = () => {
      const k = viewRef.current.k || 1
      const S = 430 * k, STEP = 86 * k
      ctx.save(); ctx.lineWidth = 1.4
      for (let i = -S; i <= S + 0.001; i += STEP) {
        for (const seg of [[[i, -S], [i, S]], [[-S, i], [S, i]]]) {
          const A = project(seg[0][0], 0, seg[0][1])
          const B = project(seg[1][0], 0, seg[1][1])
          const g = ctx.createLinearGradient(A.x, A.y, B.x, B.y)
          g.addColorStop(0, 'rgba(0,0,0,0)')
          g.addColorStop(0.5, 'rgba(199,181,147,0.85)')
          g.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.strokeStyle = g
          ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke()
        }
      }
      ctx.restore()
    }

    const draw = () => {
      const { nodes, edges, adj } = stateRef.current
      const { W, H, hover, selected } = viewRef.current
      const k = viewRef.current.k || 1
      ctx.clearRect(0, 0, W, H)

      // project once per frame; everything below reads from this
      const proj = projRef.current
      proj.clear()
      for (const p of nodes) {
        const q = project(p.x + (p.drift || 0), p.y, p.z)
        const g = project(p.x, 0, p.z)         // where it meets the plane
        // MIN_NODE_PX is the floor: a distant node in a crowded field still
        // has to be findable and clickable, so perspective may shrink it only
        // so far. Without this, the back of the field turns into specks.
        const swell = 1 + (p.pop || 0) * 0.28
        const rr = Math.max(MIN_NODE_PX, p.r * q.s * 1.9) * swell
        proj.set(p.idx, { ...q, gx: g.x, gy: g.y, r: rr })
      }

      const focus = selected >= 0 ? selected : hover
      const near = focus >= 0 ? new Set([focus, ...(adj.get(focus) || [])]) : null
      const dim = (i) => (near && !near.has(i) ? 0.22 : 1)

      drawFloor()

      // shadow and drop line — this is what makes height legible
      for (const p of nodes) {
        const q = proj.get(p.idx); if (!q) continue
        ctx.save()
        // higher node, smaller and fainter shadow — the cue that reads as height
        const lift = Math.min(1, Math.abs(p.y) / 90)
        ctx.globalAlpha = (0.20 - lift * 0.09) * dim(p.idx)
        ctx.fillStyle = p.type === 'Contradiction' ? '#f01f0a' : '#191715'
        ctx.beginPath()
        ctx.ellipse(q.gx, q.gy, q.r * (1.25 - lift * 0.3), q.r * (0.42 - lift * 0.1), 0, 0, 7)
        ctx.fill()
        ctx.globalAlpha = 0.14 * dim(p.idx)
        ctx.strokeStyle = '#8d8471'; ctx.lineWidth = 1; ctx.setLineDash([3, 4])
        ctx.beginPath(); ctx.moveTo(q.x, q.y + q.r * 0.4); ctx.lineTo(q.gx, q.gy); ctx.stroke()
        ctx.restore()
      }

      // a short trail behind anything still moving
      for (const p of nodes) {
        if (!p.trail || p.trail.length < 3) continue
        ctx.save()
        ctx.globalAlpha = 0.26 * dim(p.idx)
        ctx.strokeStyle = '#8d8471'; ctx.lineWidth = 1.6
        ctx.beginPath()
        p.trail.forEach((t, i) => (i ? ctx.lineTo(t.x, t.y) : ctx.moveTo(t.x, t.y)))
        ctx.stroke(); ctx.restore()
      }

      for (const e of edges) {
        const A = proj.get(e.a), B = proj.get(e.b)
        if (!A || !B) continue
        ctx.save()
        ctx.globalAlpha = Math.min(dim(e.a), dim(e.b))
        if (e.conflict) {
          ctx.strokeStyle = '#f01f0a'; ctx.lineWidth = 3.4; ctx.setLineDash([8, 6])
        } else {
          ctx.strokeStyle = '#b09a70'; ctx.lineWidth = 2.8
        }
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke()
        ctx.restore()
      }

      // far to near, so nearer nodes occlude
      const order = nodes.slice().sort(
        (a, b) => proj.get(b.idx).depth - proj.get(a.idx).depth
      )

      for (const p of order) {
        const q = proj.get(p.idx)
        const c = NODE[p.type] || FALLBACK
        ctx.save()
        ctx.globalAlpha = dim(p.idx) * (0.5 + (p.pop || 0) * 0.35)
        ctx.fillStyle = c.ring
        ctx.beginPath()
        ctx.arc(q.x, q.y, q.r + (7 + (p.pop || 0) * 8) * q.s, 0, 7)
        ctx.fill()

        ctx.globalAlpha = dim(p.idx)
        ctx.fillStyle = c.fill
        ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 7); ctx.fill()

        if (p.type === 'Entity' || p.type === 'Source') {
          ctx.strokeStyle = c.ring === '#d5c5a4' ? '#8d8471' : c.ring
          ctx.lineWidth = Math.max(1, 4 * q.s)
          ctx.beginPath(); ctx.arc(q.x, q.y, Math.max(1, q.r - 2 * q.s), 0, 7); ctx.stroke()
        }

        // corner brackets rather than a ring, so the focus mark reads at any depth
        if (focus === p.idx) {
          ctx.strokeStyle = p.type === 'Contradiction' ? '#a81400' : '#191715'
          ctx.lineWidth = 1.5
          const m = q.r + 9
          for (const [sx, sy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) {
            ctx.beginPath()
            ctx.moveTo(q.x + sx * m, q.y + sy * m - sy * 6)
            ctx.lineTo(q.x + sx * m, q.y + sy * m)
            ctx.lineTo(q.x + sx * m - sx * 6, q.y + sy * m)
            ctx.stroke()
          }
        }
        ctx.restore()
      }

      // labels last, seeded with the node discs so text never lands on one
      ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace'
      ctx.textBaseline = 'middle'
      const taken = order.map(p => {
        const q = proj.get(p.idx)
        return { x: q.x - q.r - 2, y: q.y - q.r - 2, w: q.r * 2 + 4, h: q.r * 2 + 4 }
      })
      const hits = (b) => taken.some(t =>
        b.x < t.x + t.w && b.x + b.w > t.x && b.y < t.y + t.h && b.y + b.h > t.y)

      const showAll = nodes.length <= LABEL_LIMIT
      const labelOrder = focus >= 0
        ? [nodes[focus], ...order.filter(p => p.idx !== focus)].filter(Boolean)
        : order

      for (const p of labelOrder) {
        const isFocus = focus === p.idx
        if (!showAll && !isFocus && !ALWAYS_LABEL.has(p.type)) continue
        if (dim(p.idx) < 1 && !isFocus) continue

        const q = proj.get(p.idx)
        const w = ctx.measureText(p.label).width
        const gap = q.r + 8
        const spots = [
          [q.x + gap, q.y], [q.x - gap - w, q.y],
          [q.x - w / 2, q.y - gap - 5], [q.x - w / 2, q.y + gap + 5],
        ]
        for (const [x, y] of spots) {
          if (x < 4 || x + w > W - 4 || y < 9 || y > H - 9) continue
          const box = { x: x - 3, y: y - 7, w: w + 6, h: 14 }
          if (hits(box) && !isFocus) continue
          taken.push(box)
          ctx.save()
          ctx.globalAlpha = dim(p.idx)
          ctx.fillStyle = '#f4ecdc'
          ctx.fillRect(box.x, box.y, box.w, box.h)
          ctx.fillStyle = (NODE[p.type] || FALLBACK).label
          ctx.fillText(p.label, x, y)
          ctx.restore()
          break
        }
      }
    }

    // Physics parks; this does not. The forces are the expensive part — an
    // O(n²) pass every frame — and once the layout settles there is nothing
    // left for them to do. Drift and hover swell are a few multiplications
    // per node, so the field keeps breathing without recomputing anything.
    const breathe = (t) => {
      const k = viewRef.current.k || 1
      const hover = viewRef.current.hover
      const held = viewRef.current.held
      for (const p of stateRef.current.nodes) {
        const base = (p.h || 0) * k
        if (held === p.idx) { p.y = base; p.pop = 1; continue }
        // a slow rise and fall, plus the faintest lateral sway
        p.y = base + Math.sin(t * p.rate + p.phase) * 3.4 * k
        p.drift = Math.cos(t * p.rate * 0.6 + p.phase) * 1.6 * k * p.sway
        // hovering swells a node toward the pointer rather than snapping
        const want = hover === p.idx ? 1 : 0
        p.pop += (want - p.pop) * 0.18
        if (Math.abs(p.pop - want) < 0.004) p.pop = want
      }
    }

    const frame = (ts) => {
      const l = loopRef.current
      // Scheduled first, and deliberately. If anything below throws, the loop
      // still continues — otherwise a single bad frame stops the canvas for
      // good, and wake() will not restart it because `running` is still true.
      l.raf = requestAnimationFrame(frame)

      // A settled field only needs to breathe. Dropping it to ~20fps costs
      // nothing visually and takes two thirds of the work off the machine,
      // which matters for a panel that is often not the thing being looked at.
      if (l.settled && !document.hidden) {
        if (ts - (l.last || 0) < 48) return
        l.last = ts
      } else if (document.hidden) {
        return                                  // background tab: draw nothing
      }

      const energy = step()
      if (!reduced) breathe(performance.now() / 1000)

      // record where each node has been, for the motion trail — only while
      // something is actually moving
      if (!l.settled) {
        const proj = projRef.current
        for (const p of stateRef.current.nodes) {
          const q = proj.get(p.idx)
          if (q) { p.trail.push({ x: q.x, y: q.y }); if (p.trail.length > 10) p.trail.shift() }
        }
      }
      draw()

      l.still = energy < SLEEP_ENERGY ? Math.min(l.still + 1, SLEEP_FRAMES) : 0
      if (l.still >= SLEEP_FRAMES && !l.settled) {
        l.settled = true
        // once, on the transition — not every frame for the rest of the session
        stateRef.current.nodes.forEach(p => { p.trail.length = 0 })
        // under reduced motion this really does stop; otherwise it keeps
        // drawing so the field stays alive, but does no physics
        if (reduced) { cancelAnimationFrame(l.raf); l.running = false; draw() }
      }
    }

    const wake = () => {
      const l = loopRef.current
      l.still = 0
      l.settled = false
      if (l.running) return
      l.running = true
      l.raf = requestAnimationFrame(frame)
    }
    wakeRef.current = wake

    const at = (evt) => {
      const r = canvas.getBoundingClientRect()
      return { x: evt.clientX - r.left, y: evt.clientY - r.top }
    }
    const isTouch = (evt) => evt.pointerType === 'touch' || evt.pointerType === 'pen'
    const pick = (evt) => {
      const { x, y } = at(evt)
      let best = -1, bd = Infinity
      for (const [idx, q] of projRef.current) {
        const d = (q.x - x) ** 2 + (q.y - y) ** 2
        const rr = (q.r + 12) ** 2
        if (d < rr && d < bd) { bd = d; best = idx }
      }
      return best
    }

    const onMove = (e) => {
      const v = viewRef.current
      const { x, y } = at(e)

      // a finger that has not landed on a node should scroll the page, so the
      // canvas only claims the gesture once something is actually being dragged
      if (isTouch(e) && v.held === null) return

      if (v.held !== null) {
        // a few pixels of travel is a shaky finger, not a drag
        if (v.downAt) {
          const dx = x - v.downAt.x, dy = y - v.downAt.y
          if (dx * dx + dy * dy > 16) v.moved = true
        }
        const node = stateRef.current.nodes.find(p => p.idx === v.held)
        if (node) {
          // the node's own height, not its drifting one — otherwise the plane
          // being unprojected onto shifts every frame and the node lags
          const base = (node.h || 0) * (v.k || 1)
          const g = unproject(x, y, base)
          node.x = g.x; node.z = g.z; node.vx = 0; node.vz = 0
        }
        wake()
        return
      }

      // the pointer's horizontal position orbits the camera
      const cam = camRef.current
      const nextTarget = ((x / Math.max(1, v.W)) - 0.5) * 0.9
      if (Math.abs(nextTarget - cam.target) > 0.001) { cam.target = nextTarget; wake() }

      const hit = pick(e)
      if (hit !== v.hover) {
        v.hover = hit
        canvas.style.cursor = hit >= 0 ? 'grab' : 'default'
        if (!loopRef.current.running) draw()
      }
    }

    const onLeave = () => {
      const v = viewRef.current
      if (v.held !== null) return
      v.hover = -1
      camRef.current.target = 0
      canvas.style.cursor = 'default'
      wake()
    }

    const onDown = (e) => {
      const hit = pick(e)
      if (hit < 0) return
      const v = viewRef.current
      v.held = hit
      v.hover = hit               // touch has no hover, so landing on one counts
      // Selection is NOT set here. Pressing a node to drag it would otherwise
      // also isolate it, dimming the rest of the field mid-drag. Whether this
      // gesture was a click or a drag is only known on release.
      v.downAt = at(e)
      v.moved = false
      canvas.style.cursor = 'grabbing'
      // hold the gesture even if the finger leaves the canvas
      try { canvas.setPointerCapture(e.pointerId) } catch { /* not captured, fine */ }
      wake()
      e.preventDefault()
    }

    // released on window, so letting go outside the canvas still lands
    const onUp = (e) => {
      const v = viewRef.current
      if (v.held === null) return
      const wasHeld = v.held
      const dragged = v.moved
      v.held = null
      v.downAt = null
      v.moved = false
      // a press that did not travel is a click: toggle isolation on that node.
      // a press that travelled was a drag, and leaves the selection alone.
      if (!dragged) v.selected = wasHeld === v.selected ? -1 : wasHeld
      if (e && isTouch(e)) v.hover = -1     // no lingering highlight after a tap
      canvas.style.cursor = 'default'
      wake()
    }

    // clicking empty space clears the isolation
    const onClick = (e) => {
      if (pick(e) >= 0) return              // handled on release
      viewRef.current.selected = -1
      if (!loopRef.current.running) draw()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()
    // pointer events cover mouse, touch and pen with one path
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('pointercancel', onUp)
    window.addEventListener('pointerup', onUp)
    // the browser must not steal a drag as a scroll or a pinch
    canvas.style.touchAction = 'none'

    return () => {
      cancelAnimationFrame(loopRef.current.raf)
      loopRef.current.running = false
      ro.disconnect()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('pointercancel', onUp)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  const legend = [
    ['Episode', TYPE_NAME.Episode], ['Entity', TYPE_NAME.Entity],
    ['Contradiction', TYPE_NAME.Contradiction],
    ['Concept', TYPE_NAME.Concept], ['Source', TYPE_NAME.Source],
  ]

  return (
    <section style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
      background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 22px 16px 34px', flex: 'none' }} className="eg-gtop">
        <span className="eg-panel-title">What it remembers</span>
        <span className="eg-mono" style={{ fontSize: 11.5, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'var(--n600)' }}>
          {counts.nodes} things · {counts.edges} links
        </span>
      </div>

      <div className="eg-gcanvas" style={{ flex: 1, minHeight: 0, padding: '0 22px 0 34px' }}>
        <div ref={hostRef} style={{ position: 'relative', width: '100%', height: '100%',
          overflow: 'hidden' }}>
          <Brackets />
          <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, display: 'block' }} />
          {counts.nodes > 0 && (
            <span className="eg-graph-hint">
              {coarse ? 'drag a node to pull it' : 'move to orbit · drag a node to pull it'}
            </span>
          )}
        </div>
      </div>

      <div className="eg-glegend"
        style={{ padding: '16px 22px 18px 34px', flex: 'none', display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', alignItems: 'baseline' }}>
          <span className="eg-label" style={{ color: 'var(--ink)' }}>How to read</span>
          <span style={{ fontFamily: 'var(--sans)', fontSize: 11.5, fontWeight: 600,
            letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--n600)' }}>
            Bigger = more certain · red = a conflict, and it floats above the rest
          </span>
          <button className="eg-link" style={{ marginLeft: 'auto' }}
            onClick={() => setShowEpisodes(v => !v)} aria-pressed={showEpisodes}>
            {showEpisodes ? 'Hide what you said' : 'Show what you said'}
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
        <span className="eg-label">From memory</span>
        <span className="eg-seg" aria-hidden="true">
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <i key={i} style={i < filled ? { background: tone } : undefined} />
          ))}
        </span>
        <span className="eg-mono" style={{ fontSize: 12.5, color: 'var(--n700)' }}>{summary}</span>
        {total > 0 && (
          <button className="eg-link" style={{ marginLeft: 'auto' }}
            onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide the working' : 'Show the working'}
          </button>
        )}
      </div>

      {open && total > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="eg-label" style={{ marginBottom: 6 }}>What it checked</div>
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
              <div className="eg-label" style={{ marginBottom: 6 }}>What it used</div>
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
              Nothing stored matched this
            </div>
          )}

          {contradictions?.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid var(--accent)` }}>
              <div className="eg-label" style={{ color: 'var(--accent-700)', marginBottom: 6 }}>
                Both versions kept
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
        padding: '16px 30px', flex: 'none', borderBottom: '1px solid var(--n300)' }}
        className="eg-ttop">
        <span className="eg-panel-title">Conversation</span>
        <span className="eg-mono" style={{ fontSize: 11.5, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'var(--n600)' }}>
          {turns} {turns === 1 ? 'message' : 'messages'}
          {meanScore != null && ` · ${(meanScore * 100).toFixed(0)}% from memory on average`}
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

      <div className="eg-inputrow"
        style={{ flex: 'none', display: 'flex', gap: 12, padding: '18px 30px',
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
          <div className="eg-label" style={{ marginBottom: 10 }}>Nothing here yet</div>
          <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: 'var(--ink-dim)' }}>
            Every answer records what it did to produce it — what it looked up,
            what it checked, how long each part took. Send a message to see one.
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
              <span style={{ width: 90 }}>{t.agent_count} steps</span>
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
      <div className="eg-label" style={{ marginBottom: 8 }}>Add a document</div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
        <input
          className="eg-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ingestUrl()}
          placeholder="Paste a link to a page"
          disabled={!!busy}
        />
        <button className="eg-send" style={{ padding: '0 30px', flex: 'none' }}
          onClick={ingestUrl} disabled={!!busy}>
          {busy === 'url' ? 'Reading' : 'Add'}
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
          {docs.length} {docs.length === 1 ? 'document' : 'documents'} · {totalChunks} pieces stored
          {totalPages > 0 && ` · ${totalPages} pages`}
        </span>
      </div>

      {loading && <div className="eg-label">Loading</div>}

      {!loading && docs.length === 0 && (
        <p style={{ margin: 0, maxWidth: 460, fontSize: 16, lineHeight: 1.6,
          color: 'var(--ink-dim)' }}>
          Nothing added yet. Paste a link or upload a PDF and it can answer
          from that too, alongside everything you have told it.
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
                ['Pieces stored', 'right'], ['Added', 'left'], ['', 'right'],
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
  const [messages, setMessages] = useState(() => loadTranscript(email))
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [graphRefresh, setGraphRefresh] = useState(0)
  const sessionId = useMemo(
    () => '0x' + Math.random().toString(16).slice(2, 6).toUpperCase(), []
  )

  // Written once a reply finishes, never mid-stream. Saving on every messages
  // change would serialise the whole transcript on every streamed token, which
  // blocks the main thread and makes the reply appear to stall.
  const streaming = messages.some(m => m.streaming)
  useEffect(() => {
    if (streaming) return
    saveTranscript(email, messages)
  }, [email, streaming, messages.length])
  const narrow = useNarrow()
  const [menuOpen, setMenuOpen] = useState(false)
  const [pane, setPane] = useState('transcript')   // which pane shows on a phone

  // a new reply is worth seeing, so a phone returns to the transcript
  useEffect(() => { if (narrow) setPane('transcript') }, [narrow])
  // the drawer must not survive a return to desktop
  useEffect(() => { if (!narrow) setMenuOpen(false) }, [narrow])

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

  const resetSession = () => {
    setMessages([])
    saveTranscript(email, [])
    setGraphRefresh(p => p + 1)
  }

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
    <div className="eg-shell">
      {/* the rail is a column on desktop and a drawer on a phone — same markup */}
      {narrow && menuOpen && (
        <div className="eg-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />
      )}

      <nav className="eg-rail" data-open={narrow && menuOpen}>
        <div className="eg-rail-brand">
          <Wordmark width={148} />
          <span className="eg-kicker">Memory layer</span>
        </div>

        <div style={{ padding: '8px 0' }}>
          {NAV.map(n => (
            <button key={n.id} className="eg-nav" data-active={view === n.id}
              onClick={() => { setView(n.id); setMenuOpen(false) }}>
              <span>{n.label}</span>
              {badges[n.id] != null && <span className="badge">{badges[n.id]}</span>}
            </button>
          ))}
        </div>

        <div className="eg-rail-foot">
          <span className="eg-label">Signed in</span>
          <span style={{ fontSize: 13.5, lineHeight: 1.35, wordBreak: 'break-all' }}>{email}</span>
          <button className="eg-link" style={{ justifySelf: 'start' }} onClick={onLogout}>
            Log out
          </button>
          {narrow && (
            <button className="eg-ghost" style={{ justifySelf: 'start', marginTop: 4 }}
              onClick={() => { resetSession(); setMenuOpen(false) }}>
              Reset session
            </button>
          )}
        </div>
      </nav>

      <div className="eg-main">
        <header className="eg-topbar">
          {narrow && (
            <button className="eg-burger" onClick={() => setMenuOpen(true)} aria-label="Menu">
              <i /><i /><i />
            </button>
          )}
          <span className="eg-topbar-title">{heading[0]}</span>
          {!narrow && <span className="eg-topbar-desc">{heading[1]}</span>}

          <div className="eg-topbar-right">
            {!narrow && (
              <span className="eg-mono" style={{ fontSize: 12, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'var(--n600)' }}>
                session {sessionId}
              </span>
            )}
            <span className="eg-live"><span className="dot" />live</span>
            {!narrow && (
              <button className="eg-ghost" style={{ textTransform: 'none', fontSize: 13,
                letterSpacing: 0, padding: '7px 14px' }}
                onClick={resetSession}>Reset session</button>
            )}
          </div>
        </header>

        {/* on a phone the two panes become tabs; there is no room to show both */}
        {narrow && view === 'chat' && (
          <div className="eg-tabs">
            <button className="eg-tab" data-active={pane === 'transcript'}
              onClick={() => setPane('transcript')}>
              Transcript{turns > 0 && <span className="n">{turns}</span>}
            </button>
            <button className="eg-tab" data-active={pane === 'graph'}
              onClick={() => setPane('graph')}>
              Graph
            </button>
          </div>
        )}

        {view === 'chat' ? (
          <div className="eg-panes" data-pane={narrow ? pane : 'both'}>
            {(!narrow || pane === 'graph') && (
              <MemoryGraphPanel refreshTrigger={graphRefresh} />
            )}
            {!narrow && <span className="eg-divider" />}
            {(!narrow || pane === 'transcript') && (
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
            )}
          </div>
        ) : (
          <div className="eg-screen">
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
    try { sessionStorage.removeItem(TRANSCRIPT_KEY(email)) } catch { /* nothing to clear */ }
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