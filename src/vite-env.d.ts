/// <reference types="vite/client" />
import type { RozhApi } from '../electron/types';

declare global {
  interface Window {
    rozh: RozhApi;
  }
}

export {};
