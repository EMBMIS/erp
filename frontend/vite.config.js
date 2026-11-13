import process from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Which node_modules package does this module id belong to?
 *
 * Matching on the package boundary rather than with `id.includes('react')`,
 * which was the previous approach and swept up every path containing that
 * substring — react-markdown, react-hot-toast, react-barcode and their whole
 * dependency trees all landed in `vendor-react`, taking it past 500 kB.
 *
 * `id.includes('d3')` was worse. It matched any path with "d3" anywhere in it,
 * so unrelated modules were pulled into `vendor-charts`; because the entry
 * needed one of them, the whole 350 kB charting chunk became part of the
 * entry's static graph and was preloaded before the login screen — for an
 * application where seven pages use a chart.
 */
function packageOf(id) {
  const match = id.replace(/\\/g, '/').match(/node_modules\/(?:(@[^/]+)\/)?([^/]+)/)
  if (!match) return null
  return match[1] ? `${match[1]}/${match[2]}` : match[2]
}

const REACT_CORE = new Set(['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler'])
const CHART_PREFIXES = ['d3-', 'victory-', 'recharts']
const MARKDOWN_PREFIXES = ['micromark', 'mdast-', 'remark-', 'unist-', 'hast-', 'unified', 'vfile']

// The path the built app is served under: '/' at the root of its host (the
// default), or e.g. '/erp/' under a path of a shared host, where the reverse
// proxy strips the prefix before forwarding. Asset URLs and the router's
// basename (App.jsx, from import.meta.env.BASE_URL) follow it. `npm run dev`
// always serves at '/'.
const BUILD_BASE = `/${(process.env.VITE_BASE_PATH || '/').replace(/^\/+|\/+$/g, '')}/`.replace(/\/+/g, '/')

export default defineConfig(({ command }) => ({
  base: command === 'build' ? BUILD_BASE : '/',
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const pkg = packageOf(id)
          if (!pkg) return undefined

          // The framework: needed on first paint, and worth caching separately
          // from application code so an ordinary deploy does not invalidate it.
          if (REACT_CORE.has(pkg)) return 'vendor-react'

          // clsx is tiny and used by the shell AND by recharts. Left alone,
          // Rollup files it inside vendor-charts, and the shell then drags the
          // whole charting library onto the critical path to get 300 bytes.
          if (pkg === 'clsx') return 'vendor-react'

          // Charting is large and used by a handful of finance and AI screens.
          // Its own chunk, so those screens pay for it and nobody else does.
          if (pkg === 'd3' || CHART_PREFIXES.some((p) => pkg.startsWith(p))) return 'vendor-charts'

          // Markdown rendering: only the AI chat surfaces need it.
          if (pkg === 'react-markdown' || MARKDOWN_PREFIXES.some((p) => pkg.startsWith(p))) {
            return 'vendor-markdown'
          }

          if (pkg === '@heroicons/react' || pkg === 'lucide-react') return 'vendor-icons'

          // Everything else: no manual grouping. Returning a catch-all 'vendor'
          // name here looks tidier but is actively worse — a manual chunk is
          // all-or-nothing, so one eagerly-imported package (axios, say) drags
          // every other library in the group onto the critical path, including
          // ones only a single lazy page uses. Left alone, Rollup splits these
          // along the dynamic-import boundaries that already exist, and each
          // page pulls only what it actually needs.
          return undefined
        }
      }
    }
  }
}))
