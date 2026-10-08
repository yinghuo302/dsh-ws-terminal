import { defineConfig } from 'tsdown'

const pluginId = '@local/dsh-ws-terminal'

export default defineConfig({
  entry: { client: 'src/client.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: false,
  clean: false,
  external: ['react', 'react/jsx-runtime'],
  noExternal: id => id !== 'react' && id !== 'react/jsx-runtime',
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
})
