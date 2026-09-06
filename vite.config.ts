import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import { localDbPlugin } from './server/localdb'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// https://vitejs.dev/config/
export default defineConfig({
  // localDbPlugin 提供 /api/db/*（数据落到 <repo>/data/，ACO_DATA_DIR 可覆盖目录），
  // 以及手机观众模式的 /api/live/* 与 /api/view/*（server/live.ts，由同一个插件挂载——
  // 拆成两个插件的话中间件顺序要额外操心，没有好处）。
  // dev 和 preview 都要挂，否则 preview 下前端会退回 IndexedDB。
  // 局域网/Tailscale 开关也在这个插件的 config() 钩子里：npm run dev:lan（= vite --mode lan）
  // 时才放开监听地址并接受带 token 的 lan 角色，默认 npm run dev 只听回环。
  plugins: [react(), localDbPlugin()],
  // 端口钉死：IndexedDB 按 origin（地址+端口）隔离，端口漂移等于换了个空仓库。
  // strictPort 让端口被占时直接报错，而不是静默 +1 把数据"弄丢"。
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist']
  }
})