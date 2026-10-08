import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Electron loads the production renderer through file://, where /assets points
  // to the drive root rather than this application's dist folder.
  base: './',
  plugins: [react()],
  test: { include: ['electron/**/*.test.ts', 'src/**/*.test.ts'] }
});
