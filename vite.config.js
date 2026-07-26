import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  // Extra hostnames allowed to reach the dev server, e.g. a Tailscale Serve
  // HTTPS hostname ("home-server.tailXXXX.ts.net"). Comma-separated. IPs and
  // localhost are always allowed by Vite; this only adds DNS names.
  const allowedHosts = (env.VITE_ALLOWED_HOSTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      allowedHosts,
      port: parseInt(env.VITE_PORT) || 5173,
      // Build outputs are not sources. Watching them burns inotify handles —
      // native/*/target alone holds well over a thousand files — and an
      // exhausted watch table makes the dev server fail to start with ENOSPC.
      watch: {
        ignored: [
          '**/native/**/target/**',
          '**/dist/**',
          '**/dist-server/**',
          '**/dist-native/**',
          '**/artifacts/**',
        ],
      },
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-markdown': [
              'react-markdown',
              'remark-gfm',
              'remark-math',
              'rehype-raw',
              'rehype-katex',
              'katex'
            ],
            'vendor-syntax': ['react-syntax-highlighter'],
            'vendor-icons': ['lucide-react'],
            'vendor-i18n': ['i18next', 'i18next-browser-languagedetector', 'react-i18next'],
            'vendor-tools': ['cmdk', 'fuse.js', 'jszip', 'react-dropzone'],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    }
  }
})
