import { useState } from 'react'
import axios from 'axios'
import MemoryGraph from './components/MemoryGraph'

const API_URL = 'http://localhost:8000/api'

function App() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [graphRefresh, setGraphRefresh] = useState(0)

  const sendMessage = async () => {
    if (!input.trim() || loading) return

    const userMessage = input
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setLoading(true)

    try {
      const res = await axios.post(`${API_URL}/chat`, {
        message: userMessage,
        user_id: 'default'
      })

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: res.data.response,
        memories: res.data.memories_used,
        contradictions: res.data.contradictions
      }])

      // Refresh graph after each message
      setGraphRefresh(prev => prev + 1)
    } catch (err) {
      console.error(err)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Error connecting to backend.'
      }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-7xl mx-auto p-6">
        <header className="mb-6 border-b border-gray-800 pb-4">
          <h1 className="text-3xl font-bold">Engram</h1>
          <p className="text-gray-400 text-sm">Multi-Agent Memory Operating System</p>
        </header>

        <div className="grid grid-cols-2 gap-6">
          {/* Chat Panel */}
          <div className="space-y-4">
            <div className="space-y-3 mb-4 h-[500px] overflow-y-auto pr-2">
              {messages.length === 0 && (
                <div className="text-gray-500 text-center py-20">
                  Start a conversation. Engram will remember.
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-lg px-4 py-3 ${
                    msg.role === 'user' ? 'bg-blue-600' : 'bg-gray-800'
                  }`}>
                    <div className="whitespace-pre-wrap">{msg.content}</div>

                    {msg.memories && msg.memories.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-gray-700 text-xs">
                        <div className="text-gray-400 mb-1">Memories used:</div>
                        {msg.memories.map((m, j) => (
                          <div key={j} className="text-gray-300">
                            • [{m.type}] {m.text} <span className="text-gray-500">({(m.similarity * 100).toFixed(0)}%)</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {msg.contradictions && msg.contradictions.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-red-900 text-xs">
                        <div className="text-red-400 mb-1">⚠️ Contradictions detected:</div>
                        {msg.contradictions.map((c, j) => (
                          <div key={j} className="text-gray-300">
                            • {c.existing_fact} → superseded by → {c.new_fact}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {loading && (
                <div className="flex justify-start">
                  <div className="bg-gray-800 rounded-lg px-4 py-3 text-gray-400">
                    Thinking...
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Tell Engram something..."
                className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500"
                disabled={loading}
              />
              <button
                onClick={sendMessage}
                disabled={loading}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 px-6 py-3 rounded-lg font-medium"
              >
                Send
              </button>
            </div>
          </div>

          {/* Graph Panel */}
          <div>
            <MemoryGraph refreshTrigger={graphRefresh} />
          </div>
        </div>
      </div>
    </div>
  )
}

export default App