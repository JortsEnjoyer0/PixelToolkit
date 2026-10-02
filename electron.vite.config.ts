import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

const sharedAlias = { '@shared': resolve('src/shared') };

export default defineConfig(({ command }) => {
  // The dev-only rig testbed page (npm run dev:testbed) is served in dev, and built only on request
  // (PT_TESTBED=1, e.g. for `electron-vite preview -- --testbed`): production bundles ship index.html alone.
  const withTestbed = command === 'serve' || process.env['PT_TESTBED'] === '1';
  return {
    main: {
      resolve: { alias: sharedAlias }
    },
    preload: {
      resolve: { alias: sharedAlias },
      // sandbox: true => the preload may only require('electron'), so bundle every npm dep into it
      build: { externalizeDeps: false }
    },
    renderer: {
      resolve: {
        alias: { ...sharedAlias, '@renderer': resolve('src/renderer/src') }
      },
      plugins: [vue()],
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/renderer/index.html'),
            ...(withTestbed ? { testbed: resolve('src/renderer/testbed.html') } : {})
          }
        }
      }
    }
  };
});
