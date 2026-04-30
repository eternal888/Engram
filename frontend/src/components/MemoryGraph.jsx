import { useEffect, useState, useRef } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import axios from 'axios'

const API_URL = 'http://localhost:8000/api'

const COLORS = {
  Episode: '#3b82f6',      // blue
  Concept: '#10b981',      // green
  Entity: '#f59e0b',       // orange
  Source: '#8b5cf6',       // purple
  Contradiction: '#ef4444' // red
}

export default function MemoryGraph({ refreshTrigger }) {
  const [graphData, setGraphData] = useState({ nodes: [], links: [] })
  const fgRef = useRef()

  const loadGraph = async () => {
    try {
      const res = await axios.get(`${API_URL}/memory/graph`)
      const nodes = res.data.nodes.map(n => ({
        id: n.id,
        label: n.label?.substring(0, 30) || n.type,
        type: n.type,
        confidence: n.confidence,
        tier: n.tier,
        color: COLORS[n.type] || '#6b7280'
      }))
      const links = res.data.edges.map(e => ({
        source: e.source,
        target: e.target,
        relationship: e.relationship
      }))
      setGraphData({ nodes, links })
    } catch (err) {
      console.error('Failed to load graph:', err)
    }
  }

  useEffect(() => {
    loadGraph()
  }, [refreshTrigger])

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      <div className="p-4 border-b border-gray-800 flex justify-between items-center">
        <div>
          <h3 className="font-semibold">Memory Graph</h3>
          <p className="text-xs text-gray-400">{graphData.nodes.length} nodes, {graphData.links.length} edges</p>
        </div>
        <div className="flex gap-3 text-xs">
          {Object.entries(COLORS).map(([type, color]) => (
            <div key={type} className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-full" style={{ background: color }}></div>
              <span className="text-gray-400">{type}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ height: '500px' }}>
        <ForceGraph2D
          ref={fgRef}
          graphData={graphData}
          nodeLabel="label"
          nodeColor={n => n.color}
          nodeRelSize={6}
          linkColor={() => '#374151'}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          backgroundColor="#0f0f0f"
        />
      </div>
    </div>
  )
}